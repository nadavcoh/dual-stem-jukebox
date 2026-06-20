# Dual-Stem Interactive Jukebox

Generative mashup app: separate two songs into vocal/instrumental stems,
find beat-aligned points where they're harmonically compatible, and play
them back with a sample-accurate Web Audio engine that can jump between
them mid-song.

```
dual-stem-jukebox/
├── supabase/
│   └── schema.sql              # tracks table, status enum, claim_next_track() RPC
├── worker/                     # Python local worker (run on your own machine/GPU)
│   ├── worker.py
│   ├── requirements.txt
│   └── .env.example
└── web/                        # Next.js App Router frontend
    ├── app/
    │   ├── actions/
    │   │   ├── search.js        # Server Action: yt-search wrapper
    │   │   └── mashup.js        # Server Action: enqueue + redirect to player
    │   ├── jukebox/[idA]/[idB]/page.jsx  # builds the cross-track jump map, renders player
    │   ├── layout.jsx
    │   ├── page.jsx              # search landing page
    │   └── globals.css
    ├── components/
    │   ├── TrackSearch.jsx
    │   └── JukeboxPlayer.jsx
    ├── hooks/
    │   └── useAudioSync.js
    ├── lib/
    │   ├── audioEngine.js        # JukeboxEngine — the Web Audio scheduler/router
    │   ├── crossTrackMatrix.js   # cosine-similarity + diagonal jump-point filter (JS port)
    │   ├── supabaseClient.js     # anon key, browser
    │   └── supabaseServer.js     # service-role key, server only
    ├── package.json
    ├── tailwind.config.js / postcss.config.js / next.config.js / jsconfig.json
    └── .env.local.example
```

## How the pieces fit together

1. **Search & request** — `TrackSearch` searches YouTube via `yt-search` (no
   API key) and lets you assign two results to slot A / slot B. "Build
   Mashup" calls the `requestMashup` Server Action.
2. **Queue** — `requestMashup` extracts each video's 11-character id, checks
   `tracks` in Supabase, and `upsert`s a `'queued'` row for whichever track
   isn't already `'completed'`. If both already are, it `redirect()`s
   straight to the player.
3. **Process (off-platform)** — your local `worker.py` polls
   `claim_next_track()`, which uses `SELECT ... FOR UPDATE SKIP LOCKED` so
   multiple workers never grab the same job. It downloads the audio
   (`yt-dlp`), separates stems (`demucs`, 2-stem), extracts beat-synchronous
   Chroma+MFCC features (`librosa`), computes a vocal↔instrumental
   cross-similarity matrix (`scipy.spatial.distance.cdist`, cosine), filters
   it for diagonally-coherent jump points, uploads the mp3 stems and a
   `matrix.json` to Backblaze B2 (`boto3`), and marks the row `'completed'`.
4. **Build the real jump map** — `matrix.json` stores each track's raw
   beat-synced features, not just its self jump points. When you open
   `/jukebox/[idA]/[idB]`, the Server Component fetches both tracks'
   `matrix.json` and calls `buildCrossTrackJumpMap()`
   (`lib/crossTrackMatrix.js`) — the same cosine-distance + diagonal-filter
   algorithm as the worker, reimplemented in JS — to find beats where Track
   A and Track B's *instrumentals* line up. That's the jump map the player
   actually plays from.
5. **Play** — `JukeboxPlayer` decodes all 4 stem buffers, hands them to
   `JukeboxEngine` (`lib/audioEngine.js`), and starts its lookahead
   scheduler. `useAudioSync` paints the playhead via a CSS variable on every
   `requestAnimationFrame`, never touching React state.

## Setup

### 1. Supabase

- Create a project, then run `supabase/schema.sql` in the SQL editor.
- Grab the project URL, `anon` key, and `service_role` key.

### 2. Backblaze B2

- Create a bucket (public, so stem URLs are directly playable in the
  browser without signed-URL plumbing) and an application key scoped to it.
- Note the bucket's S3-compatible endpoint (Bucket → "Endpoint" field).

### 3. Worker

```bash
cd worker
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in Supabase + B2 values
python worker.py
```

Requires `ffmpeg` on PATH (used by both `yt-dlp` and `demucs`). `demucs`
will use a GPU automatically via PyTorch if one's available — on CPU,
separating a 3-4 minute song typically takes a couple of minutes.

### 4. Web app

```bash
cd web
npm install
cp .env.local.example .env.local   # fill in Supabase values
npm run dev
```

## Environment variables

**`worker/.env`**
| Var | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Service-role access to claim/update jobs, bypassing RLS |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`, `B2_ENDPOINT_URL`, `B2_REGION` | boto3 S3-compatible client config |
| `B2_PUBLIC_URL_BASE` | Base URL used to build the public links stored in Supabase |
| `WORKER_ID`, `POLL_INTERVAL_SECONDS`, `STALE_JOB_TIMEOUT_MINUTES`, `WORK_DIR`, `DEMUCS_MODEL` | Worker behavior tuning |

**`web/.env.local`**
| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Read-only client-side queries |
| `SUPABASE_SERVICE_ROLE_KEY` | Server Actions only — enqueues jobs, bypassing RLS |

## Notes & honest caveats

- **`yt-search`** scrapes YouTube's search page rather than calling an
  official API, so its DOM/JSON shape can drift; pin a version and re-check
  the `videos[]` field names (`videoId`, `title`, `author.name`, `seconds`,
  `thumbnail`) if results come back empty.
- **Respect YouTube's Terms of Service and copyright law** for whatever you
  download and remix — this stack is built for personal experimentation /
  DJ-style mashups, not redistribution of others' recordings.
- The worker's per-track `matrix.json` includes a vocal↔instrumental jump
  map for that single track (exactly what the spec's step 4–5 describe) —
  the cross-*track* A↔B map the player needs is a small additional step
  (`buildCrossTrackJumpMap`) done once both tracks exist, since it's only
  meaningful once you know which two songs you're mashing up.
- `demucs --two-stems vocals` is what actually gives you a clean 2-stem
  split (`vocals.mp3` / `no_vocals.mp3`) on top of the `htdemucs` model —
  there's no separate "htdemucs_2stems" model, it's this flag combination.
- This is boilerplate meant to demonstrate the architecture end-to-end and
  run correctly for a single worker / moderate traffic; productionizing
  (auth, rate limits, job retries/backoff, signed URLs instead of a public
  bucket, horizontal worker scaling) is intentionally left as the next step.
