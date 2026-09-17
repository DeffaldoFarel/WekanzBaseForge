// ============================================================================
// M04 TAHAP 3: SQL BUILDER — dari AST ke SQL + params
//
// Berjalan menuruni pohon AST, membangun klausa WHERE dengan nilai yang
// SELALU dipisahkan ke array params (parameter binding).
//
// INILAH jantung keamanan: karena nilai tidak pernah menyentuh string SQL,
// SQL injection menjadi MUSTAHIL secara struktural — bukan karena kita
// "berhati-hati", tapi karena arsitekturnya memang tidak memungkinkan.
// ============================================================================

import { AstNode, ComparisonNode } from './parser.js';
import { FieldDefinition } from '../fieldTypes.js';

export interface SqlResult {
  where: string;
  params: (string | number | boolean | null)[];
}

// ─── M11: konteks @request ───────────────────────────────────────────────────
// Nilai yang boleh dipakai rule. Diberikan oleh pemanggil (records.ts)
// setelah verifikasi JWT. Kalau user belum login → auth = null → rule yang
// merujuk @request.auth.* menghasilkan 1=0 (default aman).

export interface RequestContext {
  auth: { id: string; email: string; verified?: boolean } | null;
}

export function resolveRequestValue(path: string, ctx: RequestContext | undefined): string | number | boolean | null {
  // Hanya @request.* yang dikenali — @ lain ditolak (bukan error crash,
  // tapi null → 1=0, default aman).
  if (!path.startsWith('@request.')) return null;

  const parts = path.slice('@request.'.length).split('.');

  // @request.auth.<field>
  if (parts[0] === 'auth') {
    if (!ctx?.auth) return null; // belum login → null → 1=0 (aman)
    const key = parts.slice(1).join('.');
    const val = (ctx.auth as unknown as Record<string, unknown>)[key];
    if (val === undefined) return null;
    return val as string | number | boolean | null;
  }

  return null; // @request.data.* nanti (M11 lanjutan); lainnya → null
}

/**
 * Membangun klausa WHERE dari AST.
 * @param ast     — pohon hasil parser
 * @param fields  — skema collection (untuk validasi nama field)
 * @param reqCtx  — M11: konteks @request (auth user yang sedang login)
 */
export function buildWhere(ast: AstNode, fields: FieldDefinition[], reqCtx?: RequestContext): SqlResult {
  const params: (string | number | boolean | null)[] = [];
  const validFieldNames = new Set(fields.map((f) => f.name));

  // Field sistem yang selalu boleh dipakai di filter
  for (const sys of ['id', 'created', 'updated']) {
    validFieldNames.add(sys);
  }

  function walk(node: AstNode): string {
    if (node.kind === 'logical') {
      const left = walk(node.left);
      const right = walk(node.right);
      return `(${left} ${node.operator} ${right})`;
    }

    // comparison node
    return walkComparison(node, params, validFieldNames, reqCtx);
  }

  const where = walk(ast);
  return { where, params };
}

