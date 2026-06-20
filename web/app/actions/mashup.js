"use server";

import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { extractYouTubeId } from "@/lib/youtube";

/**
 * @param {{ a: {input: string, title?: string}, b: {input: string, title?: string} }} params
 *
 * Behavior:
 *  - Both tracks already 'completed'  -> redirect()s straight to the player.
 *  - Either track missing/failed       -> upserts a 'queued' row for it and
 *                                          returns status so the UI can poll.
 */
export async function requestMashup({ a, b }) {
  const idA = extractYouTubeId(a?.input);
  const idB = extractYouTubeId(b?.input);

  if (!idA || !idB) {
    return { ok: false, error: "Couldn't read a valid YouTube link or ID from one of the tracks." };
  }
  if (idA === idB) {
    return { ok: false, error: "Pick two different tracks to mash up." };
  }

  const supabase = supabaseAdmin();

  const { data: existing, error: selectError } = await supabase
    .from("tracks")
    .select("id, youtube_id, title, status, vocals_url, instrumental_url, matrix_json_url, bpm")
    .in("youtube_id", [idA, idB]);

  if (selectError) {
    return { ok: false, error: selectError.message };
  }

  const byId = Object.fromEntries((existing ?? []).map((row) => [row.youtube_id, row]));

  const toEnqueue = [];
  if (!byId[idA] || byId[idA].status === "failed") {
    toEnqueue.push({ youtube_id: idA, title: a.title ?? null, status: "queued" });
  }
  if (!byId[idB] || byId[idB].status === "failed") {
    toEnqueue.push({ youtube_id: idB, title: b.title ?? null, status: "queued" });
  }

  if (toEnqueue.length > 0) {
    const { error: upsertError } = await supabase
      .from("tracks")
      .upsert(toEnqueue, { onConflict: "youtube_id" });
    if (upsertError) {
      return { ok: false, error: upsertError.message };
    }
  }

  const trackA = byId[idA] ?? { youtube_id: idA, status: "queued" };
  const trackB = byId[idB] ?? { youtube_id: idB, status: "queued" };

  const bothCompleted = trackA.status === "completed" && trackB.status === "completed";

  if (bothCompleted) {
    redirect(`/jukebox/${idA}/${idB}`);
  }

  return {
    ok: true,
    ready: false,
    trackA: { youtubeId: idA, status: trackA.status },
    trackB: { youtubeId: idB, status: trackB.status },
  };
}

/** Lightweight status check the client can poll while jobs are processing. */
export async function getMashupStatus(idA, idB) {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("tracks")
    .select("youtube_id, status, title")
    .in("youtube_id", [idA, idB]);

  if (error) return { ok: false, error: error.message };

  const ready =
    data.length === 2 && data.every((row) => row.status === "completed");

  return { ok: true, ready, tracks: data };
}
