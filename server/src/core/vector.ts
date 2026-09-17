// ============================================================================
// M29: VECTOR MATH — similarity & distance untuk vector search
//
// Pure JS implementation (node:sqlite belum stabil mendukung loadExtension
// untuk binary native sqlite-vec di semua platform). Desain API identik
// dengan sqlite-vec — swap ke native saat tersedia = zero route change.
//
// Untuk < 50K vectors × 384-1536 dims: brute-force scan ~10-100ms di Node.
// Production scale (100K+): document swap ke sqlite-vec / ANN index.
// ============================================================================

/** Validasi: array of finite numbers, panjang sesuai dimensions. */
export function validateVector(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value)) return [];
  if (dimensions > 0 && value.length !== dimensions) return [];
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const n = Number(value[i]);
    if (!Number.isFinite(n)) return [];
    out[i] = n;
  }
  return out;
}

/**
 * Cosine similarity ∈ [-1, 1].
 * 1 = identik arah, 0 = ortogonal, -1 = berlawanan.
 * Formula: dot(a,b) / (||a|| × ||b||)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0; // zero vector → ortogonal (convention)
  return dot / denom;
}

/**
 * Euclidean distance (L2) ∈ [0, ∞).
 * 0 = identik. Lebih kecil = lebih mirip.
 */
export function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/** Normalisasi L2: ||v|| = 1. Cosine similarity = dot product setelah normalize. */
export function normalizeVector(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) return v; // zero vector — biarkan
  return v.map((x) => x / norm);
}

/** Dot product (berguna utk vektor sudah ternormalisasi). */
export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export type DistanceMetric = 'cosine' | 'l2';

/** Skor kesamaan: lebih tinggi = lebih mirip (konsisten utk ranking top-k). */
export function similarityScore(
  a: number[],
  b: number[],
  metric: DistanceMetric = 'cosine'
): number {
  if (metric === 'cosine') return cosineSimilarity(a, b);
  // L2: konversi ke "skor" — 1/(1+distance) agar higher=better
  return 1 / (1 + euclideanDistance(a, b));
}
