"use client";

import { useEffect, useRef, useState } from "react";

// Dark indigo -> magenta -> amber -> warm white. Reads as a thermal map:
// the brighter the cell, the more harmonically/rhythmically compatible
// that (Track A beat, Track B beat) pair is.
const COLOR_STOPS = [
  [12, 10, 30],
  [168, 41, 130],
  [255, 180, 60],
  [255, 244, 214],
];

function similarityColor(value) {
  const v = Math.max(0, Math.min(1, value));
  const t = v * (COLOR_STOPS.length - 1);
  const i = Math.floor(t);
  const f = t - i;
  const a = COLOR_STOPS[Math.min(i, COLOR_STOPS.length - 1)];
  const b = COLOR_STOPS[Math.min(i + 1, COLOR_STOPS.length - 1)];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}

/** Binary search: the beat index whose segment contains timeSeconds. */
function beatIndexAtTime(beatTimes, timeSeconds) {
  if (!beatTimes?.length) return 0;
  let lo = 0;
  let hi = beatTimes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beatTimes[mid] <= timeSeconds) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "—:—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

/** Nearest jump-point marker to a (row, col) grid cell, within `tolerance` cells — for edit-mode hit-testing. */
function findNearestMarker(jumpPoints, binRows, binCols, row, col, tolerance = 1.5) {
  let best = null;
  let bestDist = Infinity;
  for (const p of jumpPoints) {
    const pr = Math.floor(p.beatA / binRows);
    const pc = Math.floor(p.beatB / binCols);
    const dist = Math.hypot(pr - row, pc - col);
    if (dist <= tolerance && dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

const CANVAS_SIZE = 360; // logical px, square canvas — scaled to fit via CSS

/**
 * @param {{
 *   heatmap: { data: number[][], rows: number, cols: number, binRows: number, binCols: number },
 *   jumpPoints: Array<{beatA: number, beatB: number, score: number}>,
 *   beatTimesA: number[], beatTimesB: number[],
 *   engineRef: { current: import("@/lib/audioEngine").JukeboxEngine | null },
 *   onApplyJump: (jump: {beatA: number, beatB: number}) => void,
 *   onDeletePoint: (jump: {beatA: number, beatB: number}) => void,
 * }} props
 *
 * X axis = Track B beats, Y axis = Track A beats. Click anywhere to jump
 * both decks there directly — the green dots (precomputed jump points) are
 * a guide to where the algorithm found strong matches, not a restriction.
 * Toggle "Edit" to curate that guide instead: click a green dot to delete
 * it from the candidate pool (auto-jump and the dot itself both respect
 * that), inspired by the Infinite Jukebox's "click a branch, hit delete"
 * tuning feature.
 */
export default function JumpMatrix({
  heatmap,
  jumpPoints,
  beatTimesA,
  beatTimesB,
  engineRef,
  onApplyJump,
  onDeletePoint,
}) {
  const canvasRef = useRef(null);
  const offscreenRef = useRef(null);
  const rafRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [editMode, setEditMode] = useState(false);

  const { data, rows, cols, binRows, binCols } = heatmap;

  // Static heatmap + jump-point markers, rendered once into an offscreen
  // canvas and just blitted every frame below — redrawing 25k+ cells at
  // 60fps for no reason would be wasteful.
  useEffect(() => {
    const off = document.createElement("canvas");
    off.width = CANVAS_SIZE;
    off.height = CANVAS_SIZE;
    const ctx = off.getContext("2d");
    const cellW = CANVAS_SIZE / cols;
    const cellH = CANVAS_SIZE / rows;

    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        ctx.fillStyle = similarityColor(data[i][j]);
        ctx.fillRect(j * cellW, i * cellH, Math.ceil(cellW), Math.ceil(cellH));
      }
    }

    ctx.save();
    for (const p of jumpPoints) {
      const j = Math.min(Math.floor(p.beatB / binCols), cols - 1);
      const i = Math.min(Math.floor(p.beatA / binRows), rows - 1);
      ctx.beginPath();
      ctx.arc((j + 0.5) * cellW, (i + 0.5) * cellH, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(124,255,178,0.9)";
      ctx.fill();
    }
    ctx.restore();

    offscreenRef.current = off;
  }, [data, rows, cols, binRows, binCols, jumpPoints]);

  // Live crosshair showing where each deck's playhead actually is right
  // now in this 2D space — reads the engine directly every frame, no
  // React state, same philosophy as useAudioSync.
  useEffect(() => {
    function tick() {
      const canvas = canvasRef.current;
      const off = offscreenRef.current;
      const engine = engineRef.current;
      if (canvas && off) {
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        ctx.drawImage(off, 0, 0);

        if (engine) {
          const beatA = beatIndexAtTime(beatTimesA, engine.getPlayheadSeconds("a"));
          const beatB = beatIndexAtTime(beatTimesB, engine.getPlayheadSeconds("b"));
          const x = ((Math.floor(beatB / binCols) + 0.5) / cols) * CANVAS_SIZE;
          const y = ((Math.floor(beatA / binRows) + 0.5) / rows) * CANVAS_SIZE;

          ctx.strokeStyle = "rgba(94,212,255,0.85)"; // cyan — deck A row
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(CANVAS_SIZE, y);
          ctx.stroke();

          ctx.strokeStyle = "rgba(255,107,94,0.85)"; // coral — deck B column
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, CANVAS_SIZE);
          ctx.stroke();

          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [engineRef, beatTimesA, beatTimesB, binRows, binCols, rows, cols]);

  function cellFromEvent(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * CANVAS_SIZE;
    const py = ((e.clientY - rect.top) / rect.height) * CANVAS_SIZE;
    const col = Math.min(Math.max(Math.floor((px / CANVAS_SIZE) * cols), 0), cols - 1);
    const row = Math.min(Math.max(Math.floor((py / CANVAS_SIZE) * rows), 0), rows - 1);
    const beatA = Math.min(row * binRows + Math.floor(binRows / 2), beatTimesA.length - 2);
    const beatB = Math.min(col * binCols + Math.floor(binCols / 2), beatTimesB.length - 2);
    return { row, col, beatA, beatB, value: data[row]?.[col] ?? 0 };
  }

  function handleClick(e) {
    const cell = cellFromEvent(e);
    if (editMode) {
      const marker = findNearestMarker(jumpPoints, binRows, binCols, cell.row, cell.col);
      if (marker) onDeletePoint(marker);
      return;
    }
    onApplyJump(cell);
  }

  function handleMouseMove(e) {
    setHover(cellFromEvent(e));
  }

  const hoveredMarker =
    editMode && hover ? findNearestMarker(jumpPoints, binRows, binCols, hover.row, hover.col) : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-stone-500">Jump matrix</span>
        <button
          onClick={() => setEditMode((v) => !v)}
          className={`rounded-full border px-2.5 py-0.5 text-[10px] font-mono transition-colors ${
            editMode
              ? "border-red-400/60 bg-red-400/10 text-red-300"
              : "border-stone-700 text-stone-500"
          }`}
        >
          {editMode ? "Editing — click a dot to remove it" : "Edit"}
        </button>
      </div>

      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
        className={`w-full rounded-md border ${
          editMode ? "cursor-pointer border-red-400/40" : "cursor-crosshair border-stone-800"
        }`}
        style={{ aspectRatio: "1 / 1" }}
      />

      <div className="flex items-center justify-between font-mono text-[10px] text-stone-500">
        <span>Track A (rows) ↕</span>
        <div className="flex items-center gap-1">
          <span>low</span>
          <span className="h-2 w-16 rounded-full bg-gradient-to-r from-[rgb(12,10,30)] via-[rgb(168,41,130)] to-[rgb(255,244,214)]" />
          <span>high</span>
        </div>
        <span>Track B (cols) ↔</span>
      </div>

      <p className="h-4 text-center font-mono text-[11px] text-stone-400">
        {editMode
          ? hoveredMarker
            ? `Point at A ${formatTime(beatTimesA[hoveredMarker.beatA])} · B ${formatTime(beatTimesB[hoveredMarker.beatB])} (score ${hoveredMarker.score.toFixed(2)}) — click to remove`
            : "Hover a green dot, then click to remove it from the candidate pool"
          : hover
            ? `A ${formatTime(beatTimesA[hover.beatA])} · B ${formatTime(beatTimesB[hover.beatB])} · similarity ${hover.value.toFixed(2)} — click to jump both decks here`
            : `${jumpPoints.length} jump point${jumpPoints.length === 1 ? "" : "s"} marked in green`}
      </p>
    </div>
  );
}
