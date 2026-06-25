# Dual-Stem Interactive Jukebox

Generative mashup app: separate two songs into vocal/instrumental stems,
find beat-aligned points where they're harmonically compatible, and play
them back with a sample-accurate Web Audio engine that can jump between
them mid-song.

```
dual-stem-jukebox/
├── supabase/
│   └── migrations/              # tracks table, status enum, claim_next_track() RPC,
│       └── ...                  # B2-private-bucket column rename, key detection columns
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
    │   ├── JukeboxPlayer.jsx      # wires the two decks + matrix + wake lock together
    │   ├── JukeboxSettings.jsx    # tuning panel — Infinite-Jukebox-inspired
    │   ├── TrackScrubber.jsx      # one deck's timeline — click anywhere to seek it
    │   └── JumpMatrix.jsx         # canvas heatmap of the full similarity matrix
    ├── hooks/
    │   ├── useAudioSync.js        # per-deck playhead -> CSS var, no React state
    │   └── useWakeLock.js         # keeps the screen on during playback
    ├── lib/
    │   ├── audioEngine.js        # JukeboxEngine — two independent, freely-seekable decks
    │   ├── crossTrackMatrix.js   # cosine-similarity + diagonal jump-point filter + heatmap downsampling
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
   (`yt-dlp`), separates stems (`demucs`, 2-stem), and extracts
   beat-synchronous Chroma+MFCC features (`librosa`) for *each* stem,
   storing them raw in `matrix.json`. It also detects each track's musical
   key (Krumhansl-Schmuckler key-finding against the instrumental's
   aggregated chroma profile) and a per-stem loudness-normalization gain
   (RMS-based) — both consumed by the player later. It deliberately does
   **not** compute a vocal-vs-instrumental similarity matrix for the
   track's own two stems anymore — they're different timbral content by
   construction (harmonic vocal formants vs. everything-but-vocals), so a
   high cosine-similarity match between them was never musically
   meaningful; the matrix that actually matters can only be built once you
   know *which two tracks* you're mashing up (next step). Uploads the mp3
   stems + `matrix.json` to a **private** B2 bucket and marks the row
   `'completed'` with their **object keys**, not public URLs. A video
   blocked in the worker's region gets a clean one-line `GEO-BLOCKED` log
   instead of a traceback — expected, not a bug, and the only fully
   authoritative check (the pre-filter in step 1 is best-effort).
4. **Build the real jump map** — when you open `/jukebox/[idA]/[idB]`, the
   Server Component exchanges each track's `matrix_json_key` for a
   presigned URL, fetches both `matrix.json` files, and calls
   `buildCrossTrackJumpMap()` (`lib/crossTrackMatrix.js`) — cosine
   similarity between Track A's and Track B's *instrumental* features,
   filtered for diagonally-coherent runs (a lone high-similarity cell is a
   coincidence; a short run of them as the music keeps playing is a real
   match) — to find beats where the two songs line up. This also returns a
   downsampled (max 160×160) version of the *full* similarity matrix for
   the heatmap, via max-pooling so sparse bright spots survive the
   downsampling instead of getting averaged away.
5. **Play** — `JukeboxPlayer` resolves the four stem keys to presigned URLs
   just before decoding (so they can't expire while you were still
   deciding whether to hit play), tracking download progress per stem via
   `ReadableStream` chunks (`_fetchWithProgress` in `lib/audioEngine.js` —
   `decodeAudioData` itself has no progress API, so the bar reflects the
   download, which is most of the real wait for typical file sizes), then
   hands the decoded buffers to `JukeboxEngine` — two **completely
   independent** decks, each running its own lookahead scheduler from the
   moment you hit Load & Play until you stop. `pause()`/`resume()` use
   `AudioContext.suspend()`/`resume()` directly — the whole audio clock
   freezes in place, so every scheduled event just waits with no manual
   bookkeeping; `rewind()` seeks both decks back to beat 0 without the
   stem-switch side effect a real jump has. Each `TrackScrubber` is a
   click-anywhere-to-seek timeline for its own deck only; `JumpMatrix`
   renders the actual similarity field as a heatmap with the algorithm's
   validated jump points marked in green and a live two-color crosshair
   showing both decks' real-time position in that 2D space — click
   anywhere on it (not just the green dots) to send both decks there at
   once. `useAudioSync` paints each playhead via a CSS variable on every
   `requestAnimationFrame`, never touching React state; `useWakeLock`
   keeps the screen from locking mid-mashup.
6. **Optional automatic behaviors, fully tunable, on by default** — a
   **Tune** button opens a settings panel directly inspired by the
   Infinite Jukebox's tuning dialog
   ([musicmachinery.com](https://musicmachinery.com/2012/11/26/tuning-the-infinite-jukebox/)):
   - **Beat sync** — vari-speed beatmatching: Deck B's `playbackRate` is
     set to `bpmA / bpmB` so its beats land in time with Deck A's. This
     is the same technique a turntable's pitch fader uses, **not**
     pitch-corrected time-stretching — it shifts Deck B's pitch by
     whatever the BPM ratio is.
   - **Key match** — same mechanism, different basis: shifts Deck B's
     pitch toward Deck A's detected key instead of its tempo. Combined
     multiplicatively with Beat Sync when both are on — they're generally
     *different* ratios, so running both is a compromise toward each, not
     a perfect solve for either. The UI shows both contributions
     separately (`getRateBreakdown()`) so that's never hidden.
   - **Auto jump** — borrows the Infinite Jukebox's probability model
     directly: a "branch chance" starts low right after a jump and climbs
     every checkpoint (every *N* of Deck A's beats) one isn't taken,
     resetting to low the moment one is. *Which* candidate gets taken, on
     top of that, is weighted by `score^exponent` — our own addition,
     since we have a whole matrix of simultaneous candidates rather than
     usually-one-per-beat. All of it tunable: similarity threshold,
     probability range, ramp-up speed, checkpoint interval, weighting
     sharpness.
   - **Auto switch stems** — still coupled to jumps only, no independent
     timer — now with a tunable weight for how much more likely the two
     "classic" combos (one song's vocal over the other's beat) are versus
     the other five.

   All four default to **on** — these are the headline features, not
   opt-ins to discover later.

   The candidate pool itself is no longer fixed at build time either:
   `recomputeJumpPointsFromHeatmap()` (`lib/crossTrackMatrix.js`) reruns
   the diagonal-filter algorithm against the heatmap live, every time the
   similarity threshold slider moves (debounced). Moving the slider
   server-side-fixed-then-merely-narrowed candidates would've made the
   threshold control cosmetic; this way it actually changes what's
   available. The cap on returned points went from 200/300 up to 1500 —
   at a 160×160 heatmap the dedup logic already keeps the real count far
   below any cap that mattered, and a finer threshold step (0.001, most
   useful between 0.95-0.99) can legitimately surface far more candidates
   in a dense region than the old cap allowed through. The threshold
   slider's settings (and every other tuning value) can be saved as your
   new default via the settings panel — stored in `localStorage`, loaded
   automatically next time, with "Reset" falling back to that saved value
   (or the factory default if you've never saved one).

   **Editing the matrix directly** — `JumpMatrix`'s "Edit" toggle turns
   clicking a green dot into deleting it from the candidate pool (both
   auto-jump's and the dot's own), the same "click a branch, hit delete"
   idea from the Infinite Jukebox's tuning UI. "Restore N removed points"
   in the settings panel undoes all of it at once — there's no
   per-point undo, matching that same precedent.

   The mix is engine-owned state for this reason: once auto-switch can
   change it from inside the engine, React can't be the source of truth
   for it anymore — `JukeboxPlayer` mirrors it via `onTick()` instead of
   holding it locally.
7. **Loudness normalization, always on** — each stem's persistent gain
   node carries the worker's RMS-based normalization gain
   (`compute_normalization_gain()`), clamped to 0.3-3x so a near-silent
   separated stem doesn't get boosted into amplifying noise. "On" in the
   mix never means literal `1.0` — it means "this stem's normalized
   level." No toggle for this one; there's no real reason you'd want the
   two tracks at mismatched volumes.
8. **Library management** — `MashupLibrary` has its own search box now
   (client-side filter over the completed list), and every row — queued,
   processing, completed, or failed — has a ✕ button calling
   `removeFromLibrary()`. That only deletes the Supabase row, deliberately
   never B2: the web app only ever holds B2's *read-only* key, so it
   couldn't delete the uploaded stems even if it wanted to. A removed
   completed track's files become orphaned in the bucket — harmless, just
   not automatically cleaned up; that's a job for a worker-side sweep
   script if it ever bothers you, not this app.

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

YouTube's signature challenges increasingly need actual JavaScript
execution to solve — `worker.py` enables yt-dlp's External JS (EJS)
system (`remote_components: {"ejs:github"}`) to fetch the solver scripts
from yt-dlp's own GitHub org on demand. You'll also need a JS runtime
installed for EJS to run them — [Deno](https://deno.com) is the default
and recommended (it runs the fetched JS sandboxed, no filesystem/network
access); Node, Bun, and QuickJS are also supported. See
[yt-dlp's EJS wiki page](https://github.com/yt-dlp/yt-dlp/wiki/EJS) for
details — this is a real, deliberately-narrow opt-in yt-dlp shipped for
exactly this problem, not a workaround.

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
- **Beat Sync and Key Match both work by changing `playbackRate` — neither
  is pitch-corrected.** They're the same lever (vari-speed), pointed at two
  different targets (tempo ratio vs. semitone ratio). Run only one and it
  does exactly what it says; run both and the result is `tempoRate *
  pitchRate` — a compromise toward each, not a perfect solve for either,
  since they're generally different ratios. True independent pitch
  correction needs a phase vocoder or similar, which is a real DSP
  undertaking deliberately out of scope here.
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
