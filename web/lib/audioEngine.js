/**
 * JukeboxEngine
 * =============
 * A sample-accurate dual-track beat player built directly on the Web Audio
 * API (no <audio> element — HTML5 audio's playback clock isn't precise
 * enough for beat-synchronous jumps).
 *
 * Routing graph (persistent for the life of the engine):
 *
 *   vocalA source ──> gain(vocalA) ─┐
 *   instA  source ──> gain(instA) ──┼──> masterGain ──> destination
 *   vocalB source ──> gain(vocalB) ─┤
 *   instB  source ──> gain(instB) ──┘
 *
 * gain(vocalA) etc. are the user-facing mix controls ("mute Track A's
 * vocals"). They are NOT what implements jump-point crossfades — each
 * scheduled beat segment gets its own short-lived AudioBufferSourceNode +
 * GainNode (created fresh, connected into the persistent stem gain above,
 * and discarded when it ends) so the engine can ramp exactly the two
 * segments that collide at a jump boundary, sample-accurately, with
 * linearRampToValueAtTime, without disturbing the user's mix levels.
 *
 * Scheduling follows the classic "lookahead scheduler" pattern (Chris
 * Wilson, "A Tale of Two Clocks"): a cheap setInterval polls how far we are
 * from the next beat boundary, and schedules audio events slightly ahead of
 * time using the audio clock (audioCtx.currentTime) — never the setInterval
 * clock itself — which is what keeps everything sample-accurate regardless
 * of UI-thread jitter.
 */

const SCHEDULE_AHEAD_SECONDS = 0.1;
const TICK_INTERVAL_MS = 25;
const CROSSFADE_SECONDS = 0.02; // 20ms

