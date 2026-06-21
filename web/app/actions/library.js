"use server";

import { supabaseAdmin } from "@/lib/supabaseServer";
import { extractYouTubeId } from "@/lib/youtube";

/**
 * Enqueues a single track for processing. This is the only way new tracks
 * enter the system now — there's no more "search both tracks and auto-queue
 * whichever's missing" flow, because with worker throughput what it is
 * (CPU-only demucs can take well over an hour per song), making someone
 * wait on a freshly-queued track before they can even see a player is a bad
 * trade. Request it here, go do something else, come back to "Build
 * Mashup" once it shows up there as completed.
 *
 * @param {{ input: string, title?: string }} params input is a youtube id or URL
 * @returns {Promise<{ ok: boolean, status?: string, alreadyExists?: boolean, error?: string }>}
 */
export async function requestProcessing({ input, title }) {
  const youtubeId = extractYouTubeId(input);
  if (!youtubeId) {
    return { ok: false, error: "Couldn't read a valid YouTube link or ID." };
  }

  try {
    const supabase = supabaseAdmin();

    const { data: existing, error: selectError } = await supabase
      .from("tracks")
      .select("status")
      .eq("youtube_id", youtubeId)
      .maybeSingle();

    if (selectError) {
      return { ok: false, error: selectError.message };
    }

    // Already queued/processing/completed — nothing to do, just report
    // back what's already there instead of re-queueing on top of it.
    if (existing && existing.status !== "failed") {
      return { ok: true, status: existing.status, alreadyExists: true };
    }

    const { error: upsertError } = await supabase
      .from("tracks")
      .upsert(
        { youtube_id: youtubeId, title: title ?? null, status: "queued" },
        { onConflict: "youtube_id" }
      );

    if (upsertError) {
      return { ok: false, error: upsertError.message };
    }

    return { ok: true, status: "queued", alreadyExists: Boolean(existing) };
  } catch (err) {
    console.error("[requestProcessing] failed:", err);
    return { ok: false, error: err?.message ?? "Couldn't queue this track — unknown server error." };
  }
}

/**
 * Returns every track in the system, newest first — used both to show
 * status badges next to search results ("already queued", "completed",
 * etc.) and to populate the completed-tracks picker for building a mashup.
 *
 * @returns {Promise<{ ok: boolean, tracks?: Array, error?: string }>}
 */
export async function getLibrary() {
  try {
    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from("tracks")
      .select("id, youtube_id, title, status, bpm, error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) return { ok: false, error: error.message };

    return { ok: true, tracks: data ?? [] };
  } catch (err) {
    console.error("[getLibrary] failed:", err);
    return { ok: false, error: err?.message ?? "Couldn't load the library — unknown server error." };
  }
}
