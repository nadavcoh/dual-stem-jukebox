"""
Dual-Stem Interactive Jukebox — Local Worker
=============================================

Polls Supabase for 'queued' tracks, claims one atomically via the
`claim_next_track` RPC, then:

  1. Downloads audio with yt-dlp.
  2. Separates vocals / instrumental with demucs (2-stem).
  3. Extracts beat-synchronous Chroma STFT + MFCC features per stem and
     stores them raw — these feed the *cross-track* (Track A <-> Track B)
     similarity matrix built later, once a mashup is actually requested
     (web/lib/crossTrackMatrix.js). There's no meaningful "jump point" to
     compute from a single track's own vocal vs. its own instrumental —
     they're different timbral content by construction (one's harmonic
     vocal formants, the other's everything-but-vocals), so a high
     cosine-similarity match between them isn't musically informative the
     way a Track-A-vs-Track-B match is.
  4. Uploads the mp3 stems + matrix.json to a private Backblaze B2 bucket
     and records their object keys (not public URLs).
  5. Marks the row 'completed' (or 'failed') in Supabase.

Run with:  python worker.py
Stop with: Ctrl+C
"""

import json
import os
import shutil
import subprocess
import sys
import time
import traceback
import uuid
from pathlib import Path

import boto3
import librosa
import numpy as np
from dotenv import load_dotenv
from supabase import Client, create_client
from yt_dlp.utils import GeoRestrictedError

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SUPABASE_URL = os.environ["SUPABASE_URL"]
# Supabase is deprecating the legacy JWT-based anon/service_role keys in
# favor of opaque publishable (sb_publishable_...) / secret (sb_secret_...)
# keys — same permissions, but rotatable and revocable without breaking
# every other client. The SDK accepts either format with zero code changes;
# this is purely an env var rename to the new key type.
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]

B2_RW_KEY_ID = os.environ["B2_RW_KEY_ID"]
B2_RW_APPLICATION_KEY = os.environ["B2_RW_APPLICATION_KEY"]
B2_BUCKET_NAME = os.environ["B2_BUCKET_NAME"]
B2_ENDPOINT_URL = os.environ["B2_ENDPOINT_URL"]
# B2's dashboard shows the bucket's "Endpoint" field as a bare hostname
# (e.g. "s3.eu-central-003.backblazeb2.com"), no scheme — boto3 needs a
# full URL or it raises further down the line. Tolerate both forms.
if not B2_ENDPOINT_URL.startswith(("http://", "https://")):
    B2_ENDPOINT_URL = f"https://{B2_ENDPOINT_URL}"
B2_REGION = os.environ.get("B2_REGION", "us-west-002")

WORKER_ID = os.environ.get("WORKER_ID", f"worker-{uuid.uuid4().hex[:8]}")
POLL_INTERVAL_SECONDS = float(os.environ.get("POLL_INTERVAL_SECONDS", "5"))
STALE_JOB_TIMEOUT_MINUTES = int(os.environ.get("STALE_JOB_TIMEOUT_MINUTES", "30"))
WORK_DIR = Path(os.environ.get("WORK_DIR", "./tmp")).resolve()
DEMUCS_MODEL = os.environ.get("DEMUCS_MODEL", "htdemucs")

SR = 22050  # analysis sample rate for librosa

# ---------------------------------------------------------------------------
# Clients
# ---------------------------------------------------------------------------
def get_supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def get_b2():
    return boto3.client(
        "s3",
        endpoint_url=B2_ENDPOINT_URL,
        aws_access_key_id=B2_RW_KEY_ID,
        aws_secret_access_key=B2_RW_APPLICATION_KEY,
        region_name=B2_REGION,
    )


# ---------------------------------------------------------------------------
# 1. Download
# ---------------------------------------------------------------------------
def download_audio(youtube_id: str, dest_dir: Path) -> tuple[Path, str]:
    """Download best audio for a YouTube id, return (wav_path, title)."""
    import yt_dlp

    dest_dir.mkdir(parents=True, exist_ok=True)
    out_template = str(dest_dir / "source.%(ext)s")

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "wav", "preferredquality": "0"}
        ],
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
    }

    url = f"https://www.youtube.com/watch?v={youtube_id}"
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    wav_path = dest_dir / "source.wav"
    if not wav_path.exists():
        raise RuntimeError(f"yt-dlp did not produce {wav_path}")

    title = info.get("title", youtube_id)
    return wav_path, title


