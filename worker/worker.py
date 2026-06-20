"""
Dual-Stem Interactive Jukebox — Local Worker
=============================================

Polls Supabase for 'queued' tracks, claims one atomically via the
`claim_next_track` RPC, then:

  1. Downloads audio with yt-dlp.
  2. Separates vocals / instrumental with demucs (2-stem).
  3. Extracts beat-synchronous Chroma STFT + MFCC features per stem.
  4. Builds a vocal<->instrumental cross-similarity matrix (cosine distance).
  5. Filters that matrix for diagonally-coherent "jump points".
  6. Uploads the mp3 stems + matrix.json to Backblaze B2.
  7. Marks the row 'completed' (or 'failed') in Supabase.

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
from scipy.spatial.distance import cdist
from supabase import Client, create_client

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

B2_KEY_ID = os.environ["B2_KEY_ID"]
B2_APPLICATION_KEY = os.environ["B2_APPLICATION_KEY"]
B2_BUCKET_NAME = os.environ["B2_BUCKET_NAME"]
B2_ENDPOINT_URL = os.environ["B2_ENDPOINT_URL"]
B2_REGION = os.environ.get("B2_REGION", "us-west-002")
B2_PUBLIC_URL_BASE = os.environ.get(
    "B2_PUBLIC_URL_BASE", f"{B2_ENDPOINT_URL}/{B2_BUCKET_NAME}"
).rstrip("/")

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
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def get_b2():
    return boto3.client(
        "s3",
        endpoint_url=B2_ENDPOINT_URL,
        aws_access_key_id=B2_KEY_ID,
        aws_secret_access_key=B2_APPLICATION_KEY,
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
# 4. Cross-similarity matrix (cosine distance)
# ---------------------------------------------------------------------------
def compute_similarity_matrix(features_a: np.ndarray, features_b: np.ndarray) -> np.ndarray:
    """
    Cosine-distance cross-similarity between every beat of stem A and every
    beat of stem B. Returns a similarity matrix in [0, 1] (1.0 = identical
    direction in feature space), shape (n_beats_a, n_beats_b).

    This same function is reused, unmodified, at *mashup* time to build the
    Track-A <-> Track-B jump map the JukeboxPlayer actually plays from — see
    README "Cross-track mashup matrix" section.
    """
    distance = cdist(features_a, features_b, metric="cosine")
    similarity = 1.0 - distance
    return np.clip(similarity, 0.0, 1.0)


# ---------------------------------------------------------------------------
# 5. Filter for diagonal similarity sequences ("jump points")
# ---------------------------------------------------------------------------
def find_jump_points(
    similarity: np.ndarray,
    peak_threshold: float = 0.90,
    neighbor_threshold: float = 0.82,
    neighbor_radius: int = 2,
    min_neighbor_hits: int = 3,
    max_points: int = 200,
):
    """
    A single high-similarity cell (i, j) is a coincidence as often as it is a
    musically meaningful match. We only keep cells that are also part of a
    short *diagonal* run of high similarity — i.e. (i-1, j-1), (i+1, j+1), etc.
    are ALSO similar — because that means beats keep matching as the music
    keeps playing, which is what makes a jump there sound seamless rather
    than a single-frame glitch.
    """
    n, m = similarity.shape
    candidates = np.argwhere(similarity >= peak_threshold)

    points = []
    for i, j in candidates:
        hits = 0
        checks = 0
        for k in range(-neighbor_radius, neighbor_radius + 1):
            if k == 0:
                continue
            ni, nj = i + k, j + k
            if 0 <= ni < n and 0 <= nj < m:
                checks += 1
                if similarity[ni, nj] >= neighbor_threshold:
                    hits += 1
        if checks >= min_neighbor_hits and hits >= min_neighbor_hits:
            points.append(
                {
                    "beat_a": int(i),
                    "beat_b": int(j),
                    "score": float(similarity[i, j]),
                }
            )

    # Highest-confidence points first, then thin out points that are
    # essentially duplicates of a better neighbor.
    points.sort(key=lambda p: -p["score"])
    kept = []
    for p in points:
        if any(
            abs(p["beat_a"] - k["beat_a"]) <= 1 and abs(p["beat_b"] - k["beat_b"]) <= 1
            for k in kept
        ):
            continue
        kept.append(p)
        if len(kept) >= max_points:
            break

    return kept


# ---------------------------------------------------------------------------
# 6. Upload to Backblaze B2
# ---------------------------------------------------------------------------
def upload_file(b2, local_path: Path, key: str) -> str:
    extra_args = {}
    if local_path.suffix == ".mp3":
        extra_args["ContentType"] = "audio/mpeg"
    elif local_path.suffix == ".json":
        extra_args["ContentType"] = "application/json"

    b2.upload_file(str(local_path), B2_BUCKET_NAME, key, ExtraArgs=extra_args)
    return f"{B2_PUBLIC_URL_BASE}/{key}"


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

        # 4. Cross-similarity matrix between the two stems
        similarity = compute_similarity_matrix(vocal_features, inst_features)

        # 5. Diagonal-coherent jump points
        jump_points = find_jump_points(similarity)
        jump_points_with_time = [
            {
                **p,
                "time_vocal": float(vocal_beats[p["beat_a"]]),
                "time_instrumental": float(inst_beats[p["beat_b"]]),
            }
            for p in jump_points
        ]

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
            "jump_points": jump_points_with_time,
        }

        matrix_path = job_dir / "matrix.json"
        matrix_path.write_text(json.dumps(matrix_payload))

        # 6. Upload to B2
        prefix = f"tracks/{track_id}"
        vocals_url = upload_file(b2, vocals_mp3, f"{prefix}/vocals.mp3")
        instrumental_url = upload_file(b2, instrumental_mp3, f"{prefix}/instrumental.mp3")
        matrix_url = upload_file(b2, matrix_path, f"{prefix}/matrix.json")

        # 7. Mark completed
        supabase.table("tracks").update(
            {
                "status": "completed",
                "title": title,
                "bpm": bpm,
                "vocals_url": vocals_url,
                "instrumental_url": instrumental_url,
                "matrix_json_url": matrix_url,
                "error_message": None,
            }
        ).eq("id", track_id).execute()

        print(f"[{WORKER_ID}] Completed {youtube_id}")

    except Exception as exc:  # noqa: BLE001
        print(f"[{WORKER_ID}] FAILED {youtube_id}: {exc}")
        traceback.print_exc()
        supabase.table("tracks").update(
            {"status": "failed", "error_message": str(exc)[:2000]}
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
