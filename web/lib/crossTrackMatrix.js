/**
 * The Python worker stores, per track, beat-synchronous chroma+MFCC
 * features for that track's own vocal and instrumental stems (see
 * worker/worker.py -> matrix_payload). That's enough to *also* build the
 * thing the player actually needs: a map of beats in Track A that line up
 * harmonically/rhythmically with beats in Track B, so the engine knows
 * where it's safe to jump between songs.
 *
 * We compare the two tracks' *instrumental* stems (drums/bass/harmony
 * survive source separation far more cleanly than vocals, so they're the
 * more reliable signal for cross-track matching).
 */

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(a) {
  return Math.sqrt(dot(a, a)) || 1;
}

/** Cosine similarity between every row of A and every row of B. */
export function cosineSimilarityMatrix(A, B) {
  const normsA = A.map(norm);
  const normsB = B.map(norm);
  const result = new Array(A.length);
  for (let i = 0; i < A.length; i++) {
    const row = new Array(B.length);
    for (let j = 0; j < B.length; j++) {
      row[j] = dot(A[i], B[j]) / (normsA[i] * normsB[j]);
    }
    result[i] = row;
  }
  return result;
}

/**
 * Mirrors worker.py's find_jump_points(): keep only similarity peaks that
 * are part of a short diagonal run of high similarity (i.e. the match holds
 * up for a few beats in either direction), which is what makes a jump there
 * sound musically coherent rather than a one-frame coincidence.
 */
export function findDiagonalJumpPoints(
  similarity,
  {
    peakThreshold = 0.9,
    neighborThreshold = 0.82,
    neighborRadius = 2,
    minNeighborHits = 3,
    maxPoints = 200,
  } = {}
) {
  const n = similarity.length;
  const m = n > 0 ? similarity[0].length : 0;
  const candidates = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (similarity[i][j] >= peakThreshold) candidates.push([i, j]);
    }
  }

  const points = [];
  for (const [i, j] of candidates) {
    let hits = 0;
    let checks = 0;
    for (let k = -neighborRadius; k <= neighborRadius; k++) {
      if (k === 0) continue;
      const ni = i + k;
      const nj = j + k;
      if (ni >= 0 && ni < n && nj >= 0 && nj < m) {
        checks++;
        if (similarity[ni][nj] >= neighborThreshold) hits++;
      }
    }
    if (checks >= minNeighborHits && hits >= minNeighborHits) {
      points.push({ beatA: i, beatB: j, score: similarity[i][j] });
    }
  }

  points.sort((a, b) => b.score - a.score);

  const kept = [];
  for (const p of points) {
    const isDuplicate = kept.some(
      (k) => Math.abs(p.beatA - k.beatA) <= 1 && Math.abs(p.beatB - k.beatB) <= 1
    );
    if (isDuplicate) continue;
    kept.push(p);
    if (kept.length >= maxPoints) break;
  }
  return kept;
}

/**
 * Reduces a similarity matrix to at most maxSize x maxSize cells via *max*
 * pooling — keep the strongest value in each bin — so the heatmap payload
 * stays a reasonable size regardless of song length, while still showing
 * where the bright (high-similarity) spots are. Averaging would wash out
 * exactly the sparse peaks that matter most here; max-pooling preserves them.
 *
 * @param {number[][]} matrix
 * @param {number} maxSize
 * @returns {{ data: number[][], rows: number, cols: number, binRows: number, binCols: number }}
 */
export function downsampleMatrix(matrix, maxSize = 160) {
  const n = matrix.length;
  const m = n > 0 ? matrix[0].length : 0;

  if (n <= maxSize && m <= maxSize) {
    return { data: matrix, rows: n, cols: m, binRows: 1, binCols: 1 };
  }

  const rows = Math.min(n, maxSize);
  const cols = Math.min(m, maxSize);
  const binRows = Math.ceil(n / rows);
  const binCols = Math.ceil(m / cols);

  const data = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < n; i++) {
    const ri = Math.min(Math.floor(i / binRows), rows - 1);
    const row = matrix[i];
    const outRow = data[ri];
    for (let j = 0; j < m; j++) {
      const rj = Math.min(Math.floor(j / binCols), cols - 1);
      if (row[j] > outRow[rj]) outRow[rj] = row[j];
    }
  }
  return { data, rows, cols, binRows, binCols };
}

