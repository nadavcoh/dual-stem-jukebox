"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JukeboxEngine } from "@/lib/audioEngine";
import { recomputeJumpPointsFromHeatmap } from "@/lib/crossTrackMatrix";
import { useWakeLock } from "@/hooks/useWakeLock";
import { getPlaybackUrls } from "@/app/actions/presign";
import TrackScrubber from "@/components/TrackScrubber";
import JumpMatrix from "@/components/JumpMatrix";
import JukeboxSettings from "@/components/JukeboxSettings";

const DEFAULT_MIX = {
  a: { vocal: true, instrumental: true },
  b: { vocal: false, instrumental: false },
};

// Every value here used to be a hardcoded constant in lib/audioEngine.js —
// now they're all live-tunable from the settings panel.
const DEFAULT_SETTINGS = {
  minScore: 0.9, // "Branch Similarity Threshold"
  probabilityLow: 0.05, // "Branch Probability Range" low
  probabilityHigh: 0.6, // "Branch Probability Range" high
  rampUpSpeed: 40, // "Branch Probability Ramp-up Speed"
  everyNBeats: 16, // checkpoint interval
  scoreExponent: 2, // candidate-weighting sharpness (advanced)
  classicComboWeight: 3, // auto-switch-stems bias toward the classic combos
};

const TUNE_STORAGE_KEY = "dual-stem-jukebox:tuneDefaults";

function loadSavedDefaults() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TUNE_STORAGE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : null;
  } catch {
    return null;
  }
}

function keyName(key) {
  if (!key) return null;
  return key.name ?? null;
}

/**
 * @param {{
 *   trackA: { title: string, vocalsKey: string, instrumentalKey: string },
 *   trackB: { title: string, vocalsKey: string, instrumentalKey: string },
 *   jumpMap: {
 *     beatTimesA: number[], beatTimesB: number[],
 *     bpmA: number, bpmB: number,
 *     keyA: object|null, keyB: object|null,
 *     gainA: {vocal: number, instrumental: number}, gainB: {vocal: number, instrumental: number},
 *     heatmap: { data: number[][], rows: number, cols: number, binRows: number, binCols: number },
 *   },
 * }} props
 */
