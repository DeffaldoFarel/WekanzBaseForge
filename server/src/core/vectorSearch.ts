// ============================================================================
// M29: VECTOR SEARCH ENGINE — brute-force scan + top-k ranking
//
// Strategi: SELECT semua record → parse vector dari JSON → hitung similarity
// → top-k (partial sort). Cukup untuk < 50K vectors × 1536 dims (~50-200ms).
//
// Untuk production scale (100K+):
//   1. sqlite-vec extension (vec0 virtual table + native SIMD)
//   2. ANN index (HNSW, IVF) via Faiss/Annoy
//   → API endpoint TIDAK BERUBAH — hanya internal engine yang diganti.
//
// Didukung:
//   - Pre-filter: hanya scan record yang lolos filter expression (M04)
//   - Threshold: minScore untuk memangkas hasil
//   - Multiple vector fields: pilih field mana yang dicari
//   - Metric: cosine (default) atau L2
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { getCollectionByName, type CollectionMeta } from './schema.js';
import { filterToSql, type RequestContext } from './query/sqlBuilder.js';
import { decideRule } from './rules.js';
import { validateVector, similarityScore, type DistanceMetric } from './vector.js';

export interface VectorSearchOptions {
  /** Query embedding vector (harus sama dimensions dengan field target) */
  vector: number[];
  /** Jumlah hasil teratas (default 10, max 100) */
  k?: number;
  /** Nama field vector yang dicari (default: field vector pertama di collection) */
  field?: string;
  /** Distance metric: 'cosine' (default) atau 'l2' */
  metric?: DistanceMetric;
  /** Minimum similarity score (0-1 untuk cosine; 0-1 untuk L2 score 1/(1+d)) */
  minScore?: number;
  /** Filter expression M04 untuk pre-filter (misal: "status = 'published'") */
  filter?: string;
  /** Request context untuk rules + filter dengan @request.auth */
  reqCtx?: RequestContext;
}

export interface VectorSearchResult {
  items: Array<{
    id: string;
    score: number;
    record: Record<string, unknown>;
  }>;
  totalSearched: number;
  vectorField: string;
  metric: DistanceMetric;
  durationMs: number;
}

function findVectorField(meta: CollectionMeta, fieldName?: string): string | null {
  const vectorFields = meta.fields.filter((f) => f.type === 'vector');
  if (vectorFields.length === 0) return null;
  if (fieldName) {
    const found = vectorFields.find((f) => f.name === fieldName);
    return found ? found.name : null;
  }
  return vectorFields[0].name; // default: first vector field
}

export function vectorSearch(
  db: DatabaseSync,
  collection: string,
  opts: VectorSearchOptions
): VectorSearchResult {
  const start = Date.now();
  const meta = getCollectionByName(db, collection);
  if (!meta) {
    throw new Error(`Collection '${collection}' not found`);
  }

  // ── Field vector target ──
  const vectorField = findVectorField(meta, opts.field);
  if (!vectorField) {
    throw new Error(
      opts.field
        ? `Field '${opts.field}' is not a vector field in collection '${collection}'`
        : `Collection '${collection}' has no vector fields`
    );
  }
  const fieldDef = meta.fields.find((f) => f.name === vectorField)!;
  const dimensions = fieldDef.options?.dimensions;

  // ── Validasi query vector ──
  const queryVector = validateVector(opts.vector, dimensions ?? 0);
  if (queryVector.length === 0) { // ⚠️ ![] === false di JS — WAJIB .length === 0
    throw new Error(
      dimensions
        ? `Query vector must be an array of ${dimensions} finite numbers`
        : 'Query vector must be an array of finite numbers'
    );
  }

  // ── Pre-filter (M04 expression → SQL WHERE) ──
  const k = Math.min(Math.max(opts.k ?? 10, 1), 100);
  const metric = opts.metric ?? 'cosine';
  const minScore = opts.minScore ?? -Infinity; // default: no threshold

  let whereSql = '';
  const params: unknown[] = [];

  // Rules: listRule dievaluasi seperti aggregate M19 (bocor info jika bypass)
  if (opts.reqCtx !== undefined) {
    const lRule = meta.rules.listRule ?? null;
    if (lRule === null) {
      return {
        items: [],
        totalSearched: 0,
        vectorField,
        metric,
        durationMs: Date.now() - start,
      };
    }
    if (lRule.trim() !== '') {
      const decided = decideRule(lRule, opts.reqCtx, meta.fields);
      if (decided.mode === 'filter' && decided.sql) {
        whereSql += ` AND (${decided.sql})`;
        params.push(...(decided.params ?? []));
      }
    }
  }

  if (opts.filter && opts.filter.trim()) {
    const parsed = filterToSql(opts.filter, meta.fields, opts.reqCtx);
    whereSql += ` AND (${parsed.where})`;
    params.push(...parsed.params);
  }

  // ── Scan: load records + parse vectors ──
  // ORDER BY created DESC — data terbaru lebih relevan (tie-breaker)
  const sql = `SELECT * FROM "${collection}" WHERE 1=1${whereSql} ORDER BY created DESC`;
  const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];

  // ── Score + top-k (partial selection sort — O(n) tanpa full sort) ──
  const candidates: Array<{ id: string; score: number; record: Record<string, unknown> }> = [];
  let totalSearched = 0;

  for (const row of rows) {
    const raw = row[vectorField];
    if (!raw) continue; // vector null/missing — skip

    // Parse dari JSON string (column TEXT) atau sudah array (edge: direct SQL)
    let vec: number[];
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        vec = Array.isArray(parsed) ? (parsed as number[]) : [];
      } catch {
        continue; // invalid JSON — skip
      }
    } else if (Array.isArray(raw)) {
      vec = raw as number[];
    } else {
      continue;
    }

    // Validasi dims (loose — record mungkin dibuat sebelum dimensions ditambah)
    if (vec.length !== queryVector.length) continue;

    totalSearched++;
    const score = similarityScore(queryVector, vec, metric);
    if (score < minScore) continue;

    candidates.push({ id: String(row.id), score, record: row });
  }

  // Top-k: sort by score DESC, ambil k pertama
  candidates.sort((a, b) => b.score - a.score);
  const topK = candidates.slice(0, k);

  return {
    items: topK,
    totalSearched,
    vectorField,
    metric,
    durationMs: Date.now() - start,
  };
}
