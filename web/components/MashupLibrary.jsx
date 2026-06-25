"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getLibrary, removeFromLibrary } from "@/app/actions/library";

const SLOT_STYLES = {
  a: { label: "Track A", ring: "ring-cyan-400", text: "text-cyan-300", dot: "bg-cyan-400" },
  b: { label: "Track B", ring: "ring-orange-400", text: "text-orange-300", dot: "bg-orange-400" },
};

function SlotCard({ slot, track }) {
  const style = SLOT_STYLES[slot];
  return (
    // min-w-0 matters here: without it, a flex child won't shrink below
    // its content's intrinsic width, so a long title pushed the whole
    // card (and the row) wider than the screen on mobile instead of
    // wrapping inside it.
    <div
      className={`min-w-0 flex-1 rounded-lg border border-stone-800 bg-stone-900/60 p-3 ${
        track ? `ring-1 ${style.ring}` : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
        <span className={`text-xs font-mono uppercase tracking-wide ${style.text}`}>{style.label}</span>
      </div>
      {track ? (
        <p className="mt-1 break-words text-sm text-stone-200">{track.title ?? track.youtube_id}</p>
      ) : (
        <p className="mt-1 text-sm text-stone-500">Pick a completed track below…</p>
      )}
    </div>
  );
}

function statusNote(track) {
  if (track.status === "failed") return track.error_message?.slice(0, 80) ?? "Failed";
  if (track.status === "completed" && track.bpm) return `${Math.round(track.bpm)} bpm`;
  return track.status;
}

export default function MashupLibrary() {
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [slotA, setSlotA] = useState(null);
  const [slotB, setSlotB] = useState(null);
  const [filter, setFilter] = useState("");
  const [removingId, setRemovingId] = useState(null);
  const router = useRouter();

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await getLibrary();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setTracks(res.tracks);
    } catch (err) {
      console.error("[MashupLibrary] refresh failed:", err);
      setError(err?.message ?? "Couldn't load the library.");
    } finally {
      setLoading(false);
    }
  }

  function pick(slot, track) {
    (slot === "a" ? setSlotA : setSlotB)(track);
  }

  function openMashup() {
    if (!slotA || !slotB) return;
    // Both tracks are pulled from the completed list below, so there's
    // nothing to queue or poll for — straight to the player.
    router.push(`/jukebox/${slotA.youtube_id}/${slotB.youtube_id}`);
  }

  async function handleRemove(track) {
    if (!window.confirm(`Remove "${track.title ?? track.youtube_id}"? This can't be undone.`)) return;
    setRemovingId(track.id);
    try {
      const res = await removeFromLibrary(track.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setTracks((prev) => prev.filter((t) => t.id !== track.id));
      if (slotA?.id === track.id) setSlotA(null);
      if (slotB?.id === track.id) setSlotB(null);
    } catch (err) {
      console.error("[MashupLibrary] remove failed:", err);
      setError(err?.message ?? "Couldn't remove this track.");
    } finally {
      setRemovingId(null);
    }
  }

  const lowerFilter = filter.trim().toLowerCase();
  const matchesFilter = (t) => !lowerFilter || (t.title ?? t.youtube_id).toLowerCase().includes(lowerFilter);

  const completed = tracks.filter((t) => t.status === "completed").filter(matchesFilter);
  const inProgress = tracks.filter((t) => t.status === "queued" || t.status === "processing");
  const failed = tracks.filter((t) => t.status === "failed");

  return (
    <div className="mx-auto w-full max-w-xl space-y-4">
      <div className="flex gap-3">
        <SlotCard slot="a" track={slotA} />
        <SlotCard slot="b" track={slotB} />
      </div>

      <button
        onClick={openMashup}
        disabled={!slotA || !slotB || slotA.youtube_id === slotB.youtube_id}
        className="w-full rounded-md bg-gradient-to-r from-cyan-500 to-orange-500 px-4 py-2.5 text-sm font-semibold text-stone-950 disabled:opacity-40"
      >
        Open Mashup
      </button>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search your library…"
        className="w-full rounded-md border border-stone-700 bg-stone-900 px-3 py-2 text-sm text-stone-100 placeholder:text-stone-500 focus:border-cyan-400 focus:outline-none"
      />

      <div className="flex items-center justify-between">
        <h3 className="text-xs font-mono uppercase tracking-wide text-stone-500">
          Completed ({completed.length})
        </h3>
        <button onClick={refresh} className="text-xs text-stone-400 underline hover:text-stone-200">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {completed.length === 0 && !loading && (
        <p className="text-sm text-stone-500">
          {lowerFilter
            ? "No completed tracks match that search."
            : "Nothing finished processing yet — add songs from the Add Songs tab, then come back here."}
        </p>
      )}

      <ul className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-stone-800 p-1">
        {completed.map((t) => (
          <li key={t.id} className="flex items-start gap-2 rounded-md p-2 hover:bg-white/5">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm text-stone-100">{t.title ?? t.youtube_id}</p>
              <p className="truncate text-xs font-mono text-stone-500">{statusNote(t)}</p>
            </div>
            <div className="flex flex-shrink-0 gap-1.5">
              <button
                onClick={() => pick("a", t)}
                className="rounded border border-cyan-400/40 px-2 py-1 text-xs font-mono text-cyan-300 hover:bg-cyan-400/10"
              >
                A
              </button>
              <button
                onClick={() => pick("b", t)}
                className="rounded border border-orange-400/40 px-2 py-1 text-xs font-mono text-orange-300 hover:bg-orange-400/10"
              >
                B
              </button>
              <button
                onClick={() => handleRemove(t)}
                disabled={removingId === t.id}
                className="rounded border border-red-400/30 px-2 py-1 text-xs font-mono text-red-300/80 hover:bg-red-400/10 disabled:opacity-40"
                title="Remove from library"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>

      {(inProgress.length > 0 || failed.length > 0) && (
        <details className="text-xs text-stone-500">
          <summary className="cursor-pointer font-mono uppercase tracking-wide">
            In progress / failed ({inProgress.length + failed.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {[...inProgress, ...failed].map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 px-1">
                <span className="min-w-0 flex-1 truncate">{t.title ?? t.youtube_id}</span>
                <span
                  className={`shrink-0 font-mono ${t.status === "failed" ? "text-red-400" : "text-amber-300"}`}
                >
                  {t.status}
                </span>
                <button
                  onClick={() => handleRemove(t)}
                  disabled={removingId === t.id}
                  className="shrink-0 rounded border border-red-400/30 px-1.5 py-0.5 font-mono text-red-300/80 hover:bg-red-400/10 disabled:opacity-40"
                  title="Remove from queue"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && <p className="text-center text-sm text-red-400">{error}</p>}
    </div>
  );
}
