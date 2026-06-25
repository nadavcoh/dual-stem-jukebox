"use client";

import { useEffect, useState, useTransition } from "react";
import { searchYouTube } from "@/app/actions/search";
import { requestProcessing, getLibrary, removeFromLibrary } from "@/app/actions/library";

const STATUS_STYLES = {
  queued: "border-stone-600 text-stone-400",
  processing: "border-amber-400/50 text-amber-300",
  completed: "border-emerald-400/50 text-emerald-300",
  failed: "border-red-400/50 text-red-300",
};

function StatusBadge({ status }) {
  return (
    <span
      className={`rounded border px-2 py-1 text-xs font-mono uppercase ${
        STATUS_STYLES[status] ?? "border-stone-600 text-stone-400"
      }`}
    >
      {status}
    </span>
  );
}

function ResultRow({ result, libraryEntry, onRequest, onRemove, isRequesting, isRemoving }) {
  const minutes = Math.floor(result.durationSeconds / 60);
  const seconds = String(result.durationSeconds % 60).padStart(2, "0");
  const status = libraryEntry?.status;

  return (
    <li className="space-y-1.5 rounded-md p-2 hover:bg-white/5">
      <div className="flex items-start gap-2.5">
        <img src={result.thumbnail} alt="" className="mt-0.5 h-9 w-9 flex-shrink-0 rounded object-cover" />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug text-stone-100">{result.title}</p>
          <p className="truncate text-xs text-stone-400">
            {result.author} · {minutes}:{seconds}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {status && status !== "failed" ? (
          <>
            <StatusBadge status={status} />
            <button
              onClick={() => onRemove(libraryEntry)}
              disabled={isRemoving}
              className="rounded border border-red-400/30 px-1.5 py-0.5 font-mono text-xs text-red-300/80 hover:bg-red-400/10 disabled:opacity-40"
              title="Remove from queue/library"
            >
              ✕
            </button>
          </>
        ) : (
          <button
            onClick={() => onRequest(result)}
            disabled={isRequesting}
            className="whitespace-nowrap rounded border border-cyan-400/40 px-2 py-1 text-xs font-mono text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-40"
          >
            {isRequesting ? "Queuing…" : status === "failed" ? "Retry" : "Add to library"}
          </button>
        )}
      </div>
    </li>
  );
}

export default function TrackSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  // youtube_id -> { id, status } — needs the row id now too, for removal.
  const [libraryByYoutubeId, setLibraryByYoutubeId] = useState({});
  const [requestingId, setRequestingId] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [isSearching, startSearch] = useTransition();

  // Pull current library statuses once on mount so freshly-rendered search
  // results can immediately show "already queued/completed" instead of an
  // action button that would just re-queue something already in flight.
  useEffect(() => {
    refreshLibraryStatuses();
  }, []);

  async function refreshLibraryStatuses() {
    try {
      const res = await getLibrary();
      if (res.ok) {
        setLibraryByYoutubeId(
          Object.fromEntries(res.tracks.map((t) => [t.youtube_id, { id: t.id, status: t.status }]))
        );
      }
    } catch (err) {
      console.error("[TrackSearch] library refresh failed:", err);
    }
  }

  function handleSearch(e) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    startSearch(async () => {
      try {
        const { videos, error: searchError, hiddenCount: hidden } = await searchYouTube(query);
        if (searchError) {
          setError(searchError);
          setResults([]);
          return;
        }
        setResults(videos);
        setHiddenCount(hidden ?? 0);
      } catch (err) {
        console.error("[TrackSearch] search action failed:", err);
        setError(err?.message ?? "Search request failed — check your connection and try again.");
        setResults([]);
      }
    });
  }

  async function handleRequest(result) {
    setError(null);
    setNotice(null);
    setRequestingId(result.youtubeId);
    try {
      const res = await requestProcessing({ input: result.youtubeId, title: result.title });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setLibraryByYoutubeId((prev) => ({
        ...prev,
        [result.youtubeId]: { id: prev[result.youtubeId]?.id, status: res.status },
      }));
      setNotice(
        res.alreadyExists
          ? `Already in the library (${res.status}).`
          : "Added to the queue — check the Build Mashup tab once it's completed."
      );
      // The upsert above may have created a new row whose id we don't have
      // yet (requestProcessing doesn't return it) — refresh to pick it up,
      // so a remove button works immediately after adding.
      refreshLibraryStatuses();
    } catch (err) {
      console.error("[TrackSearch] requestProcessing failed:", err);
      setError(err?.message ?? "Couldn't queue this track — try again in a moment.");
    } finally {
      setRequestingId(null);
    }
  }

  async function handleRemove(entry) {
    if (!entry?.id) return;
    if (!window.confirm("Remove this track from the queue/library? This can't be undone.")) return;
    setRemovingId(entry.id);
    setError(null);
    try {
      const res = await removeFromLibrary(entry.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setLibraryByYoutubeId((prev) => {
        const next = { ...prev };
        for (const [ytId, val] of Object.entries(next)) {
          if (val.id === entry.id) delete next[ytId];
        }
        return next;
      });
      setNotice("Removed.");
    } catch (err) {
      console.error("[TrackSearch] removeFromLibrary failed:", err);
      setError(err?.message ?? "Couldn't remove this track.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-4">
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
        <ul className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-stone-800 p-1">
          {results.map((r) => (
            <ResultRow
              key={r.youtubeId}
              result={r}
              libraryEntry={libraryByYoutubeId[r.youtubeId]}
              isRequesting={requestingId === r.youtubeId}
              isRemoving={removingId === libraryByYoutubeId[r.youtubeId]?.id}
              onRequest={handleRequest}
              onRemove={handleRemove}
            />
          ))}
        </ul>
      )}

      {hiddenCount > 0 && (
        <p className="text-center font-mono text-[11px] text-stone-500">
          {hiddenCount} result{hiddenCount === 1 ? "" : "s"} hidden — blocked in your configured region
        </p>
      )}
      {notice && <p className="text-center text-sm text-emerald-300">{notice}</p>}
      {error && <p className="text-center text-sm text-red-400">{error}</p>}
    </div>
  );
}
