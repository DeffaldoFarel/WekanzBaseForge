// ============================================================================
// M11: API RULES — row-level security ala PocketBase
//
// Setiap collection punya 5 rule: listRule, viewRule, createRule,
// updateRule, deleteRule. Tiga makna nilai:
//   null    → hanya admin (dunia luar tidak bisa)
//   ''      → publik (siapa pun, termasuk anonymous)
//   'expr'  → evaluasi ekspresi filter (dengan @request.*)
//
// Arsitektur kunci: rules DIPAKAI ULANG query parser M04. Rule adalah
// filter biasa + referensi @request yang di-resolve saat request masuk.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { FieldDefinition } from './fieldTypes.js';
import { filterToSql, RequestContext } from './query/sqlBuilder.js';

// ─── Tipe ────────────────────────────────────────────────────────────────────

export interface CollectionRules {
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
}

// Null = admin-only (default paling aman)
export const DEFAULT_RULES: CollectionRules = {
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
};

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden — the rule does not allow this operation') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

// ─── Keputusan rule → SQL fragment ───────────────────────────────────────────
// Returns null → admin bypass (tanpa ctx) atau rule kosong (publik).

export function decideRule(
  rule: string | null | undefined,
  reqCtx: RequestContext | undefined,
  fields: FieldDefinition[] = []
): { mode: 'public' | 'admin' | 'filter'; sql?: string; params?: (string | number | boolean | null)[] } {
  if (rule === null || rule === undefined) {
    // null = admin only. Kalau tidak ada auth (bukan admin), tolak.
    if (reqCtx?.auth) {
      throw new ForbiddenError();
    }
    // Pemanggil tanpa ctx = admin/internal → bypass
    return { mode: 'admin' };
  }

  if (rule.trim() === '') {
    return { mode: 'public' }; // tanpa filter tambahan
  }

  if (!reqCtx?.auth && rule.includes('@request')) {
    // Anonymous + rule merujuk @request → tidak akan pernah cocok
    return { mode: 'filter', sql: '1=0' };
  }

  const { where, params } = filterToSql(rule, fields, reqCtx);
  return { mode: 'filter', sql: where, params };
}

// ─── Evaluasi rule terhadap DATA (untuk create; nanti juga update) ──────────
// Data yang dikirim user disubstitusi ke rule sebagai field, lalu dievaluasi.

export function evaluateRuleOnData(
  rule: string,
  data: Record<string, unknown>,
  reqCtx: RequestContext | undefined
): boolean {
  // Substitusi sederhana & aman: setiap IDENT yang cocok dengan nama field
  // data diganti STRING literal-nya. IDENT yang tidak cocok → 1=0 (aman).
  // Catatan: ini evaluator konstanta, bukan SQL builder — kita bandingkan
  // langsung di JS setelah resolve.

  // Ambil pasangan (field, op, value) dengan regex sederhana per-klasul.
  // Untuk M11 kita dukung bentuk paling umum: field op nilai && / ||
  const clauseRe = /([a-zA-Z_][a-zA-Z0-9_.]*|@request\.[a-zA-Z0-9_.]+)\s*(=|!=|>|>=|<|<=|~|!~)\s*("[^"]*"|'[^']*'|@request\.[a-zA-Z0-9_.]+|true|false|null|-?\d+(?:\.\d+)?)/g;

  let result: boolean | null = null; // null = belum ada; AND binds tighter
  let pendingOp: 'AND' | 'OR' | null = null;
  let lastIndex = 0;
  const expr = rule;

  while (lastIndex < expr.length) {
    // Cari operator logika berikutnya
    const nextLogical = findNextLogical(expr, lastIndex);
    const segment = expr.slice(lastIndex, nextLogical.pos);
    const segTrim = segment.trim();

    if (segTrim.length > 0) {
      const m = clauseRe.exec(segTrim + ' ');
      clauseRe.lastIndex = 0;
      let clauseTruth: boolean;

      if (m) {
        const field = m[1];
        const op = m[2];
        const rawVal = m[3];

        const resolveValue = (raw: string): unknown => {
          if (raw.startsWith('@request.')) {
            if (!reqCtx?.auth) return null;
            const key = raw.slice('@request.'.length).split('.').slice(1).join('.');
            return (reqCtx.auth as unknown as Record<string, unknown>)[key] ?? null;
          }
          if (raw.startsWith('"') || raw.startsWith("'")) return raw.slice(1, -1);
          if (raw === 'true') return true;
          if (raw === 'false') return false;
          if (raw === 'null') return null;
          return Number(raw);
        };

        let left: unknown;
        let right: unknown;
        if (field.startsWith('@request.')) {
          left = resolveValue(field);
          right = resolveValue(rawVal);
        } else {
          // field = kolom data
          left = data[field];
          right = resolveValue(rawVal);
        }

        clauseTruth = compareValues(left, op, right);
      } else {
        clauseTruth = false; // segmen tidak bisa diparse → tolak (aman)
      }

      // Gabungkan dengan operator logika (AND lebih kuat dari OR)
      if (result === null) {
        result = clauseTruth;
      } else if (pendingOp === 'AND') {
        result = result && clauseTruth;
      } else {
        result = result || clauseTruth;
      }
    }

    pendingOp = nextLogical.op;
    lastIndex = nextLogical.pos + (nextLogical.op ? 2 : 0);
    if (!nextLogical.op) break;
  }

  return result ?? false;
}

function findNextLogical(expr: string, from: number): { pos: number; op: 'AND' | 'OR' | null } {
  const andIdx = expr.indexOf('&&', from);
  const orIdx = expr.indexOf('||', from);
  if (andIdx === -1 && orIdx === -1) return { pos: expr.length, op: null };
  if (andIdx === -1) return { pos: orIdx, op: 'OR' };
  if (orIdx === -1) return { pos: andIdx, op: 'AND' };
  return andIdx < orIdx ? { pos: andIdx, op: 'AND' } : { pos: orIdx, op: 'OR' };
}

function compareValues(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case '=': return left === right;
    case '!=': return left !== right;
    case '>': return (left as number) > (right as number);
    case '>=': return (left as number) >= (right as number);
    case '<': return (left as number) < (right as number);
    case '<=': return (left as number) <= (right as number);
    case '~': return String(left ?? '').includes(String(right ?? ''));
    case '!~': return !String(left ?? '').includes(String(right ?? ''));
    default: return false;
  }
}

// ─── Helper tipe untuk schema.ts ─────────────────────────────────────────────

export function validateRuleFields(rule: string, fields: FieldDefinition[]): string | null {
  // Validasi ringan: nama field di rule (yang bukan @request) harus ada di
  // skema. Mencegah typo diam-diam menjadi rule yang selalu false.
  const valid = new Set(fields.map((f) => f.name));
  valid.add('id');
  valid.add('created');
  valid.add('updated');

  const identRe = /(^|[\s(])("[^"]*"|'[^']*'|@request\.[a-zA-Z0-9_.]+|[a-zA-Z_][a-zA-Z0-9_.]*)\s*(=|!=|>=|<=|>|<|~|!~)/g;
  let m: RegExpExecArray | null;
  while ((m = identRe.exec(rule)) !== null) {
    const ident = m[2];
    if (ident.startsWith('"') || ident.startsWith("'") || ident.startsWith('@')) continue;
    if (!valid.has(ident)) {
      return `Field '${ident}' does not exist in the collection schema`;
    }
  }
  return null;
}