export default function JukeboxPlayer({ trackA, trackB, jumpMap }) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = new JukeboxEngine();

  const [phase, setPhase] = useState("idle"); // idle | loading | playing | paused
  const [error, setError] = useState(null);
  const [loadProgress, setLoadProgress] = useState({ a: 0, b: 0 });

  // Engine-mirrored state (the engine is the source of truth — see
  // lib/audioEngine.js's class doc comment for why).
  const [mix, setMix] = useState(DEFAULT_MIX);
  const [autoJumpStatus, setAutoJumpStatus] = useState({ currentProbabilityPercent: 5, lastJumpScore: null });

  // On by default — these are the headline features, not opt-ins someone
  // has to discover. Beat sync / key match only audibly do anything once
  // both decks are loaded (no BPM/key to compare against before that).
  const [beatSync, setBeatSyncState] = useState(true);
  const [keyMatch, setKeyMatchState] = useState(true);
  const [autoJump, setAutoJumpState] = useState(true);
  const [autoStemSwitch, setAutoStemSwitchState] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(() => loadSavedDefaults() ?? DEFAULT_SETTINGS);

  // The jump-point list is now always *derived* from the heatmap at
  // whatever threshold is currently tuned, not a fixed value computed
  // once server-side — see lib/crossTrackMatrix.js's recomputeJumpPointsFromHeatmap.
  const [rawJumpPoints, setRawJumpPoints] = useState(() =>
    recomputeJumpPointsFromHeatmap(jumpMap.heatmap, jumpMap.beatTimesA, jumpMap.beatTimesB, {
      peakThreshold: settings.minScore,
    })
  );
  // User-curated removals (the matrix's "Edit" mode) — keyed by "beatA:beatB".
  const [excludedKeys, setExcludedKeys] = useState(() => new Set());
  const activeJumpPoints = useMemo(
    () => rawJumpPoints.filter((p) => !excludedKeys.has(`${p.beatA}:${p.beatB}`)),
    [rawJumpPoints, excludedKeys]
  );

  useWakeLock(phase === "playing");

  useEffect(() => {
    const unsubscribe = engineRef.current.onTick((state) => {
      setMix(state.mix);
      setAutoJumpStatus(state.autoJump);
    });
    return unsubscribe;
  }, []);

  useEffect(() => () => engineRef.current.stop(), []);

  // Recompute the candidate pool from the heatmap whenever the similarity
  // threshold changes — debounced so dragging the slider doesn't recompute
  // on every pixel. A changed pool invalidates old curated removals (the
  // points they referred to may not even exist in the new pool).
  useEffect(() => {
    const handle = setTimeout(() => {
      setRawJumpPoints(
        recomputeJumpPointsFromHeatmap(jumpMap.heatmap, jumpMap.beatTimesA, jumpMap.beatTimesB, {
          peakThreshold: settings.minScore,
        })
      );
      setExcludedKeys(new Set());
    }, 150);
    return () => clearTimeout(handle);
  }, [settings.minScore, jumpMap]);

  // Everything else just pushes straight to the engine — cheap, no
  // recomputation needed. minScore is included here too even though the
  // pool above is already pre-filtered by it, so the engine's own filter
  // (lib/audioEngine.js's _maybeAutoJump) never disagrees with what's
  // actually in the pool.
  useEffect(() => {
    engineRef.current.setAutoJump({
      minScore: settings.minScore,
      scoreExponent: settings.scoreExponent,
      probabilityLow: settings.probabilityLow,
      probabilityHigh: settings.probabilityHigh,
      rampUpSpeed: settings.rampUpSpeed,
      everyNBeats: settings.everyNBeats,
    });
    engineRef.current.setAutoStemSwitch({ classicWeight: settings.classicComboWeight });
  }, [settings]);

  useEffect(() => {
    engineRef.current.setJumpPoints(activeJumpPoints);
  }, [activeJumpPoints]);

  const handleLoadAndPlay = useCallback(async () => {
    setError(null);
    try {
      setPhase("loading");
      setLoadProgress({ a: 0, b: 0 });
      const engine = engineRef.current;
      engine.ensureContext();

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
          bpm: jumpMap.bpmA,
          keySemitone: jumpMap.keyA?.pitch_class ?? null,
          vocalsGain: jumpMap.gainA?.vocal,
          instrumentalGain: jumpMap.gainA?.instrumental,
          onProgress: (p) => setLoadProgress((prev) => ({ ...prev, a: p })),
        }),
        engine.loadTrack("b", {
          vocalsUrl: urls[trackB.vocalsKey],
          instrumentalUrl: urls[trackB.instrumentalKey],
          beatTimes: jumpMap.beatTimesB,
          bpm: jumpMap.bpmB,
          keySemitone: jumpMap.keyB?.pitch_class ?? null,
          vocalsGain: jumpMap.gainB?.vocal,
          instrumentalGain: jumpMap.gainB?.instrumental,
          onProgress: (p) => setLoadProgress((prev) => ({ ...prev, b: p })),
        }),
      ]);

      engine.setActiveMix({
        aVocal: mix.a.vocal,
        aInstrumental: mix.a.instrumental,
        bVocal: mix.b.vocal,
        bInstrumental: mix.b.instrumental,
      });
      engine.setBeatSync(beatSync);
      engine.setKeyMatch(keyMatch);
      engine.setAutoJump({ enabled: autoJump });
      engine.setAutoStemSwitch({ enabled: autoStemSwitch });
      engine.start();
      setPhase("playing");
    } catch (err) {
      console.error(err);
      setError(err?.message ?? "Couldn't load audio — check the stem keys and B2 credentials.");
      setPhase("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackA, trackB, jumpMap]);

  const handleStop = useCallback(() => {
    engineRef.current.stop();
    setPhase("idle");
  }, []);

  const handlePauseToggle = useCallback(async () => {
    if (phase === "playing") {
      await engineRef.current.pause();
      setPhase("paused");
    } else if (phase === "paused") {
      await engineRef.current.resume();
      setPhase("playing");
    }
  }, [phase]);

  const handleRewind = useCallback(() => {
    if (phase !== "playing" && phase !== "paused") return;
    engineRef.current.rewind();
  }, [phase]);

  function toggleMix(slot, stem) {
    const next = !mix[slot][stem];
    engineRef.current.setMix(slot, stem, next ? 1 : 0);
  }

  function handleApplyJump(jump) {
    if (phase !== "playing") return;
    engineRef.current.applyJumpPoint(jump);
  }

  function handleDeletePoint(point) {
    setExcludedKeys((prev) => new Set(prev).add(`${point.beatA}:${point.beatB}`));
  }

  function toggleBeatSync() {
    const next = !beatSync;
    setBeatSyncState(next);
    if (phase !== "idle") engineRef.current.setBeatSync(next);
  }

  function toggleKeyMatch() {
    const next = !keyMatch;
    setKeyMatchState(next);
    if (phase !== "idle") engineRef.current.setKeyMatch(next);
  }

  function toggleAutoJump() {
    const next = !autoJump;
    setAutoJumpState(next);
    if (phase !== "idle") engineRef.current.setAutoJump({ enabled: next });
  }

  function toggleAutoStemSwitch() {
    const next = !autoStemSwitch;
    setAutoStemSwitchState(next);
    if (phase !== "idle") engineRef.current.setAutoStemSwitch({ enabled: next });
  }

  function handleSaveSettingsAsDefault() {
    try {
      window.localStorage.setItem(TUNE_STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      console.error("[JukeboxPlayer] couldn't save tune defaults:", err);
    }
  }

  function handleResetSettings() {
    setSettings(loadSavedDefaults() ?? DEFAULT_SETTINGS);
  }

  const isPlaying = phase === "playing";
  const isPaused = phase === "paused";
  const isActive = isPlaying || isPaused;
  const isLoading = phase === "loading";
  const overallProgress = Math.round(((loadProgress.a + loadProgress.b) / 2) * 100);
  const rateB = isActive ? engineRef.current.getRateBreakdown("b") : null;

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

        <div className="flex items-center gap-2">
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-md border border-stone-700 px-3 py-2 text-xs text-stone-300"
          >
            Tune
          </button>
          {isActive ? (
            <button
              onClick={handleStop}
              className="rounded-md bg-stone-100 px-4 py-2 text-sm font-medium text-stone-900"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleLoadAndPlay}
              disabled={isLoading}
              className="rounded-md bg-gradient-to-r from-cyan-500 to-orange-500 px-4 py-2 text-sm font-semibold text-stone-950 disabled:opacity-50"
            >
              {isLoading ? `Decoding… ${overallProgress}%` : "Load & Play"}
            </button>
          )}
        </div>
      </header>

      {isLoading && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-stone-800">
          <div
            className="h-full bg-gradient-to-r from-cyan-500 to-orange-500 transition-[width]"
            style={{ width: `${overallProgress}%` }}
          />
        </div>
      )}

      {isActive && (
        <div className="flex items-center gap-2">
          <button
            onClick={handlePauseToggle}
            className="rounded-md border border-stone-700 px-3 py-1.5 text-xs text-stone-300"
          >
            {isPaused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={handleRewind}
            className="rounded-md border border-stone-700 px-3 py-1.5 text-xs text-stone-300"
          >
            ⏮ Rewind
          </button>
        </div>
      )}

      {/* Auto-behavior toggles */}
      <div className="flex flex-wrap items-center gap-2">
        <ToggleChip label="Beat sync" active={beatSync} onClick={toggleBeatSync} />
        <ToggleChip label="Key match" active={keyMatch} onClick={toggleKeyMatch} />
        <ToggleChip label="Auto jump" active={autoJump} onClick={toggleAutoJump} />
        <ToggleChip label="Auto switch stems" active={autoStemSwitch} onClick={toggleAutoStemSwitch} />
        {(beatSync || keyMatch) && isActive && rateB && (
          <span className="font-mono text-[10px] text-stone-500">
            Deck B: tempo {rateB.tempoPercent >= 0 ? "+" : ""}
            {rateB.tempoPercent.toFixed(1)}% · pitch {rateB.pitchPercent >= 0 ? "+" : ""}
            {rateB.pitchPercent.toFixed(1)}%
          </span>
        )}
        {autoJump && isActive && (
          <span className="font-mono text-[10px] text-stone-500">
            branch chance {autoJumpStatus.currentProbabilityPercent.toFixed(0)}%
          </span>
        )}
      </div>

      {/* Two fully independent decks — each seekable to any beat at any
          time via its own scrubber, regardless of what the other is doing. */}
      <div className={`space-y-3 ${isActive ? "" : "pointer-events-none opacity-50"}`}>
        <TrackScrubber
          slot="a"
          label="Deck A"
          accent="cyan"
          title={trackA.title}
          bpm={jumpMap.bpmA}
          keyName={keyName(jumpMap.keyA)}
          beatTimes={jumpMap.beatTimesA}
          engineRef={engineRef}
          mix={mix.a}
          onToggleMix={(stem) => toggleMix("a", stem)}
        />
        <TrackScrubber
          slot="b"
          label="Deck B"
          accent="orange"
          title={trackB.title}
          bpm={jumpMap.bpmB}
          keyName={keyName(jumpMap.keyB)}
          beatTimes={jumpMap.beatTimesB}
          engineRef={engineRef}
          mix={mix.b}
          onToggleMix={(stem) => toggleMix("b", stem)}
        />
      </div>

      <div className={isActive ? "" : "pointer-events-none opacity-50"}>
        <JumpMatrix
          heatmap={jumpMap.heatmap}
          jumpPoints={activeJumpPoints}
          beatTimesA={jumpMap.beatTimesA}
          beatTimesB={jumpMap.beatTimesB}
          engineRef={engineRef}
          onApplyJump={handleApplyJump}
          onDeletePoint={handleDeletePoint}
        />
      </div>

      {!isActive && !isLoading && (
        <p className="text-center text-xs text-stone-500">Hit Load & Play to wake up both decks.</p>
      )}
      {error && <p className="text-center text-sm text-red-400">{error}</p>}

      <JukeboxSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={(partial) => setSettings((s) => ({ ...s, ...partial }))}
        onReset={handleResetSettings}
        onSaveAsDefault={handleSaveSettingsAsDefault}
        autoJumpStatus={autoJumpStatus}
        jumpPointCount={activeJumpPoints.length}
        excludedCount={excludedKeys.size}
        onResetExcluded={() => setExcludedKeys(new Set())}
      />
    </div>
  );
}

function ToggleChip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-mono transition-colors ${
        active
          ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-300"
          : "border-stone-700 text-stone-500"
      }`}
    >
      {label}
    </button>
  );
}
