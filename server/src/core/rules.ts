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
import { filterToSql, RequestContext, resolveRequestValue } from './query/sqlBuilder.js';
import { tokenize } from './query/lexer.js';
import { parse, type AstNode } from './query/parser.js';

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

// ─── Evaluasi rule terhadap DATA (create/update/delete/view per-record) ────
// AUD-2-01: evaluator REGEX lama mengabaikan tanda kurung — rule
// `a && (b || c)` dievaluasi `(a && b) || c` di jalur viewRule/updateRule/
// deleteRule/createRule → user lain bisa GET+PATCH+DELETE record milik user
// lain (probe audit terbukti), sementara jalur LIST (parser SQL) menolak —
// dua jalur, dua keputusan. Kini rule diparse dengan PARSER ASLI (grammar
// yang sama dengan filterToSql) lalu dievaluasi in-memory: satu grammar,
// satu kebenaran, konsisten dengan LIST.

export function evaluateRuleOnData(
  rule: string,
  data: Record<string, unknown>,
  reqCtx: RequestContext | undefined
): boolean {
  if (reqCtx === undefined) return true;
  if (rule.trim() === '') return true;
  if (!reqCtx?.auth && rule.includes('@request')) return false;

  let ast: AstNode;
  try {
    ast = parse(tokenize(rule));
  } catch {
    return false; // rule korup/tidak terparse → tolak (fail-safe)
  }
  return evalRuleNode(ast, data, reqCtx);
}

function evalRuleNode(node: AstNode, data: Record<string, unknown>, reqCtx: RequestContext): boolean {
  if (node.kind === 'logical') {
    const left = evalRuleNode(node.left, data, reqCtx);
    const right = evalRuleNode(node.right, data, reqCtx);
    return node.operator === 'AND' ? left && right : left || right;
  }
  const { field, operator, value } = node;
  const left = field.startsWith('@') ? resolveRequestValue(field, reqCtx) : data[field];
  const right = typeof value === 'string' && value.startsWith('@') ? resolveRequestValue(value, reqCtx) : value;
  return evalComparison(left, operator, right);
}

/**
 * Semantik perbandingan MENIRU SQL agar konsisten dengan jalur LIST:
 *  - NULL/undefined di sisi data → false (SQL UNKNOWN — baris tidak lolos)
 *  - `= null` / `!= null` → IS NULL / IS NOT NULL
 *  - `~` / `!~` → LIKE / NOT LIKE (case-insensitive, sesuai SQLite ASCII)
 *  - bool dibandingkan sebagai 1/0 (cara SQLite menyimpannya)
 *  - `?op` (any-match) → minimal satu elemen array cocok
 */
function evalComparison(left: unknown, op: string, right: unknown): boolean {
  if (op.startsWith('?')) {
    const base = op.slice(1);
    const arr = Array.isArray(left) ? left : [];
    if (base === '!=') return !arr.some((el) => evalComparison(el, '=', right));
    return arr.some((el) => evalComparison(el, base, right));
  }

  const isNull = (v: unknown) => v === null || v === undefined;
  switch (op) {
    case '=':
      if (right === null) return isNull(left);
      if (isNull(left)) return false;
      return looseEq(left, right);
    case '!=':
      if (right === null) return !isNull(left);
      if (isNull(left)) return false;
      return !looseEq(left, right);
    case '>':
      return cmpNum(left, right) > 0;
    case '>=':
      return cmpNum(left, right) >= 0;
    case '<':
      return cmpNum(left, right) < 0;
    case '<=':
      return cmpNum(left, right) <= 0;
    case '~':
      if (isNull(left)) return false;
      return String(left).toLowerCase().includes(String(right ?? '').toLowerCase());
    case '!~':
      if (isNull(left)) return false;
      return !String(left).toLowerCase().includes(String(right ?? '').toLowerCase());
    default:
      return false;
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const an = typeof a === 'boolean' ? (a ? 1 : 0) : a;
  const bn = typeof b === 'boolean' ? (b ? 1 : 0) : b;
  return typeof an === 'number' && typeof bn === 'number' && an === bn;
}

function cmpNum(left: unknown, right: unknown): number {
  const l = typeof left === 'boolean' ? (left ? 1 : 0) : Number(left);
  const r = typeof right === 'boolean' ? (right ? 1 : 0) : Number(right);
  if (!Number.isFinite(l) || !Number.isFinite(r)) return NaN; // semua perbandingan → false
  return l - r;
}

// ─── Helper tipe untuk schema.ts ─────────────────────────────────────────────

/**
 * Ops-4 (B3): kumpulkan nama field skema yang direferensikan sekumpulan rule.
 *
 * Dipakai untuk membuat index otomatis: sebuah `listRule` seper
 * `userId = @request.auth.id` diterjemahkan menjadi `WHERE userId = ?` pada
 * SETIAP list (`records.ts`), jadi kolom itu selalu butuh index. Sebelumnya
 * tidak ada index yang dibuat dan tidak ada peringatan — terukur di project
 * WekanzDashboard: `EXPLAIN QUERY PLAN` menjawab `SCAN investments` untuk
 * seluruh 21 collection.
 *
 * Memakai regex yang SAMA dengan `validateRuleFields` agar dua tempat tidak
 * pernah berbeda pendapat tentang apa yang dianggap referensi field.
 *
 * `id` dilewati (sudah PRIMARY KEY, index-nya implisit). `@request.*`, literal
 * string, dan nama yang tidak ada di skema juga dilewati — yang terakhir sudah
 * ditolak lebih dulu oleh `validateRuleFields`.
 */
export function collectRuleFieldNames(
  rules: Partial<CollectionRules> | undefined,
  fields: FieldDefinition[]
): string[] {
  if (!rules) return [];

  const schemaFields = new Set(fields.map((f) => f.name));
  const found = new Set<string>();

  for (const rule of Object.values(rules)) {
    if (typeof rule !== 'string' || rule.trim() === '') continue;

    const identRe =
      /(^|[\s(])("[^"]*"|'[^']*'|@request\.[a-zA-Z0-9_.]+|[a-zA-Z_][a-zA-Z0-9_.]*)\s*(=|!=|>=|<=|>|<|~|!~)/g;
    let m: RegExpExecArray | null;
    while ((m = identRe.exec(rule)) !== null) {
      const ident = m[2];
      if (ident.startsWith('"') || ident.startsWith("'") || ident.startsWith('@')) continue;
      // 'id' sudah PRIMARY KEY; 'created'/'updated' jarang jadi predikat rule
      // tetapi tetap boleh diindeks bila dipakai.
      if (ident === 'id') continue;
      if (!schemaFields.has(ident)) continue;
      found.add(ident);
    }
  }

  return [...found];
}

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
