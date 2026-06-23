/**
 * JukeboxEngine
 * =============
 * A sample-accurate dual-deck beat player built directly on the Web Audio
 * API (no <audio> element — HTML5 audio's playback clock isn't precise
 * enough for beat-synchronous seeking).
 *
 * Mental model: two independent "decks", A and B, each permanently running
 * its own transport (vocal + instrumental together, since they share one
 * timeline) from the moment you hit play until you stop. Each deck can be
 * seek()'d to any beat, at any moment, completely independently of the
 * other. What's actually *audible* (vocal/instrumental, A/B) is a separate
 * concern, controlled by the persistent routing-graph gain nodes below.
 *
 * On top of that manual control, three optional automatic behaviors:
 *
 *  - Beat Sync: vari-speed beatmatching via playbackRate, locking Deck B's
 *    tempo to Deck A's — the same technique a turntable pitch fader uses.
 *    This is NOT pitch-corrected time-stretching (that needs a phase
 *    vocoder, out of scope for a plain AudioBufferSourceNode); it shifts
 *    pitch slightly, proportional to the BPM ratio. Honest tradeoff, not
 *    a bug.
 *  - Auto Jump: probability-ramping branch model borrowed directly from
 *    the Infinite Jukebox (musicmachinery.com) — probability of jumping
 *    starts low and climbs every checkpoint it doesn't, resetting to low
 *    the moment one is taken. Which candidate gets taken, on top of that,
 *    is weighted by score.
 *  - Auto Switch Stems: coupled to jumps, not its own timer — every time
 *    a jump happens (auto or manual), rotate to a different vocal/
 *    instrumental combination, weighted toward the two classic mashup
 *    moves (one song's vocal over the other's beat).
 *
 * Routing graph (persistent for the life of the engine):
 *
 *   vocalA source ──> gain(vocalA) ─┐
 *   instA  source ──> gain(instA) ──┼──> masterGain ──> destination
 *   vocalB source ──> gain(vocalB) ─┤
 *   instB  source ──> gain(instB) ──┘
 *
 * gain(vocalA) etc. are the user-facing mix controls. They are NOT what
 * implements seek crossfades — each scheduled beat segment gets its own
 * short-lived AudioBufferSourceNode + GainNode (created fresh, connected
 * into the persistent stem gain above, discarded when it ends) so a seek
 * can ramp exactly the two segments that collide at the seek point,
 * sample-accurately, without disturbing the user's mix levels.
 *
 * Scheduling follows the classic "lookahead scheduler" pattern (Chris
 * Wilson, "A Tale of Two Clocks"): a cheap setInterval polls how far each
 * deck is from its next beat boundary, and schedules audio events slightly
 * ahead of time using the audio clock (audioCtx.currentTime) — never the
 * setInterval clock itself.
 */

const SCHEDULE_AHEAD_SECONDS = 0.1;
const TICK_INTERVAL_MS = 25;
const CROSSFADE_SECONDS = 0.02; // 20ms
const SEEK_LEAD_SECONDS = 0.05; // safety margin so a seek never schedules in the past

const SLOTS = ["a", "b"];
const STEMS = ["vocal", "instrumental"];

// Curated combinations for auto-switch — deliberately not every possible
// on/off permutation, so it never lands on dead silence and always picks
// something that reads as an intentional mashup move. The two "classic"
// combos (one song's vocal over the other's instrumental) get a tunable
// extra weight (autoStemSwitch.classicWeight) on top of the baseline 1
// every other combo gets — see applyJumpPoint().
const AUTO_SWITCH_COMBOS = [
  { isClassic: true, combo: { aVocal: true, aInstrumental: false, bVocal: false, bInstrumental: true } }, // classic: A's vocal over B's beat
  { isClassic: true, combo: { aVocal: false, aInstrumental: true, bVocal: true, bInstrumental: false } }, // the reverse
  { isClassic: false, combo: { aVocal: true, aInstrumental: true, bVocal: false, bInstrumental: false } }, // Track A solo
  { isClassic: false, combo: { aVocal: false, aInstrumental: false, bVocal: true, bInstrumental: true } }, // Track B solo
  { isClassic: false, combo: { aVocal: true, aInstrumental: true, bVocal: true, bInstrumental: true } }, // full collision
  { isClassic: false, combo: { aVocal: true, aInstrumental: false, bVocal: true, bInstrumental: false } }, // both vocals, no beat
  { isClassic: false, combo: { aVocal: false, aInstrumental: true, bVocal: false, bInstrumental: true } }, // both instrumentals
];