# ---------------------------------------------------------------------------
# 2. Stem separation (demucs, 2-stem: vocals vs. everything else)
# ---------------------------------------------------------------------------
def separate_stems(input_wav: Path, dest_dir: Path) -> tuple[Path, Path]:
    """
    Runs demucs as a subprocess (more version-stable than importing its
    internals). --two-stems=vocals collapses drums/bass/other into a single
    "no_vocals" stem, giving us exactly the vocal / instrumental split we want.
    Returns (vocals_mp3_path, instrumental_mp3_path).
    """
    cmd = [
        sys.executable,
        "-m",
        "demucs",
        "-n", DEMUCS_MODEL,
        "--two-stems", "vocals",
        "--mp3",
        "--mp3-bitrate", "192",
        "-o", str(dest_dir),
        str(input_wav),
    ]
    subprocess.run(cmd, check=True)

    stem_dir = dest_dir / DEMUCS_MODEL / input_wav.stem
    vocals_path = stem_dir / "vocals.mp3"
    instrumental_path = stem_dir / "no_vocals.mp3"

    if not vocals_path.exists() or not instrumental_path.exists():
        raise RuntimeError(f"demucs did not produce expected stems in {stem_dir}")

    return vocals_path, instrumental_path


# ---------------------------------------------------------------------------
# 3. Beat-synchronous Chroma + MFCC features
# ---------------------------------------------------------------------------
def extract_beat_features(audio_path: Path):
    """
    Loads an audio file and returns:
      beat_times : np.ndarray (n_beats,)   seconds
      features   : np.ndarray (n_beats, n_dims)  beat-synced chroma+mfcc, L2-normalized
      bpm        : float
    """
    y, sr = librosa.load(str(audio_path), sr=SR, mono=True)

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    bpm = float(np.atleast_1d(tempo)[0])

    if len(beat_frames) < 4:
        # Fall back to a fixed grid (e.g. near-silent vocal stems can starve
        # onset detection) so downstream code never sees a degenerate matrix.
        beat_frames = librosa.util.frame(
            np.arange(0, len(y), int(sr * 0.5)), frame_length=1, hop_length=1
        ).flatten()

    chroma = librosa.feature.chroma_stft(y=y, sr=sr)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)

    chroma_sync = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
    mfcc_sync = librosa.util.sync(mfcc, beat_frames, aggregate=np.median)

    features = np.vstack([chroma_sync, mfcc_sync]).T  # (n_beats, 12 + 13)
    # L2-normalize each beat's feature vector so cosine distance behaves well
    norms = np.linalg.norm(features, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    features = features / norms

    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    return beat_times, features, bpm


# ---------------------------------------------------------------------------
# 6. Upload to Backblaze B2
# ---------------------------------------------------------------------------
def upload_file(b2, local_path: Path, key: str) -> str:
    """Uploads local_path to B2 under `key` and returns that same key.

    The bucket is private, so there's no public URL to hand back — callers
    store this key in Supabase, and the Next.js app exchanges it for a
    short-lived presigned URL at playback time (web/lib/b2Presign.js).
    """
    extra_args = {}
    if local_path.suffix == ".mp3":
        extra_args["ContentType"] = "audio/mpeg"
    elif local_path.suffix == ".json":
        extra_args["ContentType"] = "application/json"

    b2.upload_file(str(local_path), B2_BUCKET_NAME, key, ExtraArgs=extra_args)
    return key


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------

# yt-dlp's YouTube extractor doesn't raise a typed exception for rightsholder
# country blocks (the GeoRestrictedError class above is used by a handful of
# *other* extractors that have explicit allowed-country metadata) — for
# YouTube it's a generic ExtractorError/DownloadError with one of these
# phrases in the message. Match on text as a fallback for that case.
_GEO_BLOCK_PHRASES = (
    "blocked it in your country",
    "not available in your country",
    "blocked in your country",
    "not made this video available in your country",
)


def is_geo_blocked_error(exc: Exception) -> bool:
    if isinstance(exc, GeoRestrictedError):
        return True
    message = str(exc).lower()
    return any(phrase in message for phrase in _GEO_BLOCK_PHRASES)


# ---------------------------------------------------------------------------
# Job processing
# ---------------------------------------------------------------------------
def process_track(supabase: Client, b2, track: dict):
    track_id = track["id"]
    youtube_id = track["youtube_id"]
    job_dir = WORK_DIR / track_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        print(f"[{WORKER_ID}] Claimed {youtube_id} ({track_id})")

        # 1. Download
        source_wav, title = download_audio(youtube_id, job_dir)

        # 2. Separate stems
        vocals_mp3, instrumental_mp3 = separate_stems(source_wav, job_dir / "stems")

        # 3. Beat-synchronous features for each stem
        vocal_beats, vocal_features, vocal_bpm = extract_beat_features(vocals_mp3)
        inst_beats, inst_features, inst_bpm = extract_beat_features(instrumental_mp3)
        # The instrumental stem almost always carries the clearer rhythmic
        # signal (drums/bass survive separation better than breath/sibilance
        # artifacts in solo vocals), so it's the more reliable BPM estimate.
        bpm = inst_bpm

        # 4. Beat-synchronous features for each stem — stored raw. The
        # similarity matrix that actually matters (Track A's instrumental
        # vs. Track B's instrumental) can only be built once you know which
        # two tracks you're mashing up, so that happens later, client-side
        # of a mashup request — see web/lib/crossTrackMatrix.js.
        matrix_payload = {
            "youtube_id": youtube_id,
            "bpm": bpm,
            "vocal": {
                "beat_times": vocal_beats.tolist(),
                "features": vocal_features.tolist(),
            },
            "instrumental": {
                "beat_times": inst_beats.tolist(),
                "features": inst_features.tolist(),
            },
        }

        matrix_path = job_dir / "matrix.json"
        matrix_path.write_text(json.dumps(matrix_payload))

        # 5. Upload to B2 — keyed by youtube_id so storage stays organized
        # by song regardless of which Supabase row (re-)triggered the job.
        vocals_key = upload_file(b2, vocals_mp3, f"{youtube_id}/vocals.mp3")
        instrumental_key = upload_file(b2, instrumental_mp3, f"{youtube_id}/instrumental.mp3")
        matrix_json_key = upload_file(b2, matrix_path, f"{youtube_id}/matrix.json")

        # 6. Mark completed
        supabase.table("tracks").update(
            {
                "status": "completed",
                "title": title,
                "bpm": bpm,
                "vocals_key": vocals_key,
                "instrumental_key": instrumental_key,
                "matrix_json_key": matrix_json_key,
                "error_message": None,
            }
        ).eq("id", track_id).execute()

        print(f"[{WORKER_ID}] Completed {youtube_id}")

    except Exception as exc:  # noqa: BLE001
        if is_geo_blocked_error(exc):
            # Expected, not a bug — YouTube/the rightsholder blocked this
            # video for this worker's region. No traceback noise; one clean
            # line is all this needs.
            print(f"[{WORKER_ID}] GEO-BLOCKED {youtube_id} — unavailable in this worker's region, skipping.")
            error_message = f"geo_blocked: {exc}"[:2000]
        else:
            print(f"[{WORKER_ID}] FAILED {youtube_id}: {exc}")
            traceback.print_exc()
            error_message = str(exc)[:2000]

        supabase.table("tracks").update(
            {"status": "failed", "error_message": error_message}
        ).eq("id", track_id).execute()

    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    supabase = get_supabase()
    b2 = get_b2()
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[{WORKER_ID}] Starting. Polling every {POLL_INTERVAL_SECONDS}s...")
    last_requeue_check = 0.0

    while True:
        try:
            # Periodically recover jobs orphaned by a crashed worker.
            if time.time() - last_requeue_check > 300:
                requeued = supabase.rpc(
                    "requeue_stale_jobs", {"p_timeout_minutes": STALE_JOB_TIMEOUT_MINUTES}
                ).execute()
                if requeued.data:
                    print(f"[{WORKER_ID}] Requeued {requeued.data} stale job(s)")
                last_requeue_check = time.time()

            claimed = supabase.rpc("claim_next_track", {"p_worker_id": WORKER_ID}).execute()
            rows = claimed.data or []

            if not rows:
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            process_track(supabase, b2, rows[0])

        except KeyboardInterrupt:
            print(f"[{WORKER_ID}] Shutting down.")
            break
        except Exception as exc:  # noqa: BLE001
            print(f"[{WORKER_ID}] Loop error: {exc}")
            traceback.print_exc()
            time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
