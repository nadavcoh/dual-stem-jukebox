"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { JukeboxEngine } from "@/lib/audioEngine";
import { useAudioSync } from "@/hooks/useAudioSync";

/**
 * @param {{
 *   trackA: { title: string, vocalsUrl: string, instrumentalUrl: string },
 *   trackB: { title: string, vocalsUrl: string, instrumentalUrl: string },
 *   jumpMap: { jumpPoints: Array, beatTimesA: number[], beatTimesB: number[], bpmA: number, bpmB: number },
 * }} props
 */
export default function JukeboxPlayer({ trackA, trackB, jumpMap }) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = new JukeboxEngine();

  const [phase, setPhase] = useState("idle"); // idle | loading | ready | playing
  const [error, setError] = useState(null);
  const [mix, setMixState] = useState({
    aVocal: true,
    aInstrumental: true,
    bVocal: false,
    bInstrumental: false,
  });
  const [autoJump, setAutoJump] = useState(false);
  const [nowPlaying, setNowPlaying] = useState({ activeSlot: "a", activeBeatIndex: 0 });

  const totalDuration =
    nowPlaying.activeSlot === "a"
      ? jumpMap.beatTimesA[jumpMap.beatTimesA.length - 1]
      : jumpMap.beatTimesB[jumpMap.beatTimesB.length - 1];

  const playheadRef = useAudioSync(engineRef, totalDuration);

  useEffect(() => {
    const unsubscribe = engineRef.current.onTick((state) => setNowPlaying(state));
    return unsubscribe;
  }, []);

  useEffect(() => () => engineRef.current.stop(), []);

  const handleLoadAndPlay = useCallback(async () => {
    setError(null);
    try {
      setPhase("loading");
      const engine = engineRef.current;
      engine.ensureContext();

      await Promise.all([
        engine.loadTrack("a", {
          vocalsUrl: trackA.vocalsUrl,
          instrumentalUrl: trackA.instrumentalUrl,
          beatTimes: jumpMap.beatTimesA,
        }),
        engine.loadTrack("b", {
          vocalsUrl: trackB.vocalsUrl,
          instrumentalUrl: trackB.instrumentalUrl,
          beatTimes: jumpMap.beatTimesB,
        }),
      ]);

      engine.setJumpPoints(jumpMap.jumpPoints);
      engine.setActiveMix(mix);
      engine.start("a", 0);
      setPhase("playing");
    } catch (err) {
      console.error(err);
      setError("Couldn't load audio — check the stem URLs are reachable.");
      setPhase("idle");
    }
  }, [trackA, trackB, jumpMap, mix]);

  const handleStop = useCallback(() => {
    engineRef.current.stop();
    setPhase("ready");
  }, []);

  function toggleStem(key) {
    const next = { ...mix, [key]: !mix[key] };
    setMixState(next);
    if (phase === "playing") engineRef.current.setActiveMix(next);
  }

  function handleAutoJumpToggle() {
    const next = !autoJump;
    setAutoJump(next);
    engineRef.current.setAutoJump(next, 0.2, 0.92);
  }

  function handleManualJump() {
    const candidates = jumpMap.jumpPoints;
    if (!candidates.length) return;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const toSlot = nowPlaying.activeSlot === "a" ? "b" : "a";
    const toBeat = toSlot === "a" ? target.beatA : target.beatB;
    engineRef.current.requestJump(toSlot, toBeat);
  }

  const activeSlotLabel = nowPlaying.activeSlot === "a" ? trackA.title : trackB.title;

  return (
    <div className="mx-auto w-full max-w-2xl rounded-xl border border-stone-800 bg-stone-950 p-5 text-stone-100">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-stone-500">
            Dual-Stem Jukebox
          </p>
          <h2 className="text-sm text-stone-200">
            <span className="text-cyan-300">{trackA.title}</span>
            <span className="px-2 text-stone-600">×</span>
            <span className="text-orange-300">{trackB.title}</span>
          </h2>
        </div>
        <div className="text-right font-mono text-xs text-stone-500">
          <p>A {Math.round(jumpMap.bpmA)} bpm</p>
          <p>B {Math.round(jumpMap.bpmB)} bpm</p>
        </div>
      </header>

      {/* Beat-grid scrubber — playhead position comes from --playhead-pct,
          written directly by useAudioSync on every animation frame. No
          React state is involved in moving this line. */}
      <div ref={playheadRef} className="relative mb-4 h-16 overflow-hidden rounded-md bg-stone-900">
        <div className="absolute inset-0 flex items-center gap-px px-1 opacity-40">
          {Array.from({ length: 64 }).map((_, i) => (
            <div key={i} className="h-6 w-px flex-1 bg-stone-700" />
          ))}
        </div>
        <div
          className="absolute top-0 h-full w-0.5 bg-emerald-400 shadow-[0_0_8px_theme(colors.emerald.400)]"
          style={{ left: "calc(var(--playhead-pct, 0) * 100%)" }}
        />
        <p className="absolute bottom-1 left-2 font-mono text-[10px] text-stone-500">
          {activeSlotLabel} · beat {nowPlaying.activeBeatIndex}
        </p>
      </div>

      {/* 4-track mix toggles */}
      <div className="mb-4 grid grid-cols-4 gap-2">
        <StemToggle label="Vocal A" active={mix.aVocal} color="cyan" onClick={() => toggleStem("aVocal")} />
        <StemToggle label="Inst A" active={mix.aInstrumental} color="cyan" onClick={() => toggleStem("aInstrumental")} />
        <StemToggle label="Vocal B" active={mix.bVocal} color="orange" onClick={() => toggleStem("bVocal")} />
        <StemToggle label="Inst B" active={mix.bInstrumental} color="orange" onClick={() => toggleStem("bInstrumental")} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {phase === "playing" ? (
          <button
            onClick={handleStop}
            className="rounded-md bg-stone-100 px-4 py-2 text-sm font-medium text-stone-900"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={handleLoadAndPlay}
            disabled={phase === "loading"}
            className="rounded-md bg-gradient-to-r from-cyan-500 to-orange-500 px-4 py-2 text-sm font-semibold text-stone-950 disabled:opacity-50"
          >
            {phase === "loading" ? "Decoding stems…" : "Load & Play"}
          </button>
        )}

        <button
          onClick={handleManualJump}
          disabled={phase !== "playing"}
          className="rounded-md border border-stone-700 px-3 py-2 text-sm text-stone-200 disabled:opacity-40"
        >
          Jump now
        </button>

        <label className="ml-auto flex items-center gap-2 text-xs text-stone-400">
          <input type="checkbox" checked={autoJump} onChange={handleAutoJumpToggle} />
          Auto-jump
        </label>
      </div>

      <p className="mt-3 font-mono text-[11px] text-stone-500">
        {jumpMap.jumpPoints.length} jump point{jumpMap.jumpPoints.length === 1 ? "" : "s"} found between
        these two tracks
      </p>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}

function StemToggle({ label, active, color, onClick }) {
  const colorClasses =
    color === "cyan"
      ? active
        ? "border-cyan-400 bg-cyan-400/10 text-cyan-300"
        : "border-stone-700 text-stone-500"
      : active
        ? "border-orange-400 bg-orange-400/10 text-orange-300"
        : "border-stone-700 text-stone-500";

  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-2 py-2 text-xs font-mono transition-colors ${colorClasses}`}
    >
      {label}
    </button>
  );
}
