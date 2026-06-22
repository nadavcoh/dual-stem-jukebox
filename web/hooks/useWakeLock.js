"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Keeps the screen awake while `active` is true. Browsers release a wake
 * lock automatically whenever the tab is backgrounded (switching apps,
 * locking the phone manually, etc.) — so this also re-acquires it on
 * `visibilitychange` if `active` is still true when the tab comes back,
 * since otherwise a quick app-switch during playback would silently leave
 * the lock dropped for the rest of the session.
 *
 * Not supported in every browser (notably older iOS Safari) — fails
 * silently and reports `supported: false` rather than throwing, since this
 * is a nice-to-have, not something playback should ever depend on.
 *
 * @param {boolean} active
 * @returns {{ supported: boolean, locked: boolean }}
 */
export function useWakeLock(active) {
  const lockRef = useRef(null);
  const [state, setState] = useState({
    supported: typeof navigator !== "undefined" && "wakeLock" in navigator,
    locked: false,
  });

  useEffect(() => {
    if (!state.supported) return;

    let cancelled = false;

    async function acquire() {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          // `active` flipped false (or we unmounted) while the request was
          // in flight — release immediately rather than holding it.
          lock.release().catch(() => {});
          return;
        }
        lockRef.current = lock;
        lock.addEventListener("release", () => {
          setState((s) => ({ ...s, locked: false }));
        });
        setState((s) => ({ ...s, locked: true }));
      } catch {
        // Permission denied, battery saver mode, etc. — just stay unlocked.
        setState((s) => ({ ...s, locked: false }));
      }
    }

    function release() {
      lockRef.current?.release().catch(() => {});
      lockRef.current = null;
      setState((s) => ({ ...s, locked: false }));
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && active && !lockRef.current) {
        acquire();
      }
    }

    if (active) {
      acquire();
      document.addEventListener("visibilitychange", handleVisibilityChange);
    } else {
      release();
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, state.supported]);

  return state;
}
