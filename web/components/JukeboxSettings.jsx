"use client";

/**
 * Tuning panel for auto-jump / auto-switch-stems, directly inspired by the
 * Infinite Jukebox's "Tune" dialog (musicmachinery.com/2012/11/26/tuning-the-infinite-jukebox).
 * Every value here was previously a hardcoded constant in lib/audioEngine.js.
 *
 * @param {{
 *   open: boolean, onClose: () => void,
 *   settings: object, onChange: (partial: object) => void, onReset: () => void,
 *   autoJumpStatus: { currentProbabilityPercent: number, lastJumpScore: number|null },
 *   jumpPointCount: number, excludedCount: number, onResetExcluded: () => void,
 * }} props
 */
export default function JukeboxSettings({
  open,
  onClose,
  settings,
  onChange,
  onReset,
  autoJumpStatus,
  jumpPointCount,
  excludedCount,
  onResetExcluded,
}) {
  if (!open) return null;

  function set(key, value) {
    onChange({ [key]: value });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-xl border border-stone-800 bg-stone-950 p-5 text-stone-100 sm:rounded-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="font-mono text-[11px] uppercase tracking-widest text-stone-500">Tune</p>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-200">
            ✕
          </button>
        </div>

        {/* Live status, à la the Infinite Jukebox's "Branch chance" / "Last Threshold" readouts */}
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-lg border border-stone-800 bg-stone-900/60 p-3 font-mono text-[11px] text-stone-400">
          <span>Branch chance</span>
          <span className="text-right text-emerald-300">
            {autoJumpStatus.currentProbabilityPercent.toFixed(0)}%
          </span>
          <span>Last jump score</span>
          <span className="text-right text-emerald-300">
            {autoJumpStatus.lastJumpScore != null ? autoJumpStatus.lastJumpScore.toFixed(2) : "—"}
          </span>
          <span>Jump points</span>
          <span className="text-right">
            {jumpPointCount} active{excludedCount > 0 ? ` · ${excludedCount} removed` : ""}
          </span>
        </div>

        <div className="space-y-5">
          <Slider
            label="Jump similarity threshold"
            hint="Lower = more (but rougher) candidates. Higher = fewer, cleaner ones."
            value={settings.minScore}
            min={0.8}
            max={0.99}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onChange={(v) => set("minScore", v)}
          />

          <div>
            <p className="mb-2 text-xs text-stone-300">Jump probability range</p>
            <Slider
              label="Low (right after a jump)"
              value={settings.probabilityLow}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => set("probabilityLow", Math.min(v, settings.probabilityHigh))}
            />
            <Slider
              label="High (the longer it's been)"
              value={settings.probabilityHigh}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => set("probabilityHigh", Math.max(v, settings.probabilityLow))}
            />
          </div>

          <Slider
            label="Probability ramp-up speed"
            hint="How fast the chance climbs from low to high between jumps."
            value={settings.rampUpSpeed}
            min={0}
            max={100}
            step={1}
            format={(v) => `${Math.round(v)}`}
            onChange={(v) => set("rampUpSpeed", v)}
          />

          <Slider
            label="Checkpoint interval"
            hint="How often (in Deck A beats) the jump decision is even considered."
            value={settings.everyNBeats}
            min={4}
            max={32}
            step={1}
            format={(v) => `${v} beats`}
            onChange={(v) => set("everyNBeats", v)}
          />

          <Slider
            label="Classic-combo weight"
            hint="How much more likely auto-switch is to pick 'one song's vocal over the other's beat' vs. the other 5 combos."
            value={settings.classicComboWeight}
            min={1}
            max={6}
            step={1}
            format={(v) => `${v}×`}
            onChange={(v) => set("classicComboWeight", v)}
          />

          <details>
            <summary className="cursor-pointer text-xs text-stone-400">Advanced</summary>
            <div className="mt-3">
              <Slider
                label="Score weighting sharpness"
                hint="Higher = stronger preference for the best-scoring candidate over merely-adequate ones."
                value={settings.scoreExponent}
                min={0.5}
                max={4}
                step={0.5}
                format={(v) => `score^${v}`}
                onChange={(v) => set("scoreExponent", v)}
              />
            </div>
          </details>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onResetExcluded}
            disabled={excludedCount === 0}
            className="flex-1 rounded-md border border-stone-700 px-3 py-2 text-xs text-stone-300 disabled:opacity-40"
          >
            Restore {excludedCount} removed point{excludedCount === 1 ? "" : "s"}
          </button>
          <button
            onClick={onReset}
            className="flex-1 rounded-md border border-stone-700 px-3 py-2 text-xs text-stone-300"
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}

function Slider({ label, hint, value, min, max, step, format, onChange }) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between text-xs text-stone-300">
        <span>{label}</span>
        <span className="font-mono text-stone-400">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-cyan-400"
      />
      {hint && <p className="mt-0.5 text-[10px] text-stone-500">{hint}</p>}
    </div>
  );
}
