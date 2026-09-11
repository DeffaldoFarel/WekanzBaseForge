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

/**
 * Membangun klausa WHERE dari AST.
 * @param ast     — pohon hasil parser
 * @param fields  — skema collection (untuk validasi nama field)
 */
export function buildWhere(ast: AstNode, fields: FieldDefinition[]): SqlResult {
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
    return walkComparison(node, params, validFieldNames);
  }

  const where = walk(ast);
  return { where, params };
}

function walkComparison(
  node: ComparisonNode,
  params: (string | number | boolean | null)[],
  validFieldNames: Set<string>
): string {
  // ── Lapis pertahanan #1: field harus ada di skema ──
  if (!validFieldNames.has(node.field)) {
    throw new Error(
      `Field '${node.field}' tidak ada di collection ini. ` +
        `Field tersedia: ${[...validFieldNames].join(', ')}`
    );
  }

  const col = `"${node.field}"`;

  // ── Operator mapping ──
  switch (node.operator) {
    case '=':
      if (node.value === null) return `${col} IS NULL`;
      params.push(node.value);
      return `${col} = ?`;
    case '!=':
      if (node.value === null) return `${col} IS NOT NULL`;
      params.push(node.value);
      return `${col} != ?`;
    case '>':
      params.push(node.value);
      return `${col} > ?`;
    case '>=':
      params.push(node.value);
      return `${col} >= ?`;
    case '<':
      params.push(node.value);
      return `${col} < ?`;
    case '<=':
      params.push(node.value);
      return `${col} <= ?`;
    case '~':
      // "mengandung" → LIKE %nilai%
      params.push(`%${node.value}%`);
      return `${col} LIKE ?`;
    case '!~':
      params.push(`%${node.value}%`);
      return `${col} NOT LIKE ?`;
    default:
      throw new Error(`Operator tidak didukung: '${node.operator}'`);
  }
}

// ─── API GABUNGAN: string filter → SQL + params ─────────────────────────────
// Inilah fungsi yang akan dipakai dunia luar. Tiga tahap dalam satu panggilan.

import { tokenize } from './lexer.js';
import { parse } from './parser.js';

export function filterToSql(filter: string, fields: FieldDefinition[]): SqlResult {
  const tokens = tokenize(filter);
  const ast = parse(tokens);
  return buildWhere(ast, fields);
}
