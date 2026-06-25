"use client";

import { useAudioSync } from "@/hooks/useAudioSync";

const ACCENTS = {
  cyan: {
    text: "text-cyan-300",
    bg: "bg-cyan-400",
    border: "border-cyan-400/40",
    glow: "shadow-[0_0_8px_theme(colors.cyan.400)]",
  },
  orange: {
    text: "text-orange-300",
    bg: "bg-orange-400",
    border: "border-orange-400/40",
    glow: "shadow-[0_0_8px_theme(colors.orange.400)]",
  },
};

const TICK_COUNT = 48;

/** Nearest beat index at or before `timeSeconds` (binary search). */
function nearestBeatIndex(beatTimes, timeSeconds) {
  let lo = 0;
  let hi = beatTimes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beatTimes[mid] <= timeSeconds) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, beatTimes.length - 2);
}

/**
 * One deck's timeline: click anywhere to seek that deck there immediately
 * — completely free, not limited to beat-grid landmarks beyond snapping to
 * the nearest beat (snapping to the *beat* still happens, since the whole
 * engine is beat-quantized, but you can land on any beat, not just
 * precomputed jump points). Independent of the other deck entirely.
 *
 * @param {{
 *   slot: "a"|"b", label: string, accent: "cyan"|"orange",
 *   title: string, bpm: number, keyName?: string|null, beatTimes: number[],
 *   engineRef: { current: import("@/lib/audioEngine").JukeboxEngine | null },
 *   mix: { vocal: boolean, instrumental: boolean },
 *   onToggleMix: (stem: "vocal"|"instrumental") => void,
 * }} props
 */
export default function TrackScrubber({
  slot,
  label,
  accent,
  title,
  bpm,
  keyName,
  beatTimes,
  engineRef,
  mix,
  onToggleMix,
}) {
  const totalDuration = beatTimes[beatTimes.length - 1] ?? 0;
  const playheadRef = useAudioSync(engineRef, slot, totalDuration);
  const colors = ACCENTS[accent];

  function handleSeek(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const targetTime = pct * totalDuration;
    const beatIndex = nearestBeatIndex(beatTimes, targetTime);
    engineRef.current?.seekTo(slot, beatIndex);
  }

  return (
    <div className="rounded-lg border border-stone-800 bg-stone-900/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${colors.bg}`} />
          <span className={`flex-shrink-0 text-xs font-mono uppercase tracking-wide ${colors.text}`}>
            {label}
          </span>
          <span className="truncate text-xs text-stone-400">{title}</span>
        </div>
        <span className="flex-shrink-0 font-mono text-[10px] text-stone-500">
          {Math.round(bpm)} bpm{keyName ? ` · ${keyName}` : ""}
        </span>
      </div>

      <div
        ref={playheadRef}
        onClick={handleSeek}
        className="relative mb-2 h-12 cursor-pointer overflow-hidden rounded-md bg-stone-950"
      >
        <div className="absolute inset-0 flex items-center gap-px px-1 opacity-30">
          {Array.from({ length: TICK_COUNT }).map((_, i) => (
            <div key={i} className="h-5 w-px flex-1 bg-stone-700" />
          ))}
        </div>
        <div
          className={`absolute top-0 h-full w-0.5 ${colors.bg} ${colors.glow}`}
          style={{ left: "calc(var(--playhead-pct, 0) * 100%)" }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => onToggleMix("vocal")}
          className={`rounded-md border px-2 py-1.5 text-xs font-mono transition-colors ${
            mix.vocal ? `${colors.border} bg-white/5 ${colors.text}` : "border-stone-700 text-stone-500"
          }`}
        >
          Vocal
        </button>
        <button
          onClick={() => onToggleMix("instrumental")}
          className={`rounded-md border px-2 py-1.5 text-xs font-mono transition-colors ${
            mix.instrumental ? `${colors.border} bg-white/5 ${colors.text}` : "border-stone-700 text-stone-500"
          }`}
        >
          Instrumental
        </button>
      </div>
    </div>
  );
}
