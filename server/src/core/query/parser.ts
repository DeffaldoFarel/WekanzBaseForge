// ============================================================================
// M04 TAHAP 2: PARSER — menyusun token menjadi AST
//
// Lexer memberi kita "kata-kata" (token). Parser menyusunnya menjadi
// "kalimat" (struktur bermakna) — dalam bentuk pohon (AST).
//
// Teknik: RECURSIVE DESCENT PARSER — satu fungsi per level prioritas.
// Ini cara paling mudah memahami parser: setiap aturan prioritas adalah
// fungsi yang memanggil fungsi prioritas di bawahnya.
//
// Prioritas (dari terendah ke tertinggi):
//   parseOr     → a || b
//   parseAnd    → a && b
//   parseComparison → a > b
//   parsePrimary    → ( ... ) atau nilai
// ============================================================================

import { Token } from './lexer.js';

// ─── Definisi AST ────────────────────────────────────────────────────────────

// Node perbandingan: field OP value
export interface ComparisonNode {
  kind: 'comparison';
  field: string;
  operator: string; // =, !=, >, >=, <, <=, ~, !~
  value: string | number | boolean | null;
}

// Node logika: left AND/OR right
export interface LogicalNode {
  kind: 'logical';
  operator: 'AND' | 'OR';
  left: AstNode;
  right: AstNode;
}

export type AstNode = ComparisonNode | LogicalNode;

// ─── Parser ──────────────────────────────────────────────────────────────────

export function parse(tokens: Token[]): AstNode {
  let pos = 0;

  function peek(): Token {
    return tokens[pos];
  }
  function next(): Token {
    return tokens[pos++];
  }
  function expect(type: Token['type'], what: string): Token {
    const t = next();
    if (t.type !== type) {
      throw new Error(
        `Parser error di token ke-${pos}: diharapkan ${what}, dapat '${t.type}' (${String(t.value)})`
      );
    }
    return t;
  }

  // ── Level 1 (terendah): OR ──
  // or := and ( '||' and )*
  function parseOr(): AstNode {
    let left = parseAnd();
    while (peek().type === 'OR') {
      next(); // konsumsi '||'
      const right = parseAnd();
      left = { kind: 'logical', operator: 'OR', left, right };
    }
    return left;
  }

  // ── Level 2: AND ──
  // and := comparison ( '&&' comparison )*
  function parseAnd(): AstNode {
    let left = parseComparison();
    while (peek().type === 'AND') {
      next(); // konsumsi '&&'
      const right = parseComparison();
      left = { kind: 'logical', operator: 'AND', left, right };
    }
    return left;
  }

  // ── Level 3: perbandingan ──
  // comparison := primary ( OPERATOR primary )?  |  '(' or ')'
  function parseComparison(): AstNode {
    // Bisa jadi pengelompokan kurung
    if (peek().type === 'LPAREN') {
      next(); // konsumsi '('
      const node = parseOr(); // isi kurung: ekspresi penuh!
      expect('RPAREN', "')'");
      return node;
    }

    // Perbandingan: IDENT OPERATOR nilai
    const fieldToken = expect('IDENT', 'nama field');
    const opToken = expect('OPERATOR', 'operator (=, !=, >, dsb.)');
    const valueToken = next();

    if (
      valueToken.type !== 'STRING' &&
      valueToken.type !== 'NUMBER' &&
      valueToken.type !== 'BOOL' &&
      valueToken.type !== 'NULL'
    ) {
      throw new Error(
        `Parser error: nilai setelah '${String(opToken.value)}' harus berupa string, angka, true/false, atau null — dapat '${valueToken.type}'`
      );
    }

    return {
      kind: 'comparison',
      field: String(fieldToken.value),
      operator: String(opToken.value),
      value: valueToken.value,
    };
  }

  const ast = parseOr();

  // Pastikan tidak ada token sisa
  if (peek().type !== 'EOF') {
    throw new Error(
      `Parser error: ada sisa input yang tidak terduga — '${String(peek().value)}'`
    );
  }

  return ast;
}
