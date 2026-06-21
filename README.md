# Dual-Stem Interactive Jukebox

Generative mashup app: separate two songs into vocal/instrumental stems,
find beat-aligned points where they're harmonically compatible, and play
them back with a sample-accurate Web Audio engine that can jump between
them mid-song.

```
dual-stem-jukebox/
├── supabase/
│   └── migrations/              # tracks table, status enum, claim_next_track() RPC,
│       └── ...                  # + the B2-private-bucket column rename
├── worker/                     # Python local worker (run on your own machine/GPU)
│   ├── worker.py
│   ├── requirements.txt
│   └── .env.example
└── web/                        # Next.js App Router frontend
    ├── app/
    │   ├── actions/
    │   │   ├── search.js        # Server Action: yt-search wrapper + geo-block pre-filter
    │   │   ├── library.js       # Server Action: enqueue one track / list the library
    │   │   └── presign.js       # Server Action: object keys -> presigned URLs
    │   ├── jukebox/[idA]/[idB]/page.jsx  # builds the cross-track jump map, renders player
    │   ├── layout.jsx
    │   ├── page.jsx              # renders Workbench
    │   └── globals.css
    ├── components/
    │   ├── Workbench.jsx          # tab switcher: Add Songs / Build Mashup
    │   ├── TrackSearch.jsx        # "Add Songs" tab — search + request processing
    │   ├── MashupLibrary.jsx      # "Build Mashup" tab — pick 2 completed tracks
    │   └── JukeboxPlayer.jsx
    ├── hooks/
    │   └── useAudioSync.js
    ├── lib/
    │   ├── audioEngine.js        # JukeboxEngine — the Web Audio scheduler/router
    │   ├── crossTrackMatrix.js   # cosine-similarity + diagonal jump-point filter (JS port)
    │   ├── youtubePlayability.js # best-effort region-block check for search results
    │   ├── b2Presign.js          # read-only S3 client + presigned URL helpers (private bucket)
    │   ├── supabaseClient.js     # publishable key, browser
    │   └── supabaseServer.js     # service-role key, server only
    ├── package.json
    ├── tailwind.config.js / postcss.config.js / next.config.js / jsconfig.json
    └── .env.local.example
```

## How the pieces fit together