/** Weighted random pick — `weightFn(item)` returns a non-negative weight. */
function weightedPick(items, weightFn) {
  const weights = items.map(weightFn);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1]; // floating-point edge case fallback
}

export class JukeboxEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;

    // { a: { vocal: AudioBuffer, instrumental: AudioBuffer }, b: {...} }
    this.buffers = { a: {}, b: {} };
    // { a: number[], b: number[] } beat onset times in seconds
    this.beatTimes = { a: [], b: [] };
    // { a: number, b: number } BPM, used for Beat Sync's rate calculation
    this.bpm = { a: null, b: null };

    // Persistent routing graph gain nodes: this.gainNodes.a.vocal, etc.
    this.gainNodes = { a: {}, b: {} };
    // Authoritative current mix — the engine owns this now (not React),
    // since auto-switch-stems changes it from inside here. getState()
    // reports it back out for the UI to mirror.
    this.activeMix = { a: { vocal: true, instrumental: true }, b: { vocal: false, instrumental: false } };

    // Each deck's own transport state — independent of the other deck.
    this.transports = {
      a: { beatIndex: 0, nextStartTime: 0 },
      b: { beatIndex: 0, nextStartTime: 0 },
    };

    // Per-slot list of {source, segmentGain, end} for in-flight/scheduled
    // segments — needed so seekTo() can fade out exactly what's currently
    // queued for that slot without touching the other slot at all.
    this.slotSources = { a: [], b: [] };

    // Beat Sync: playback rate per deck. Deck A is always the tempo
    // reference (rate 1); Deck B's rate is recomputed from the BPM ratio
    // whenever sync is toggled on or new tracks are loaded.
    this.beatSyncEnabled = false;
    this.rates = { a: 1, b: 1 };

    // Jump points (from lib/crossTrackMatrix.js — recomputed client-side
    // whenever the similarity threshold setting changes), used by auto-jump.
    this.jumpPoints = [];

    // Auto-jump's probability model is borrowed directly from the
    // Infinite Jukebox (musicmachinery.com/2012/11/26/tuning-the-infinite-jukebox):
    // probability starts at probabilityLow, climbs toward probabilityHigh
    // by rampUpSpeed% of the (high-low) range each checkpoint a jump ISN'T
    // taken, and resets to probabilityLow the moment one IS taken. Which
    // specific candidate gets taken, on top of that, is weighted by
    // score^scoreExponent — the Infinite Jukebox doesn't need this part
    // since it usually has at most one viable branch per beat; we have a
    // whole matrix of candidates, so "which one" is its own decision.
    this.autoJump = {
      enabled: false,
      everyNBeats: 16,
      minScore: 0.9,
      scoreExponent: 2,
      probabilityLow: 0.05,
      probabilityHigh: 0.6,
      rampUpSpeed: 40, // 0-100, matching the blog's slider scale (100 -> 10%/checkpoint)
    };
    this._currentBranchProbability = this.autoJump.probabilityLow;
    this._lastJumpScore = null;

    // No timer of its own — stems only ever switch as a side effect of a
    // jump (auto or manual), never independently. See applyJumpPoint().
    this.autoStemSwitch = { enabled: false, classicWeight: 3 };
    // Master clock for both auto-behaviors' cadence — counts Deck A's
    // forward-scheduled beats specifically (not affected by jumps/seeks),
    // so "every N beats" means elapsed real playback, not buffer position.
    this._beatCounter = 0;

    this._timer = null;
    this._listeners = new Set();
  }

  // -------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------

  /** Must be called from a user gesture (click) to satisfy autoplay policy. */
  ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1;
      this.masterGain.connect(this.ctx.destination);

      for (const slot of SLOTS) {
        for (const stem of STEMS) {
          const gain = this.ctx.createGain();
          gain.gain.value = this.activeMix[slot][stem] ? 1 : 0;
          gain.connect(this.masterGain);
          this.gainNodes[slot][stem] = gain;
        }
      }
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  async _decode(url) {
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    return this.ctx.decodeAudioData(arrayBuffer);
  }

  /**
   * @param {"a"|"b"} slot
   * @param {{vocalsUrl: string, instrumentalUrl: string, beatTimes: number[], bpm?: number}} data
   */
  async loadTrack(slot, { vocalsUrl, instrumentalUrl, beatTimes, bpm }) {
    this.ensureContext();
    const [vocal, instrumental] = await Promise.all([
      this._decode(vocalsUrl),
      this._decode(instrumentalUrl),
    ]);
    this.buffers[slot] = { vocal, instrumental };
    this.beatTimes[slot] = beatTimes;
    this.bpm[slot] = bpm ?? null;
    this._recomputeRates();
  }

  // -------------------------------------------------------------------
  // Mix controls (persistent routing graph — separate from transport position)
  // -------------------------------------------------------------------

  /** @param {"a"|"b"} slot @param {"vocal"|"instrumental"} stem @param {number} level 0..1 */
  setMix(slot, stem, level, rampSeconds = 0.05) {
    const gain = this.gainNodes[slot]?.[stem];
    if (!gain) return;
    const now = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(level, now + rampSeconds);
    this.activeMix[slot][stem] = level > 0;
    this._notify();
  }

  /** Switch which song's stems are audible (e.g. "Vocal A + Instrumental B" mashup toggles). */
  setActiveMix({ aVocal, aInstrumental, bVocal, bInstrumental }) {
    const targets = [
      ["a", "vocal", aVocal],
      ["a", "instrumental", aInstrumental],
      ["b", "vocal", bVocal],
      ["b", "instrumental", bInstrumental],
    ];
    for (const [slot, stem, on] of targets) {
      const gain = this.gainNodes[slot]?.[stem];
      if (!gain) continue;
      const now = this.ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(on ? 1 : 0, now + 0.05);
      this.activeMix[slot][stem] = Boolean(on);
    }
    this._notify();
  }

  // -------------------------------------------------------------------
  // Beat Sync (vari-speed beatmatching — shifts pitch, not pitch-corrected)
  // -------------------------------------------------------------------

  setBeatSync(enabled) {
    this.beatSyncEnabled = enabled;
    this._recomputeRates();
    this._notify();
  }

  _recomputeRates() {
    if (this.beatSyncEnabled && this.bpm.a && this.bpm.b) {
      this.rates = { a: 1, b: this.bpm.a / this.bpm.b };
    } else {
      this.rates = { a: 1, b: 1 };
    }
  }

  /** Deck B's current pitch shift from Beat Sync, as a +/- percentage, for display. */
  getPitchShiftPercent(slot) {
    return (this.rates[slot] - 1) * 100;
  }

  // -------------------------------------------------------------------
  // Jump points + auto-behaviors
  // -------------------------------------------------------------------

  /** jumpPoints: [{ beatA, beatB, score }] indices into beatTimes.a / beatTimes.b */
  setJumpPoints(jumpPoints) {
    this.jumpPoints = jumpPoints ?? [];
  }

  setAutoJump(partial = {}) {
    this.autoJump = { ...this.autoJump, ...partial };
    // Keep the live ramping value sane if the range itself just moved.
    this._currentBranchProbability = Math.min(
      Math.max(this._currentBranchProbability, this.autoJump.probabilityLow),
      this.autoJump.probabilityHigh
    );
  }

  setAutoStemSwitch(partial = {}) {
    this.autoStemSwitch = { ...this.autoStemSwitch, ...partial };
  }

  /** For a live "branch chance" readout in the UI. */
  getAutoJumpStatus() {
    return {
      currentProbabilityPercent: this._currentBranchProbability * 100,
      lastJumpScore: this._lastJumpScore,
    };
  }

  /**
   * Every `everyNBeats`: if there's at least one candidate above
   * `minScore`, roll against the current (ramping) probability. Take a
   * score-weighted-random candidate and reset the probability to its low
   * end on success; otherwise climb the probability toward its high end
   * by `rampUpSpeed`% of the range, ready to try again next checkpoint.
   */
  _maybeAutoJump() {
    const { enabled, everyNBeats, minScore, scoreExponent, probabilityLow, probabilityHigh, rampUpSpeed } =
      this.autoJump;
    if (!enabled) return;
    if (this._beatCounter % everyNBeats !== 0) return;

    const candidates = this.jumpPoints.filter((p) => p.score >= minScore);
    if (!candidates.length) return; // nothing available — don't ramp on an empty pool either

    if (Math.random() < this._currentBranchProbability) {
      const picked = weightedPick(candidates, (p) => p.score ** scoreExponent);
      this._lastJumpScore = picked.score;
      this._currentBranchProbability = probabilityLow;
      this.applyJumpPoint(picked);
    } else {
      // Per the blog: slider at 100 = +10 percentage points per checkpoint
      // a jump wasn't taken; slider at 50 = +5; linear in between. Flat
      // increment, not scaled by the probabilityLow..probabilityHigh
      // range width.
      const increment = (rampUpSpeed / 100) * 0.1;
      this._currentBranchProbability = Math.min(this._currentBranchProbability + increment, probabilityHigh);
    }
  }

  // -------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------

  /** Starts both decks running from beat 0, independently. */
  start() {
    this.ensureContext();
    const lead = this.ctx.currentTime + SEEK_LEAD_SECONDS;
    this.transports = {
      a: { beatIndex: 0, nextStartTime: lead },
      b: { beatIndex: 0, nextStartTime: lead },
    };
    this.slotSources = { a: [], b: [] };
    this._beatCounter = 0;
    this._currentBranchProbability = this.autoJump.probabilityLow;
    this._lastJumpScore = null;
    this._timer = setInterval(() => this._schedulerTick(), TICK_INTERVAL_MS);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    for (const slot of SLOTS) {
      for (const entry of this.slotSources[slot]) {
        try {
          entry.source.stop();
        } catch {
          /* already stopped */
        }
      }
    }
    this.slotSources = { a: [], b: [] };
  }

  /**
   * Jump deck `slot` to `beatIndex`, right now — completely free, not
   * limited to precomputed jump points. Whatever was already scheduled for
   * this slot gets faded out and cut short; the new position fades in;
   * normal forward playback continues from there. The OTHER slot is
   * completely untouched.
   *
   * @param {"a"|"b"} slot
   * @param {number} beatIndex
   */
  seekTo(slot, beatIndex) {
    if (!this.ctx) return;
    const beats = this.beatTimes[slot];
    if (!beats || beats.length < 2) return;

    const clamped = Math.max(0, Math.min(beatIndex, beats.length - 2));
    const now = this.ctx.currentTime + SEEK_LEAD_SECONDS;
    const rate = this.rates[slot] ?? 1;

    for (const entry of this.slotSources[slot]) {
      if (entry.end <= now) continue;
      try {
        entry.segmentGain.gain.cancelScheduledValues(now);
        entry.segmentGain.gain.setValueAtTime(entry.segmentGain.gain.value, now);
        entry.segmentGain.gain.linearRampToValueAtTime(0, now + CROSSFADE_SECONDS);
        entry.source.stop(now + CROSSFADE_SECONDS + 0.01);
      } catch {
        /* already stopped/ended between the check above and here */
      }
    }

    const { start, duration } = this._segmentBounds(slot, clamped);
    this._playSegment(slot, start, duration, now, CROSSFADE_SECONDS);

    this.transports[slot] = { beatIndex: clamped + 1, nextStartTime: now + duration / rate };
    this._notify();
  }

  /**
   * Convenience: seek both decks to a matched (beatA, beatB) pair at once.
   * If Auto Switch Stems is enabled, this is also the ONLY place stems
   * switch — there's no independent timer for it. Switching the mix at
   * the same moment as a position jump is what makes it read as one
   * deliberate mashup move instead of two unrelated random events.
   */
  applyJumpPoint({ beatA, beatB }) {
    this.seekTo("a", beatA);
    this.seekTo("b", beatB);
    if (this.autoStemSwitch.enabled) {
      const classicWeight = this.autoStemSwitch.classicWeight;
      const { combo } = weightedPick(AUTO_SWITCH_COMBOS, (c) => (c.isClassic ? classicWeight : 1));
      this.setActiveMix(combo);
    }
  }

  _schedulerTick() {
    if (!this.ctx) return;
    for (const slot of SLOTS) {
      const t = this.transports[slot];
      if (!t || !this.beatTimes[slot]?.length) continue;
      while (t.nextStartTime < this.ctx.currentTime + SCHEDULE_AHEAD_SECONDS) {
        this._scheduleForwardBeat(slot);
      }
    }
  }

  _segmentBounds(slot, beatIndex) {
    const beats = this.beatTimes[slot];
    const start = beats[beatIndex];
    const end = beats[beatIndex + 1] ?? start + 60 / 120; // fallback ~120bpm beat
    return { start, duration: end - start };
  }

  /** Schedules the next beat segment for `slot`, continuing forward from wherever it is. */
  _scheduleForwardBeat(slot) {
    const t = this.transports[slot];
    const { start, duration } = this._segmentBounds(slot, t.beatIndex);
    const rate = this.rates[slot] ?? 1;

    // Plain back-to-back scheduling, no fade: consecutive beats within the
    // same track are literally adjacent samples in the original recording,
    // so there's no discontinuity to mask. Fades are only for seekTo(),
    // which jumps to an unrelated point in the waveform.
    this._playSegment(slot, start, duration, t.nextStartTime, 0);

    t.beatIndex += 1;
    if (t.beatIndex >= this.beatTimes[slot].length - 1) t.beatIndex = 0; // loop the song
    t.nextStartTime += duration / rate;

    if (slot === "a") {
      this._beatCounter += 1;
      this._maybeAutoJump();
    }
    this._notify();
  }

  _playSegment(slot, offset, duration, when, fadeInDuration) {
    const rate = this.rates[slot] ?? 1;
    const effectiveDuration = duration / rate;

    for (const stem of STEMS) {
      const buffer = this.buffers[slot][stem];
      if (!buffer) continue;

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;

      const segmentGain = this.ctx.createGain();
      source.connect(segmentGain);
      segmentGain.connect(this.gainNodes[slot][stem]);

      if (fadeInDuration > 0) {
        segmentGain.gain.setValueAtTime(0, when);
        segmentGain.gain.linearRampToValueAtTime(1, when + fadeInDuration);
      } else {
        segmentGain.gain.setValueAtTime(1, when);
      }

      // start()'s duration argument is in the buffer's own time, unaffected
      // by playbackRate — but the real wall-clock time this occupies IS
      // affected, which is what stop()/our bookkeeping need to use.
      source.start(when, Math.max(offset, 0), duration);
      source.stop(when + effectiveDuration + CROSSFADE_SECONDS + 0.01);

      const entry = { source, segmentGain, end: when + effectiveDuration };
      source.onended = () => {
        try {
          source.disconnect();
          segmentGain.disconnect();
        } catch {
          /* no-op */
        }
        this.slotSources[slot] = this.slotSources[slot].filter((e) => e !== entry);
      };
      this.slotSources[slot].push(entry);
    }
  }

  // -------------------------------------------------------------------
  // UI sync (no React here — see hooks/useAudioSync.js)
  // -------------------------------------------------------------------

  /** Best-effort current playhead, in *buffer* seconds, for the given deck. */
  getPlayheadSeconds(slot) {
    if (!this.ctx) return 0;
    const t = this.transports[slot];
    if (!t) return 0;
    const rate = this.rates[slot] ?? 1;
    const { start, duration } = this._segmentBounds(slot, Math.max(t.beatIndex - 1, 0));
    const effectiveDuration = duration / rate;
    const segmentStartTime = t.nextStartTime - effectiveDuration;
    const intoSegmentWallClock = Math.max(this.ctx.currentTime - segmentStartTime, 0);
    // Wall-clock elapsed time maps back to MORE buffer-time when rate > 1
    // (playing faster) and LESS when rate < 1 — multiply, not divide.
    return start + intoSegmentWallClock * rate;
  }

  getState() {
    return {
      a: { beatIndex: this.transports.a.beatIndex },
      b: { beatIndex: this.transports.b.beatIndex },
      mix: {
        a: { ...this.activeMix.a },
        b: { ...this.activeMix.b },
      },
      autoJump: this.getAutoJumpStatus(),
      isRunning: Boolean(this._timer),
    };
  }

  onTick(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify() {
    for (const listener of this._listeners) listener(this.getState());
  }
}
