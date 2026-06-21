import "server-only";

/**
 * Checks whether a video is playable in a given region, using YouTube's own
 * internal "innertube" player endpoint — the same one the official web/app
 * players (and yt-dlp, under the hood) use to decide what to show. This is
 * a read-only metadata lookup (playabilityStatus), not a download — it
 * doesn't touch the actual video content.
 *
 * IMPORTANT CAVEATS, read before trusting this too much:
 *
 * 1. This is an unofficial, undocumented endpoint. It can change shape or
 *    start requiring auth at any time, exactly like yt-search already can
 *    (see the note in search.js) — this is the same category of risk, not
 *    a new one.
 * 2. YouTube has been increasingly returning LOGIN_REQUIRED ("Sign in to
 *    confirm you're not a bot") to unauthenticated player requests from
 *    datacenter IPs — i.e. exactly the IP this Next.js server runs from.
 *    If that happens, we can't tell "blocked" from "bot-walled" apart, so
 *    this fails OPEN (keeps the video visible) rather than hiding it.
 * 3. The region checked is whatever `regionCode` you pass in — set
 *    YOUTUBE_REGION_CODE to wherever your *worker* actually runs, not
 *    wherever this Next.js app is deployed. A video blocked for Vercel's
 *    region but fine for your worker's region (or vice versa) is a real
 *    possibility this can't fully resolve — the worker's own geo-block
 *    detection (worker.py) is the only fully authoritative check, this is
 *    just trying to save you the wait before you find that out.
 */

const PLAYER_ENDPOINT =
  "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const CHECK_TIMEOUT_MS = 2500;

async function checkOne(videoId, regionCode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const res = await fetch(PLAYER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            hl: "en",
            gl: regionCode,
            clientName: "ANDROID",
            clientVersion: "19.09.37",
          },
        },
      }),
    });

    if (!res.ok) return { blocked: false }; // fail open — couldn't get a clear answer

    const data = await res.json();
    const status = data?.playabilityStatus?.status ?? "OK";
    const reason = data?.playabilityStatus?.reason ?? "";

    // Only treat it as blocked when the reason text actually says so — a
    // generic ERROR/UNPLAYABLE for some *other* cause (age-gate, removed,
    // etc.) isn't what we're trying to filter here, and guessing wrong in
    // that direction hides a video that might have processed just fine.
    const blocked =
      (status === "ERROR" || status === "UNPLAYABLE") && /country|region/i.test(reason);

    return { blocked, reason };
  } catch {
    return { blocked: false }; // timeout / network hiccup — fail open
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Array<{youtubeId: string}>} videos
 * @param {string} regionCode ISO 3166-1 alpha-2, e.g. "US", "DE"
 * @returns {Promise<{ videos: Array, hiddenCount: number }>}
 */
export async function filterPlayableVideos(videos, regionCode) {
  const results = await Promise.all(
    videos.map(async (v) => ({ video: v, ...(await checkOne(v.youtubeId, regionCode)) }))
  );

  const kept = results.filter((r) => !r.blocked).map((r) => r.video);
  const hiddenCount = results.length - kept.length;

  return { videos: kept, hiddenCount };
}
