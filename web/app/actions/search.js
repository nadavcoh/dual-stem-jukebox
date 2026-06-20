"use server";

import ytSearch from "yt-search";

/**
 * Searches YouTube for tracks without any API key. Runs server-side only
 * (yt-search scrapes YouTube's search page), called from TrackSearch.
 *
 * Returns { videos, error } rather than throwing — Next.js redacts thrown
 * Server Action errors in production, which means a thrown error becomes
 * an opaque "An error occurred" with zero diagnostic value. Returning the
 * message as data instead lets the UI (and you, debugging this) actually
 * see what failed.
 *
 * @param {string} query
 * @returns {Promise<{videos: Array<{youtubeId: string, title: string, author: string, durationSeconds: number, thumbnail: string}>, error: string|null}>}
 */
export async function searchYouTube(query) {
  const trimmed = (query || "").trim();
  if (trimmed.length < 2) return { videos: [], error: null };

  try {
    const result = await ytSearch(trimmed);
    const rawVideos = result?.videos ?? [];

    const videos = rawVideos.slice(0, 12).map((v) => ({
      youtubeId: v.videoId,
      title: v.title,
      author: v.author?.name ?? "Unknown",
      durationSeconds: v.seconds,
      thumbnail: v.thumbnail,
    }));

    if (videos.length === 0) {
      // ytSearch resolved without throwing but gave back nothing — this is
      // the classic signature of YouTube serving a consent/anti-bot page
      // instead of real results to a datacenter IP, not a code bug.
      // Surface it as a (soft) error so it isn't confused with a genuine
      // "no results for this query".
      console.warn("[searchYouTube] yt-search returned 0 videos for:", trimmed, result);
      return {
        videos: [],
        error:
          "YouTube returned no results — this usually means it's serving an anti-bot/consent page to this server's IP rather than real search results.",
      };
    }

    return { videos, error: null };
  } catch (err) {
    // This is the one that matters most for debugging deploy failures: it
    // also shows up in `vercel logs` / the Vercel dashboard's Function Logs
    // for this action, with the full stack trace.
    console.error("[searchYouTube] threw:", err);
    return { videos: [], error: err?.message ?? "Unknown search error" };
  }
}
