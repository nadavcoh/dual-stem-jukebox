"use client";

import { useEffect, useRef } from "react";

/**
 * Drives CSS variables on a DOM node every animation frame, reading
 * directly from the audio engine's own clock (engineRef.current.getPlayheadSeconds()).
 *
 * Deliberately bypasses React state. Updating state 60x/sec for a value most
 * of the tree never needs to read through props would mean 60 re-renders/sec
 * of components that don't care. A ref + CSS variable is a side-channel
 * straight from the audio engine to the pixel — React never re-renders for
 * it, the browser's compositor just repaints the bound style.
 *
 * Usage:
 *   const playheadRef = useAudioSync(engineRef, totalDurationSeconds);
 *   <div ref={playheadRef}>
 *     <div style={{ left: "calc(var(--playhead-pct, 0) * 100%)" }} />
 *   </div>
 */
export function useAudioSync(engineRef, totalDurationSeconds) {
  const elementRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    function tick() {
      const engine = engineRef.current;
      const el = elementRef.current;

      if (engine && el) {
        const seconds = engine.getPlayheadSeconds();
        const pct = totalDurationSeconds > 0 ? Math.min(seconds / totalDurationSeconds, 1) : 0;
        el.style.setProperty("--playhead-pct", pct.toFixed(4));
        el.style.setProperty("--playhead-seconds", seconds.toFixed(3));
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [engineRef, totalDurationSeconds]);

  return elementRef;
}
