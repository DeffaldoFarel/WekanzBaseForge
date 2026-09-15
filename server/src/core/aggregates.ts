// ============================================================================
// D7: AGGREGATES — menjawab pertanyaan analitik dari banyak record
//
// CRUD (M05) mengambil record. Aggregates MENGHITUNG dari banyak record:
// count, sum, avg, min, max — opsional per kelompok (GROUP BY).
//
// Kenapa tidak ambil semua lalu hitung di JS? Karena itu full scan + boros
// memori. Database menghitung jauh lebih efisien — apalagi dengan index (M06).
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { getCollectionByName } from './schema.js';
import { filterToSql, RequestContext } from './query/sqlBuilder.js';
import { decideRule } from './rules.js';

// ─── Tipe ────────────────────────────────────────────────────────────────────

export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface AggregateOptions {
  function: AggregateFunction;
  field?: string; // wajib untuk sum/avg/min/max; opsional untuk count
  filter?: string; // reuse query parser M04
  groupBy?: string; // hasil per kelompok
  // M19: identitas pemanggil — WAJIB diteruskan dari route publik.
  //   undefined            → admin (bypass rules, sama seperti listRecords)
  //   { auth: null }       → anonim (listRule tetap berlaku)
  //   { auth: { id, ... }} → end user
  reqCtx?: RequestContext;
}

// Hasil tanpa grouping
export interface AggregateSingleResult {
  value: number;
}

// Hasil dengan grouping
export interface AggregateGroupResult {
  groups: Array<{ group: unknown; value: number }>;
}

// ─── Fungsi utama ────────────────────────────────────────────────────────────

export function aggregate(
  db: DatabaseSync,
  collection: string,
  options: AggregateOptions
): AggregateSingleResult | AggregateGroupResult {
  const meta = getCollectionByName(db, collection);
  if (!meta) {
    throw new Error(`Collection '${collection}' tidak ditemukan`);
  }

  const { function: fn, field, filter, groupBy } = options;

  // ── Validasi field ──
  const validNames = new Set([...meta.fields.map((f) => f.name), 'id', 'created', 'updated']);

  // Field wajib untuk sum/avg/min/max
  if (fn !== 'count') {
    if (!field) {
      throw new Error(`Aggregate '${fn}' membutuhkan field`);
    }
    if (!validNames.has(field)) {
      throw new Error(`Field '${field}' tidak ada di collection '${collection}'`);
    }
    // Aggregate numerik hanya masuk akal pada field number
    const fieldDef = meta.fields.find((f) => f.name === field);
    if (fieldDef && fieldDef.type !== 'number') {
      throw new Error(`Aggregate '${fn}' hanya bisa pada field number, '${field}' bertipe '${fieldDef.type}'`);
    }
  }

  if (field && !validNames.has(field)) {
    throw new Error(`Field '${field}' tidak ada di collection '${collection}'`);
  }

  if (groupBy && !validNames.has(groupBy)) {
    throw new Error(`Group by field '${groupBy}' tidak ada di collection '${collection}'`);
  }

  // ── Bangun ekspresi agregat ──
  const aggExpr = buildAggregateExpr(fn, field);

  // ── WHERE: rule dulu (keamanan), filter user belakangan ──
  // Urutan ini WAJIB sama dengan listRecords (records.ts) — kalau terbalik,
  // filter user bisa dievaluasi pada baris yang seharusnya tak terlihat.
  const whereParts: string[] = [];
  const params: unknown[] = [];

  // M19: listRule — agregat membocorkan info tentang baris yang tak boleh
  // dibaca (COUNT saja sudah bocor), jadi rule HARUS diterapkan di sini,
  // bukan hanya di listRecords. Hanya END USER; admin (undefined) bypass.
  if (options.reqCtx !== undefined) {
    // ruleFor() di records.ts adalah helper privat; logikanya satu baris,
    // jadi dibaca langsung di sini daripada menambah kopling antar modul.
    const lRule = meta.rules.listRule ?? null;
    if (lRule === null) {
      // admin-only collection + end user → tidak ada baris sama sekali
      return groupBy ? { groups: [] } : { value: 0 };
    }
    if (lRule.trim() !== '') {
      const decided = decideRule(lRule, options.reqCtx, meta.fields);
      if (decided.mode === 'filter' && decided.sql) {
        whereParts.push(`(${decided.sql})`);
        params.push(...(decided.params ?? []));
      }
      // mode 'public' tidak menambah WHERE
    }
  }

  if (filter && filter.trim().length > 0) {
    const parsed = filterToSql(filter, meta.fields, options.reqCtx);
    whereParts.push(`(${parsed.where})`);
    params.push(...parsed.params);
  }

  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  // ── GROUP BY atau single value ──
  if (groupBy) {
    const sql = `SELECT "${groupBy}" AS grp, ${aggExpr} AS val FROM "${collection}" ${whereSql} GROUP BY "${groupBy}" ORDER BY val DESC`;
    const rows = db.prepare(sql).all(...(params as never[])) as { grp: unknown; val: number }[];
    return {
      groups: rows.map((r) => ({ group: r.grp, value: r.val })),
    };
  }

  const sql = `SELECT ${aggExpr} AS val FROM "${collection}" ${whereSql}`;
  const row = db.prepare(sql).get(...(params as never[])) as { val: number | null };
  return { value: row.val ?? 0 };
}

// ─── Helper: bangun ekspresi agregat SQL ─────────────────────────────────────

function buildAggregateExpr(fn: AggregateFunction, field?: string): string {
  switch (fn) {
    case 'count':
      return field ? `COUNT("${field}")` : 'COUNT(*)';
    case 'sum':
      return `SUM("${field}")`;
    case 'avg':
      return `AVG("${field}")`;
    case 'min':
      return `MIN("${field}")`;
    case 'max':
      return `MAX("${field}")`;
    default:
      throw new Error(`Aggregate function tidak dikenal: '${fn}'`);
  }
}
