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
 * @param {object} matrixA parsed matrix.json for Track A
 * @param {object} matrixB parsed matrix.json for Track B
 * @returns {{ jumpPoints: Array, beatTimesA: number[], beatTimesB: number[], bpmA: number, bpmB: number }}
 */
export function buildCrossTrackJumpMap(matrixA, matrixB) {
  const similarity = cosineSimilarityMatrix(
    matrixA.instrumental.features,
    matrixB.instrumental.features
  );
  const rawPoints = findDiagonalJumpPoints(similarity);

  const beatTimesA = matrixA.instrumental.beat_times;
  const beatTimesB = matrixB.instrumental.beat_times;

  const jumpPoints = rawPoints.map((p) => ({
    beatA: p.beatA,
    beatB: p.beatB,
    score: p.score,
    timeA: beatTimesA[p.beatA],
    timeB: beatTimesB[p.beatB],
  }));

  return { jumpPoints, beatTimesA, beatTimesB, bpmA: matrixA.bpm, bpmB: matrixB.bpm };
}
