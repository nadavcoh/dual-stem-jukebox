"use server";

import ytSearch from "yt-search";

/**
 * Searches YouTube for tracks without any API key. Runs server-side only
 * (yt-search scrapes YouTube's search page), called from TrackSearch via
 * a form action / startTransition.
 *
 * @param {string} query
 * @returns {Promise<Array<{youtubeId: string, title: string, author: string, durationSeconds: number, thumbnail: string}>>}
 */
export async function searchYouTube(query) {
  const trimmed = (query || "").trim();
  if (trimmed.length < 2) return [];

  const { videos } = await ytSearch(trimmed);

  return videos.slice(0, 12).map((v) => ({
    youtubeId: v.videoId,
    title: v.title,
    author: v.author?.name ?? "Unknown",
    durationSeconds: v.seconds,
    thumbnail: v.thumbnail,
  }));
}
