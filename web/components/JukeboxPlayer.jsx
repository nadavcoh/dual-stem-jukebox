"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { JukeboxEngine } from "@/lib/audioEngine";
import { useWakeLock } from "@/hooks/useWakeLock";
import { getPlaybackUrls } from "@/app/actions/presign";
import TrackScrubber from "@/components/TrackScrubber";
import JumpMatrix from "@/components/JumpMatrix";

/**
 * @param {{
 *   trackA: { title: string, vocalsKey: string, instrumentalKey: string },
 *   trackB: { title: string, vocalsKey: string, instrumentalKey: string },
 *   jumpMap: {
 *     jumpPoints: Array, beatTimesA: number[], beatTimesB: number[],
 *     bpmA: number, bpmB: number,
 *     heatmap: { data: number[][], rows: number, cols: number, binRows: number, binCols: number },
 *   },
 * }} props
 */
export default function JukeboxPlayer({ trackA, trackB, jumpMap }) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = new JukeboxEngine();

  const [phase, setPhase] = useState("idle"); // idle | loading | playing
  const [error, setError] = useState(null);
  const [mix, setMixState] = useState({
    aVocal: true,
    aInstrumental: true,
    bVocal: false,
    bInstrumental: false,
  });

  // Keep the screen from locking/dimming while actually playing — a
  // 3-4 minute demucs-separated mashup session is exactly the kind of
  // thing that shouldn't get cut off by your phone's screen timeout.
  useWakeLock(phase === "playing");

  useEffect(() => () => engineRef.current.stop(), []);

  const handleLoadAndPlay = useCallback(async () => {
    setError(null);
    try {
      setPhase("loading");
      const engine = engineRef.current;
      engine.ensureContext();

      // The bucket is private — exchange object keys for short-lived
      // presigned URLs right now, immediately before fetching, so they
      // can't expire while the user was still deciding whether to hit play.
      const keys = [
        trackA.vocalsKey,
        trackA.instrumentalKey,
        trackB.vocalsKey,
        trackB.instrumentalKey,
      ];
      const presigned = await getPlaybackUrls(keys);
      if (!presigned.ok) {
        throw new Error(presigned.error ?? "Couldn't generate playback URLs.");
      }
      const { urls } = presigned;

      await Promise.all([
        engine.loadTrack("a", {
          vocalsUrl: urls[trackA.vocalsKey],
          instrumentalUrl: urls[trackA.instrumentalKey],
          beatTimes: jumpMap.beatTimesA,
        }),
        engine.loadTrack("b", {
          vocalsUrl: urls[trackB.vocalsKey],
          instrumentalUrl: urls[trackB.instrumentalKey],
          beatTimes: jumpMap.beatTimesB,
        }),
      ]);

      engine.setActiveMix(mix);
      engine.start();
      setPhase("playing");
    } catch (err) {
      console.error(err);
      setError(err?.message ?? "Couldn't load audio — check the stem keys and B2 credentials.");
      setPhase("idle");
    }
  }, [trackA, trackB, jumpMap, mix]);

  const handleStop = useCallback(() => {
    engineRef.current.stop();
    setPhase("idle");
  }, []);

  function toggleMix(slot, stem) {
    const key = `${slot}${stem[0].toUpperCase()}${stem.slice(1)}`; // "aVocal", "bInstrumental", etc.
    const next = { ...mix, [key]: !mix[key] };
    setMixState(next);
    if (phase === "playing") engineRef.current.setActiveMix(next);
  }

  function handleApplyJump(jump) {
    if (phase !== "playing") return;
    engineRef.current.applyJumpPoint(jump);
  }

  const isPlaying = phase === "playing";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 rounded-xl border border-stone-800 bg-stone-950 p-5 text-stone-100">
      <header className="flex items-center justify-between">
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

        {isPlaying ? (
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
            {phase === "loading" ? "Decoding…" : "Load & Play"}
          </button>
        )}
      </header>

      {/* Two fully independent decks — each seekable to any beat at any
          time via its own scrubber, regardless of what the other is doing. */}
      <div className={`space-y-3 ${isPlaying ? "" : "pointer-events-none opacity-50"}`}>
        <TrackScrubber
          slot="a"
          label="Deck A"
          accent="cyan"
          title={trackA.title}
          bpm={jumpMap.bpmA}
          beatTimes={jumpMap.beatTimesA}
          engineRef={engineRef}
          mix={{ vocal: mix.aVocal, instrumental: mix.aInstrumental }}
          onToggleMix={(stem) => toggleMix("a", stem)}
        />
        <TrackScrubber
          slot="b"
          label="Deck B"
          accent="orange"
          title={trackB.title}
          bpm={jumpMap.bpmB}
          beatTimes={jumpMap.beatTimesB}
          engineRef={engineRef}
          mix={{ vocal: mix.bVocal, instrumental: mix.bInstrumental }}
          onToggleMix={(stem) => toggleMix("b", stem)}
        />
      </div>

      <div className={isPlaying ? "" : "pointer-events-none opacity-50"}>
        <JumpMatrix
          heatmap={jumpMap.heatmap}
          jumpPoints={jumpMap.jumpPoints}
          beatTimesA={jumpMap.beatTimesA}
          beatTimesB={jumpMap.beatTimesB}
          engineRef={engineRef}
          onApplyJump={handleApplyJump}
        />
      </div>

      {!isPlaying && phase !== "loading" && (
        <p className="text-center text-xs text-stone-500">Hit Load & Play to wake up both decks.</p>
      )}
      {error && <p className="text-center text-sm text-red-400">{error}</p>}
    </div>
  );
}