/**
 * Maps diagonal-filter results computed against a *downsampled* heatmap
 * back into approximate real beat indices, using the bin size recorded by
 * downsampleMatrix(). Lands on the center beat of each bin — some
 * precision loss is inherent (the heatmap was already downsampled for
 * display), consistent with everywhere else this data is used.
 */
function binPointsToBeatIndices(points, beatTimesA, beatTimesB, binRows, binCols) {
  return points.map((p) => {
    const beatA = Math.min(p.beatA * binRows + Math.floor(binRows / 2), beatTimesA.length - 2);
    const beatB = Math.min(p.beatB * binCols + Math.floor(binCols / 2), beatTimesB.length - 2);
    return { beatA, beatB, score: p.score, timeA: beatTimesA[beatA], timeB: beatTimesB[beatB] };
  });
}

/**
 * Recomputes the jump-point list live, from the heatmap, at whatever
 * threshold the user currently has tuned — this is what `findDiagonalJumpPoints`
 * was always meant to be called with dynamically, rather than once at a
 * fixed default. Cheap enough (heatmap is capped at 160x160) to call on
 * every settings change.
 *
 * @param {{ data: number[][], binRows: number, binCols: number }} heatmap
 * @param {number[]} beatTimesA
 * @param {number[]} beatTimesB
 * @param {{ peakThreshold?: number, neighborThreshold?: number, neighborRadius?: number, minNeighborHits?: number }} [tuning]
 */
export function recomputeJumpPointsFromHeatmap(heatmap, beatTimesA, beatTimesB, tuning = {}) {
  const peakThreshold = tuning.peakThreshold ?? 0.9;
  const raw = findDiagonalJumpPoints(heatmap.data, {
    peakThreshold,
    // Neighbor threshold trails the main slider by a fixed margin rather
    // than being its own control — keeps the settings panel to one
    // primary "how strict" knob instead of forcing the user to understand
    // the diagonal-filter's internals to get a sane result.
    neighborThreshold: tuning.neighborThreshold ?? Math.max(peakThreshold - 0.08, 0.5),
    neighborRadius: tuning.neighborRadius ?? 2,
    minNeighborHits: tuning.minNeighborHits ?? 3,
    maxPoints: 300,
  });
  return binPointsToBeatIndices(raw, beatTimesA, beatTimesB, heatmap.binRows, heatmap.binCols);
}

/**
 * @param {object} matrixA parsed matrix.json for Track A
 * @param {object} matrixB parsed matrix.json for Track B
 * @param {{ maxHeatmapSize?: number }} [options]
 * @returns {{
 *   beatTimesA: number[], beatTimesB: number[],
 *   bpmA: number, bpmB: number,
 *   heatmap: { data: number[][], rows: number, cols: number, binRows: number, binCols: number },
 * }}
 *
 * No `jumpPoints` here anymore on purpose — they're now always derived
 * client-side via recomputeJumpPointsFromHeatmap(), parameterized by
 * whatever the user has tuned in the settings panel. Computing a fixed
 * list here too would just be a second, inconsistent default that a
 * "similarity threshold" slider couldn't actually move past.
 */
export function buildCrossTrackJumpMap(matrixA, matrixB, { maxHeatmapSize = 160 } = {}) {
  const similarity = cosineSimilarityMatrix(
    matrixA.instrumental.features,
    matrixB.instrumental.features
  );

  const beatTimesA = matrixA.instrumental.beat_times;
  const beatTimesB = matrixB.instrumental.beat_times;
  const heatmap = downsampleMatrix(similarity, maxHeatmapSize);

  return {
    beatTimesA,
    beatTimesB,
    bpmA: matrixA.bpm,
    bpmB: matrixB.bpm,
    heatmap,
  };
}