function walkComparison(
  node: ComparisonNode,
  params: (string | number | boolean | null)[],
  validFieldNames: Set<string>,
  reqCtx?: RequestContext
): string {
  // ── M11: AT_IDENT di sisi FIELD (mis. @request.auth.id = "xyz") ──
  // KEDUA sisi adalah konstanta (request value + literal) → kondisi konstan:
  // dievaluasi di JS, hasilnya 1=1 atau 1=0 untuk SEMUA baris.
  // (Bukan perbandingan kolom! Salah umum: membalik ke `id = 'xyz'` — itu
  // akan memfilter baris berdasarkan id, bukan berdasarkan identitas requester.)
  if (node.field.startsWith('@')) {
    const reqVal = resolveRequestValue(node.field, reqCtx);
    const litVal = node.value;
    let truth: boolean;
    switch (node.operator) {
      case '=': truth = reqVal === litVal; break;
      case '!=': truth = reqVal !== litVal; break;
      case '>': truth = (reqVal as number) > (litVal as number); break;
      case '>=': truth = (reqVal as number) >= (litVal as number); break;
      case '<': truth = (reqVal as number) < (litVal as number); break;
      case '<=': truth = (reqVal as number) <= (litVal as number); break;
      case '~': truth = String(reqVal).includes(String(litVal)); break;
      case '!~': truth = !String(reqVal).includes(String(litVal)); break;
      default: throw new Error(`Unsupported operator: '${node.operator}'`);
    }
    return truth ? '1=1' : '1=0';
  }

  // ── M11: AT_IDENT di sisi VALUE (mis. user = @request.auth.id) ──
  let value = node.value;
  if (typeof value === 'string' && value.startsWith('@')) {
    value = resolveRequestValue(value, reqCtx);
  }

  // ── M11: @request resolve ke null (anon) + operator perbandingan ──
  // 1=0 = "tidak ada baris yang cocok" — default aman PocketBase.
  if (value === null && String(node.value ?? '').startsWith('@')) {
    return '1=0';
  }

  // ── Lapis pertahanan #1: field harus ada di skema ──
  if (!validFieldNames.has(node.field)) {
    throw new Error(
      `Field '${node.field}' does not exist in this collection. ` +
        `Available fields: ${[...validFieldNames].join(', ')}`
    );
  }

  const col = `"${node.field}"`;

  // ── Operator mapping ──
  // M17a: operator ? (any-match) — untuk multi-value (array JSON/relation multi)
  if (node.operator.startsWith('?')) {
    const baseOp = node.operator.slice(1); // '=', '!=', '>', ...
    return anyMatchToSql(node.field, baseOp, value, params);
  }

  switch (node.operator) {
    case '=':
      if (value === null) return `${col} IS NULL`;
      params.push(value);
      return `${col} = ?`;
    case '!=':
      if (value === null) return `${col} IS NOT NULL`;
      params.push(value);
      return `${col} != ?`;
    case '>':
      params.push(value);
      return `${col} > ?`;
    case '>=':
      params.push(value);
      return `${col} >= ?`;
    case '<':
      params.push(value);
      return `${col} < ?`;
    case '<=':
      params.push(value);
      return `${col} <= ?`;
    case '~':
      // "mengandung" → LIKE %nilai%
      params.push(`%${value}%`);
      return `${col} LIKE ?`;
    case '!~':
      params.push(`%${value}%`);
      return `${col} NOT LIKE ?`;
    default:
      throw new Error(`Unsupported operator: '${node.operator}'`);
  }
}

// ─── API GABUNGAN: string filter → SQL + params ─────────────────────────────
// Inilah fungsi yang akan dipakai dunia luar. Tiga tahap dalam satu panggilan.

import { tokenize } from './lexer.js';
import { parse } from './parser.js';

export function filterToSql(filter: string, fields: FieldDefinition[], reqCtx?: RequestContext): SqlResult {
  const tokens = tokenize(filter);
  const ast = parse(tokens);
  return buildWhere(ast, fields, reqCtx);
}

// ─── M17a: any-match (?operator) via json_each ──────────────────────────────
// Field array (JSON string atau kolom array) diekspansi per elemen:
//   tags ?= "merah"  →  EXISTS (SELECT 1 FROM json_each("tags") WHERE value = ?)
// Semantik PocketBase: "?=" = AT LEAST ONE element cocok; "?!=" = TIDAK ADA
// yang cocok (all-not); ?~, elemen mengandung; dsb.
function anyMatchToSql(
  field: string,
  baseOp: string,
  value: unknown,
  params: (string | number | boolean | null)[]
): string {
  const col = `"${field}"`;

  // Normalisasi value untuk perbandingan elemen JSON
  let cmpValue: string | number | boolean | null;
  let likeValue: string | null = null;
  if (typeof value === 'string') {
    cmpValue = value;
    likeValue = `%${value}%`;
  } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    cmpValue = value as string | number | boolean;
  } else {
    cmpValue = JSON.stringify(value);
  }

  const inner = (cmp: string): string =>
    `EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.type != 'object' AND json_each.${cmp})`;

  switch (baseOp) {
    case '=':
      params.push(cmpValue);
      return inner(`value = ?`);
    case '!=':
      // ?!= = TIDAK ADA elemen yang sama (NOT EXISTS)
      params.push(cmpValue);
      return `NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.value = ?)`;
    case '>':
      params.push(cmpValue);
      return inner(`value > ?`);
    case '>=':
      params.push(cmpValue);
      return inner(`value >= ?`);
    case '<':
      params.push(cmpValue);
      return inner(`value < ?`);
    case '<=':
      params.push(cmpValue);
      return inner(`value <= ?`);
    case '~':
      params.push(likeValue);
      return inner(`value LIKE ?`);
    case '!~':
      params.push(likeValue);
      return `NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.value LIKE ?)`;
    default:
      throw new Error(`Unsupported any-match operator: '?${baseOp}'`);
  }
}
