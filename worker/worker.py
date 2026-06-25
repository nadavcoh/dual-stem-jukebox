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
     way a Track-A-vs-Track-B match is. Also detects the track's musical
     key (Krumhansl-Schmuckler, from the instrumental's chroma) and a
     per-stem loudness-normalization gain (RMS-based), both consumed by
     the player for pitch-matching and volume-matching between decks.
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
        # Allows yt-dlp to fetch its External JS (EJS) challenge-solver
        # scripts from https://github.com/yt-dlp/ejs (yt-dlp's own org) when
        # solving YouTube's signature challenges — disabled by default for
        # exactly the reason it sounds like: it's remote code execution,
        # even though it's narrowly scoped to an official source and run
        # under a JS runtime's sandbox (Deno, the default runtime, executes
        # it with no filesystem or network access).
        #
        # This is a SET, not a string — yt-dlp's Python API takes
        # remote_components as a collection (you can enable multiple, e.g.
        # {"ejs:github", "ejs:npm"}), matching --remote-components on the
        # CLI accepting repeated flags. A bare string here would get
        # iterated character-by-character instead.
        #
        # You'll also need a supported JS runtime installed (deno
        # recommended, enabled by default) for EJS to actually run —
        # remote_components only governs whether the *scripts* can be
        # fetched, not whether something can execute them.
        "remote_components": {"ejs:github"},
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
# Key detection (Krumhansl-Schmuckler) + loudness normalization
# ---------------------------------------------------------------------------
_PITCH_CLASS_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Kessler key profiles — the classic empirically-derived relative
# emphasis of each of the 12 pitch classes within a major/minor key, used to
# correlate against a track's averaged chroma vector for key-finding.
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Target RMS for loudness normalization. -20 dBFS is a conservative,
# commonly-used reference point for a normalized music stem — loud enough
# to not need much boost on quiet vocal-only stems, quiet enough to leave
# headroom rather than push anything toward clipping.
_TARGET_RMS_DB = -20.0
_GAIN_CLAMP = (0.3, 3.0)  # avoid extreme correction on near-silent stems


def detect_key(chroma_raw: np.ndarray) -> dict:
    """
    chroma_raw: (12, n_frames) — raw chroma_stft output, BEFORE beat-sync
    aggregation or any L2 normalization (those would distort the relative
    pitch-class energies this needs). Averages across time into one
    12-dim profile, then correlates it against all 24 rotations of the
    major/minor Krumhansl-Kessler templates and keeps the best match.
    """
    profile = chroma_raw.mean(axis=1)
    if not np.any(profile):
        return {"pitch_class": 0, "is_major": True, "name": "C major"}

    best_score = -2.0
    best_pitch_class = 0
    best_is_major = True
    for pitch_class in range(12):
        for is_major, template in ((True, _MAJOR_PROFILE), (False, _MINOR_PROFILE)):
            rotated = np.roll(template, pitch_class)
            score = np.corrcoef(profile, rotated)[0, 1]
            if score > best_score:
                best_score = score
                best_pitch_class = pitch_class
                best_is_major = is_major

    name = f"{_PITCH_CLASS_NAMES[best_pitch_class]} {'major' if best_is_major else 'minor'}"
    return {"pitch_class": best_pitch_class, "is_major": best_is_major, "name": name}


def compute_normalization_gain(y: np.ndarray, target_db: float = _TARGET_RMS_DB) -> float:
    """Linear gain multiplier to bring y's RMS loudness to target_db, clamped
    to _GAIN_CLAMP so a near-silent stem (e.g. a sparse vocal track) doesn't
    get boosted into amplifying noise."""
    rms = float(np.sqrt(np.mean(np.square(y)))) if len(y) else 0.0
    if rms <= 1e-9:
        return 1.0
    rms_db = 20 * np.log10(rms)
    gain = 10 ** ((target_db - rms_db) / 20)
    return float(np.clip(gain, *_GAIN_CLAMP))


# ---------------------------------------------------------------------------
# 3. Beat-synchronous Chroma + MFCC features
# ---------------------------------------------------------------------------
def extract_beat_features(audio_path: Path) -> dict:
    """
    Loads an audio file and returns a dict:
      beat_times : np.ndarray (n_beats,)   seconds
      features   : np.ndarray (n_beats, n_dims)  beat-synced chroma+mfcc, L2-normalized
      bpm        : float
      key        : {"pitch_class": int 0-11, "is_major": bool, "name": str}
      gain       : float — linear multiplier to normalize this stem's loudness
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

    key_info = detect_key(chroma)  # from the raw chroma, before normalization
    gain = compute_normalization_gain(y)

    chroma_sync = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
    mfcc_sync = librosa.util.sync(mfcc, beat_frames, aggregate=np.median)

    features = np.vstack([chroma_sync, mfcc_sync]).T  # (n_beats, 12 + 13)
    # L2-normalize each beat's feature vector so cosine distance behaves well
    norms = np.linalg.norm(features, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    features = features / norms

    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    return {
        "beat_times": beat_times,
        "features": features,
        "bpm": bpm,
        "key": key_info,
        "gain": gain,
    }


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
        vocal_data = extract_beat_features(vocals_mp3)
        inst_data = extract_beat_features(instrumental_mp3)
        vocal_beats, vocal_features = vocal_data["beat_times"], vocal_data["features"]
        inst_beats, inst_features = inst_data["beat_times"], inst_data["features"]
        # The instrumental stem almost always carries the clearer rhythmic
        # AND harmonic signal (drums/bass/chords survive separation better
        # than breath/sibilance artifacts in solo vocals), so it's the more
        # reliable BPM and key estimate.
        bpm = inst_data["bpm"]
        key_info = inst_data["key"]

        # 4. Beat-synchronous features for each stem — stored raw. The
        # similarity matrix that actually matters (Track A's instrumental
        # vs. Track B's instrumental) can only be built once you know which
        # two tracks you're mashing up, so that happens later, client-side
        # of a mashup request — see web/lib/crossTrackMatrix.js.
        matrix_payload = {
            "youtube_id": youtube_id,
            "bpm": bpm,
            "key": key_info,
            "vocals_gain": vocal_data["gain"],
            "instrumental_gain": inst_data["gain"],
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
                "key_pitch_class": key_info["pitch_class"],
                "key_is_major": key_info["is_major"],
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