1. **Add Songs tab** — `TrackSearch` searches YouTube via `yt-search` (no API
   key). Results that `lib/youtubePlayability.js` can confidently tell are
   region-blocked are filtered out before you ever see them (best-effort —
   see that file's doc comment for the real caveats). Each result gets its
   own "Add to library" button, which calls `requestProcessing` — there's
   no second track, no slot-matching, no waiting here; it just enqueues
   that one track and you move on.
2. **Build Mashup tab** — `MashupLibrary` shows everything `getLibrary()`
   returns, split into completed (pickable for A/B) and
   in-progress/failed (visible for status, not pickable). Picking two
   completed tracks and hitting "Open Mashup" is a plain client-side
   `router.push()` — no Server Action, no queueing, because both tracks
   are already known-completed by construction.
3. **Process (off-platform)** — your local `worker.py` polls
   `claim_next_track()`, which uses `SELECT ... FOR UPDATE SKIP LOCKED` so
   multiple workers never grab the same job. It downloads the audio
   (`yt-dlp`), separates stems (`demucs`, 2-stem), extracts beat-synchronous
   Chroma+MFCC features (`librosa`), computes a vocal↔instrumental
   cross-similarity matrix (`scipy.spatial.distance.cdist`, cosine), filters
   it for diagonally-coherent jump points, uploads the mp3 stems and a
   `matrix.json` to a **private** Backblaze B2 bucket (`boto3`, read-write
   key), and marks the row `'completed'` with their **object keys**
   (`{youtube_id}/vocals.mp3`, etc.) — not public URLs, since the bucket
   isn't public. A video that's blocked in the worker's region gets a clean
   one-line `GEO-BLOCKED` log and `status='failed'` instead of a traceback —
   that's an expected outcome, not a bug, and the only place that knows for
   certain (the pre-filter in step 1 is best-effort, this is authoritative).
4. **Build the real jump map** — `matrix.json` stores each track's raw
   beat-synced features, not just its self jump points. When you open
   `/jukebox/[idA]/[idB]`, the Server Component exchanges each track's
   `matrix_json_key` for a short-lived presigned URL (`lib/b2Presign.js`,
   using a separate **read-only** B2 key), fetches both, and calls
   `buildCrossTrackJumpMap()` (`lib/crossTrackMatrix.js`) — the same
   cosine-distance + diagonal-filter algorithm as the worker, reimplemented
   in JS — to find beats where Track A and Track B's *instrumentals* line
   up. That's the jump map the player actually plays from.
5. **Play** — `JukeboxPlayer` receives `vocalsKey`/`instrumentalKey` (not
   URLs) as props. Right before it starts decoding, it calls the
   `getPlaybackUrls` Server Action (`app/actions/presign.js`) to exchange
   those four keys for presigned URLs *just in time* — generating them this
   late, rather than back when the page first rendered, means they can't
   expire before someone actually hits play. Only then does it hand the
   resolved URLs to `JukeboxEngine` (`lib/audioEngine.js`) and start its
   lookahead scheduler. `useAudioSync` paints the playhead via a CSS
   variable on every `requestAnimationFrame`, never touching React state.

## Setup

### 1. Supabase

- Create a project, then run everything in `supabase/migrations/` in order
  (SQL editor, or `supabase db push` if you're using the CLI).
- Grab the project URL plus the **publishable** and **secret** keys from
  Project Settings → API Keys (`sb_publishable_...` / `sb_secret_...`).
  These replace the legacy `anon`/`service_role` JWT keys — same
  permissions, but rotatable and revocable independently. Legacy keys still
  work today but are being phased out by end of 2026; if your project
  doesn't show a Publishable/Secret tab yet, click "Create new API keys"
  to add them alongside your existing ones.

### 2. Backblaze B2

- Create a **private** bucket (no credit card required, unlike a public
  one) and an S3-compatible application key.
- Create **two** application keys scoped to that bucket:
  - **Read-write** — used only by `worker.py` to upload stems/matrix.json.
  - **Read-only** — used only by the Next.js app to generate presigned
    URLs. Keeping these separate means a leaked frontend credential can
    never be used to overwrite or delete anything in the bucket.
- Note the bucket's S3-compatible endpoint (Bucket → "Endpoint" field) —
  both keys share the same endpoint/region.

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
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Secret-key access to claim/update jobs, bypassing RLS |
| `B2_RW_KEY_ID`, `B2_RW_APPLICATION_KEY` | Read-write B2 key — uploads only, never used by the web app |
| `B2_BUCKET_NAME`, `B2_ENDPOINT_URL`, `B2_REGION` | boto3 S3-compatible client config |
| `WORKER_ID`, `POLL_INTERVAL_SECONDS`, `STALE_JOB_TIMEOUT_MINUTES`, `WORK_DIR`, `DEMUCS_MODEL` | Worker behavior tuning |

**`web/.env.local`**
| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Read-only client-side queries |
| `SUPABASE_SECRET_KEY` | Server Actions only — enqueues jobs, bypassing RLS |
| `B2_READ_KEY_ID`, `B2_READ_APPLICATION_KEY` | Read-only B2 key — can only generate GET presigned URLs |
| `B2_BUCKET_NAME`, `B2_ENDPOINT_URL`, `B2_REGION` | Same bucket as the worker, used by `lib/b2Presign.js` |
| `YOUTUBE_REGION_CODE` | Country code to check region-blocks against (set to your *worker's* region, not Vercel's) |

## Notes & honest caveats

- **`yt-search`** scrapes YouTube's search page rather than calling an
  official API, so its DOM/JSON shape can drift; pin a version and re-check
  the `videos[]` field names (`videoId`, `title`, `author.name`, `seconds`,
  `thumbnail`) if results come back empty.
- **The geo-block search filter (`lib/youtubePlayability.js`) is
  best-effort, not authoritative.** It checks a region you configure
  (`YOUTUBE_REGION_CODE`), via the same unofficial endpoint yt-dlp uses
  internally — it can start getting bot-walled by YouTube the same way
  `yt-search` can, and it fails *open* (shows the video) whenever it can't
  get a clear answer, on purpose, to avoid hiding things that would have
  worked fine. The worker's own `GEO-BLOCKED` log when a download actually
  fails is the only fully reliable signal.
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
- Presigned URLs default to a 5-minute expiry (`DEFAULT_EXPIRES_IN_SECONDS`
  in `lib/b2Presign.js`). That's plenty of time between "Load & Play" and
  the actual `fetch()` calls, but if you add a "resume later" feature or
  very long tracks, you may want to bump it.
- This is boilerplate meant to demonstrate the architecture end-to-end and
  run correctly for a single worker / moderate traffic; productionizing
  (auth, rate limits, job retries/backoff, horizontal worker scaling) is
  intentionally left as the next step.
