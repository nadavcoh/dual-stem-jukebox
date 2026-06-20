"use server";

import { getPresignedUrls } from "@/lib/b2Presign";

/**
 * Exchanges B2 object keys for short-lived presigned URLs.
 *
 * Called directly from JukeboxPlayer (a Client Component) right before it
 * starts decoding audio — generating the URLs just-in-time, rather than
 * once when the page first rendered, means they can't expire before
 * playback actually starts.
 *
 * @param {string[]} keys
 * @returns {Promise<{ ok: boolean, urls?: Record<string,string>, error?: string }>}
 */
export async function getPlaybackUrls(keys) {
  try {
    const urls = await getPresignedUrls(keys ?? []);
    return { ok: true, urls };
  } catch (err) {
    console.error("[getPlaybackUrls] failed:", err);
    return { ok: false, error: err?.message ?? "Couldn't generate playback URLs." };
  }
}
