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
 * other — there's no single "active" deck anymore. What's actually
 * *audible* (vocal/instrumental, A/B) is a separate concern, controlled by
 * the persistent routing-graph gain nodes below; transport position and
 * audibility don't have to agree, by design — that's what lets you e.g.
 * scrub deck B around while only deck A is currently audible, to line up
 * your next move before committing to it.
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
 * setInterval clock itself — which is what keeps everything sample-accurate
 * regardless of UI-thread jitter.
 */

const SCHEDULE_AHEAD_SECONDS = 0.1;
const TICK_INTERVAL_MS = 25;
const CROSSFADE_SECONDS = 0.02; // 20ms
const SEEK_LEAD_SECONDS = 0.05; // safety margin so a seek never schedules in the past

const SLOTS = ["a", "b"];
const STEMS = ["vocal", "instrumental"];

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

    // Each deck's own transport state — independent of the other deck.
    this.transports = {
      a: { beatIndex: 0, nextStartTime: 0 },
      b: { beatIndex: 0, nextStartTime: 0 },
    };

    // Per-slot list of {source, segmentGain, end} for in-flight/scheduled
    // segments — needed so seekTo() can fade out exactly what's currently
    // queued for that slot without touching the other slot at all.
    this.slotSources = { a: [], b: [] };

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
          // Sensible starting point: Track A fully audible, Track B muted.
          // JukeboxPlayer calls setActiveMix() right after load with the
          // user's actual choice — this is just the value in the brief
          // window before that.
          gain.gain.value = slot === "a" ? 1 : 0;
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
  }

  /** Switch which song's stems are audible (e.g. "Vocal A + Instrumental B" mashup toggles). */
  setActiveMix({ aVocal, aInstrumental, bVocal, bInstrumental }) {
    this.setMix("a", "vocal", aVocal ? 1 : 0);
    this.setMix("a", "instrumental", aInstrumental ? 1 : 0);
    this.setMix("b", "vocal", bVocal ? 1 : 0);
    this.setMix("b", "instrumental", bInstrumental ? 1 : 0);
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

    // Fade out + cut short anything already sounding/queued for this slot
    // that would otherwise still be playing at `now`. Already-finished
    // segments are left alone (they're already disconnected via onended).
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

    this.transports[slot] = { beatIndex: clamped + 1, nextStartTime: now + duration };
    this._notify();
  }

  /** Convenience: seek both decks to a matched (beatA, beatB) pair at once. */
  applyJumpPoint({ beatA, beatB }) {
    this.seekTo("a", beatA);
    this.seekTo("b", beatB);
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

    // Plain back-to-back scheduling, no fade: consecutive beats within the
    // same track are literally adjacent samples in the original recording,
    // so there's no discontinuity to mask. Fades are only for seekTo(),
    // which jumps to an unrelated point in the waveform.
    this._playSegment(slot, start, duration, t.nextStartTime, 0);

    t.beatIndex += 1;
    if (t.beatIndex >= this.beatTimes[slot].length - 1) t.beatIndex = 0; // loop the song
    t.nextStartTime += duration;
    this._notify();
  }

  _playSegment(slot, offset, duration, when, fadeInDuration) {
    for (const stem of STEMS) {
      const buffer = this.buffers[slot][stem];
      if (!buffer) continue;

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;

      const segmentGain = this.ctx.createGain();
      source.connect(segmentGain);
      segmentGain.connect(this.gainNodes[slot][stem]);

      if (fadeInDuration > 0) {
        segmentGain.gain.setValueAtTime(0, when);
        segmentGain.gain.linearRampToValueAtTime(1, when + fadeInDuration);
      } else {
        segmentGain.gain.setValueAtTime(1, when);
      }

      source.start(when, Math.max(offset, 0), duration);
      source.stop(when + duration + CROSSFADE_SECONDS + 0.01);

      const entry = { source, segmentGain, end: when + duration };
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

  /** Best-effort current playhead, in seconds, for the given deck. */
  getPlayheadSeconds(slot) {
    if (!this.ctx) return 0;
    const t = this.transports[slot];
    if (!t) return 0;
    // nextStartTime always points at this deck's *upcoming* boundary, so
    // the segment currently sounding on this deck started one beat
    // duration before it.
    const { start, duration } = this._segmentBounds(slot, Math.max(t.beatIndex - 1, 0));
    const segmentStartTime = t.nextStartTime - duration;
    const intoSegment = Math.max(this.ctx.currentTime - segmentStartTime, 0);
    return start + intoSegment;
  }

  getState() {
    return {
      a: { beatIndex: this.transports.a.beatIndex },
      b: { beatIndex: this.transports.b.beatIndex },
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