export class JukeboxEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;

    // { a: { vocal: AudioBuffer, instrumental: AudioBuffer }, b: {...} }
    this.buffers = { a: {}, b: {} };
    // { a: number[], b: number[] } beat onset times in seconds
    this.beatTimes = { a: [], b: [] };

    // Persistent routing graph gain nodes: this.gainNodes.a.vocal, etc.
    this.gainNodes = { a: {}, b: {} };

    // Map "fromSlot:fromBeat" -> [{ toSlot, toBeat, score }]
    this.jumpIndex = new Map();

    this.activeSlot = "a";
    this.activeBeatIndex = 0;
    this.nextBeatStartTime = 0;

    this.pendingManualJump = null; // { toSlot, toBeat } | null
    this.autoJump = { enabled: false, probability: 0.15, minScore: 0.92 };

    this._timer = null;
    this._activeSources = [];
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

      for (const slot of ["a", "b"]) {
        for (const stem of ["vocal", "instrumental"]) {
          const gain = this.ctx.createGain();
          gain.gain.value = slot === "a" ? 1 : 0; // start on Track A by default
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
   * @param {{vocalsUrl: string, instrumentalUrl: string, beatTimes: number[]}} data
   */
  async loadTrack(slot, { vocalsUrl, instrumentalUrl, beatTimes }) {
    this.ensureContext();
    const [vocal, instrumental] = await Promise.all([
      this._decode(vocalsUrl),
      this._decode(instrumentalUrl),
    ]);
    this.buffers[slot] = { vocal, instrumental };
    this.beatTimes[slot] = beatTimes;
  }

  /** jumpPoints: [{ beatA, beatB, score }] indices into beatTimes.a / beatTimes.b */
  setJumpPoints(jumpPoints) {
    this.jumpIndex.clear();
    for (const p of jumpPoints) {
      this._addJump("a", p.beatA, "b", p.beatB, p.score);
      this._addJump("b", p.beatB, "a", p.beatA, p.score);
    }
  }

  _addJump(fromSlot, fromBeat, toSlot, toBeat, score) {
    const key = `${fromSlot}:${fromBeat}`;
    const list = this.jumpIndex.get(key) ?? [];
    list.push({ toSlot, toBeat, score });
    this.jumpIndex.set(key, list);
  }

  // -------------------------------------------------------------------
  // Mix controls (persistent routing graph — NOT the jump crossfade path)
  // -------------------------------------------------------------------

  /** @param {"a"|"b"} slot @param {"vocal"|"instrumental"} stem @param {number} level 0..1 */
  setMix(slot, stem, level, rampSeconds = 0.05) {
    const gain = this.gainNodes[slot]?.[stem];
    if (!gain) return;
    const now = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(level, now + rampSeconds);
  }

  /** Switch which song's stems are audible (e.g. "Vocal A + Instrumental B" mashup toggles). */
  setActiveMix({ aVocal, aInstrumental, bVocal, bInstrumental }) {
    this.setMix("a", "vocal", aVocal ? 1 : 0);
    this.setMix("a", "instrumental", aInstrumental ? 1 : 0);
    this.setMix("b", "vocal", bVocal ? 1 : 0);
    this.setMix("b", "instrumental", bInstrumental ? 1 : 0);
  }

  /** Queue a jump to a specific (slot, beat) — taken unconditionally at the next beat boundary. */
  requestJump(toSlot, toBeat) {
    this.pendingManualJump = { toSlot, toBeat };
  }

  setAutoJump(enabled, probability = 0.15, minScore = 0.92) {
    this.autoJump = { enabled, probability, minScore };
  }

  // -------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------

  start(slot = "a", beatIndex = 0) {
    this.ensureContext();
    this.activeSlot = slot;
    this.activeBeatIndex = beatIndex;
    this.nextBeatStartTime = this.ctx.currentTime + 0.05;
    this._timer = setInterval(() => this._schedulerTick(), TICK_INTERVAL_MS);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    for (const source of this._activeSources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this._activeSources = [];
  }

  _schedulerTick() {
    if (!this.ctx) return;
    while (this.nextBeatStartTime < this.ctx.currentTime + SCHEDULE_AHEAD_SECONDS) {
      this._scheduleNextBeat();
    }
  }

  _resolveJump(slot, beatIndex) {
    if (this.pendingManualJump) {
      // A manual jump is a deliberate user action ("send me to this exact
      // point in the other song") — honor it on the very next beat
      // boundary rather than requiring the *current* beat to happen to be
      // one of the precomputed matches.
      const jump = this.pendingManualJump;
      this.pendingManualJump = null;
      return jump;
    }
    if (this.autoJump.enabled) {
      // Auto-jump, by contrast, should only ever take precomputed,
      // validated pairs anchored to the current beat — this is what keeps
      // it sounding musically justified rather than random.
      const candidates = (this.jumpIndex.get(`${slot}:${beatIndex}`) ?? []).filter(
        (c) => c.score >= this.autoJump.minScore
      );
      if (candidates.length && Math.random() < this.autoJump.probability) {
        return candidates[Math.floor(Math.random() * candidates.length)];
      }
    }
    return null;
  }

  _segmentBounds(slot, beatIndex) {
    const beats = this.beatTimes[slot];
    const start = beats[beatIndex];
    const end = beats[beatIndex + 1] ?? start + 60 / 120; // fallback ~120bpm beat
    return { start, duration: end - start };
  }

  _scheduleNextBeat() {
    const slot = this.activeSlot;
    const beatIndex = this.activeBeatIndex;
    const when = this.nextBeatStartTime;
    const { start, duration } = this._segmentBounds(slot, beatIndex);

    const jump = this._resolveJump(slot, beatIndex);

    if (jump) {
      // Outgoing segment: play normally, then fade out across the boundary.
      this._playSegment(slot, start, duration + CROSSFADE_SECONDS, when, {
        fadeOutAt: when + duration,
        fadeOutDuration: CROSSFADE_SECONDS,
      });

      // Incoming segment: starts exactly at the boundary, fades in.
      const { start: targetStart, duration: targetDuration } = this._segmentBounds(
        jump.toSlot,
        jump.toBeat
      );
      this._playSegment(jump.toSlot, targetStart, targetDuration, when, {
        fadeInDuration: CROSSFADE_SECONDS,
      });

      this.activeSlot = jump.toSlot;
      this.activeBeatIndex = jump.toBeat + 1;
    } else {
      this._playSegment(slot, start, duration, when, {});
      this.activeBeatIndex = beatIndex + 1;
      if (this.activeBeatIndex >= this.beatTimes[slot].length - 1) {
        this.activeBeatIndex = 0; // loop the song
      }
    }

    this.nextBeatStartTime = when + duration;
    this._notify();
  }

  _playSegment(slot, offset, duration, when, { fadeInDuration, fadeOutAt, fadeOutDuration }) {
    for (const stem of ["vocal", "instrumental"]) {
      const buffer = this.buffers[slot][stem];
      if (!buffer) continue;

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;

      const segmentGain = this.ctx.createGain();
      source.connect(segmentGain);
      segmentGain.connect(this.gainNodes[slot][stem]);

      if (fadeInDuration) {
        segmentGain.gain.setValueAtTime(0, when);
        segmentGain.gain.linearRampToValueAtTime(1, when + fadeInDuration);
      } else {
        segmentGain.gain.setValueAtTime(1, when);
      }
      if (fadeOutAt != null) {
        segmentGain.gain.setValueAtTime(1, fadeOutAt);
        segmentGain.gain.linearRampToValueAtTime(0, fadeOutAt + fadeOutDuration);
      }

      const stopAt = when + duration + (fadeOutDuration ?? 0) + 0.005;
      source.start(when, Math.max(offset, 0), duration);
      source.stop(stopAt);
      source.onended = () => {
        try {
          source.disconnect();
          segmentGain.disconnect();
        } catch {
          /* no-op */
        }
        this._activeSources = this._activeSources.filter((s) => s !== source);
      };
      this._activeSources.push(source);
    }
  }

  // -------------------------------------------------------------------
  // UI sync (no React here — see hooks/useAudioSync.js)
  // -------------------------------------------------------------------

  /** Best-effort current playhead, in seconds, along whichever slot is active. */
  getPlayheadSeconds() {
    if (!this.ctx) return 0;
    // nextBeatStartTime always points at the *upcoming* boundary, so the
    // segment currently sounding started one beat duration before it.
    const { start, duration } = this._segmentBounds(
      this.activeSlot,
      Math.max(this.activeBeatIndex - 1, 0)
    );
    const segmentStartTime = this.nextBeatStartTime - duration;
    const intoSegment = Math.max(this.ctx.currentTime - segmentStartTime, 0);
    return start + intoSegment;
  }

  getState() {
    return {
      activeSlot: this.activeSlot,
      activeBeatIndex: this.activeBeatIndex,
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
