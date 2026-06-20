"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { searchYouTube } from "@/app/actions/search";
import { requestMashup, getMashupStatus } from "@/app/actions/mashup";

const SLOT_STYLES = {
  a: { label: "Track A", ring: "ring-cyan-400", text: "text-cyan-300", dot: "bg-cyan-400" },
  b: { label: "Track B", ring: "ring-orange-400", text: "text-orange-300", dot: "bg-orange-400" },
};

function ResultRow({ result, onPick }) {
  const minutes = Math.floor(result.durationSeconds / 60);
  const seconds = String(result.durationSeconds % 60).padStart(2, "0");
  return (
    <li className="flex items-center gap-3 rounded-md p-2 hover:bg-white/5">
      <img
        src={result.thumbnail}
        alt=""
        className="h-10 w-16 flex-shrink-0 rounded object-cover"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-stone-100">{result.title}</p>
        <p className="truncate text-xs text-stone-400">
          {result.author} · {minutes}:{seconds}
        </p>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={() => onPick("a", result)}
          className="rounded border border-cyan-400/40 px-2 py-1 text-xs font-mono text-cyan-300 hover:bg-cyan-400/10"
        >
          A
        </button>
        <button
          onClick={() => onPick("b", result)}
          className="rounded border border-orange-400/40 px-2 py-1 text-xs font-mono text-orange-300 hover:bg-orange-400/10"
        >
          B
        </button>
      </div>
    </li>
  );
}

function SlotCard({ slot, track }) {
  const style = SLOT_STYLES[slot];
  return (
    <div
      className={`flex-1 rounded-lg border border-stone-800 bg-stone-900/60 p-3 ${
        track ? `ring-1 ${style.ring}` : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
        <span className={`text-xs font-mono uppercase tracking-wide ${style.text}`}>
          {style.label}
        </span>
      </div>
      {track ? (
        <p className="mt-1 truncate text-sm text-stone-200">{track.title}</p>
      ) : (
        <p className="mt-1 text-sm text-stone-500">Pick a track below…</p>
      )}
    </div>
  );
}

export default function TrackSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [slotA, setSlotA] = useState(null);
  const [slotB, setSlotB] = useState(null);
  const [statusMessage, setStatusMessage] = useState(null);
  const [error, setError] = useState(null);
  const [isSearching, startSearch] = useTransition();
  const [isSubmitting, startSubmit] = useTransition();
  const pollRef = useRef(null);
  const router = useRouter();

  useEffect(() => () => clearInterval(pollRef.current), []);

  function handleSearch(e) {
    e.preventDefault();
    setError(null);
    startSearch(async () => {
      try {
        setResults(await searchYouTube(query));
      } catch {
        setError("Search failed — try a different query.");
      }
    });
  }

  function handlePick(slot, result) {
    (slot === "a" ? setSlotA : setSlotB)(result);
  }

  function pollUntilReady(idA, idB) {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const res = await getMashupStatus(idA, idB);
      if (!res.ok) return;
      const byId = Object.fromEntries(res.tracks.map((t) => [t.youtube_id, t]));
      const a = byId[idA]?.status ?? "queued";
      const b = byId[idB]?.status ?? "queued";
      if (a === "failed" || b === "failed") {
        clearInterval(pollRef.current);
        setStatusMessage(null);
        setError("One of the tracks failed to process. Try a different video.");
        return;
      }
      setStatusMessage(`Track A: ${a} · Track B: ${b}`);
      if (res.ready) {
        clearInterval(pollRef.current);
        router.push(`/jukebox/${idA}/${idB}`);
      }
    }, 4000);
  }

  function handleMashup() {
    if (!slotA || !slotB) return;
    setError(null);
    startSubmit(async () => {
      const result = await requestMashup({
        a: { input: slotA.youtubeId, title: slotA.title },
        b: { input: slotB.youtubeId, title: slotB.title },
      });
      // If both tracks were already completed, requestMashup() already
      // redirect()ed server-side and execution never reaches here.
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStatusMessage(`Track A: ${result.trackA.status} · Track B: ${result.trackB.status}`);
      pollUntilReady(result.trackA.youtubeId, result.trackB.youtubeId);
    });
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-4">
      <div className="flex gap-3">
        <SlotCard slot="a" track={slotA} />
        <SlotCard slot="b" track={slotB} />
      </div>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search YouTube for a track…"
          className="flex-1 rounded-md border border-stone-700 bg-stone-900 px-3 py-2 text-sm text-stone-100 placeholder:text-stone-500 focus:border-cyan-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={isSearching}
          className="rounded-md bg-stone-100 px-4 py-2 text-sm font-medium text-stone-900 disabled:opacity-50"
        >
          {isSearching ? "Searching…" : "Search"}
        </button>
      </form>

      {results.length > 0 && (
        <ul className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-stone-800 p-1">
          {results.map((r) => (
            <ResultRow key={r.youtubeId} result={r} onPick={handlePick} />
          ))}
        </ul>
      )}

      <button
        onClick={handleMashup}
        disabled={!slotA || !slotB || isSubmitting}
        className="w-full rounded-md bg-gradient-to-r from-cyan-500 to-orange-500 px-4 py-2.5 text-sm font-semibold text-stone-950 disabled:opacity-40"
      >
        {isSubmitting ? "Queuing…" : "Build Mashup"}
      </button>

      {statusMessage && (
        <p className="text-center font-mono text-xs text-stone-400">
          Processing on the worker — {statusMessage}
        </p>
      )}
      {error && <p className="text-center text-sm text-red-400">{error}</p>}
    </div>
  );
}
