// ============================================================================
// M04 TAHAP 1: LEXER (tokenizer)
//
// Tugas: memecah string filter mentah menjadi token-token bermakna.
// Ini adalah "membaca huruf menjadi kata" — lexer tidak peduli artinya,
// hanya mengelompokkan karakter menjadi unit yang bisa diolah parser.
//
// Contoh:
//   'streak > 5 && title ~ "ola"'
//   → [IDENT streak] [OP >] [NUM 5] [AND] [IDENT title] [OP ~] [STR ola]
// ============================================================================

// ─── Tipe token ──────────────────────────────────────────────────────────────

export type TokenType =
  | 'IDENT'      // nama field: streak, title, user
  | 'NUMBER'     // angka: 5, 3.14, -10
  | 'STRING'     // string: "ola", 'x'
  | 'BOOL'       // true, false
  | 'NULL'       // null
  | 'OPERATOR'   // =, !=, >, >=, <, <=, ~, !~
  | 'AND'        // &&
  | 'OR'         // ||
  | 'LPAREN'     // (
  | 'RPAREN'     // )
  | 'EOF';       // akhir input

export interface Token {
  type: TokenType;
  value: string | number | boolean | null;
  pos: number; // posisi di string asli — untuk pesan error yang membantu
}

// ─── Lexer ───────────────────────────────────────────────────────────────────

const OPERATORS = ['!=', '!~', '>=', '<=', '=', '>', '<', '~']; // 2-char dulu!

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  // Helper: lempar error dengan posisi yang jelas
  function fail(msg: string, pos: number): never {
    throw new Error(`Lexer error di posisi ${pos}: ${msg}\n  "${input}"\n   ${' '.repeat(pos)}^`);
  }

  while (i < input.length) {
    const ch = input[i];

    // ── Spasi: lewati ──
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // ── Kurung ──
    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(', pos: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')', pos: i });
      i++;
      continue;
    }

    // ── && dan || ──
    if (ch === '&' && input[i + 1] === '&') {
      tokens.push({ type: 'AND', value: '&&', pos: i });
      i += 2;
      continue;
    }
    if (ch === '|' && input[i + 1] === '|') {
      tokens.push({ type: 'OR', value: '||', pos: i });
      i += 2;
      continue;
    }

    // ── Operator perbandingan (cek yang 2-karakter dulu!) ──
    // Penting: '!=' harus dicek SEBELUM '=' atau '!' akan salah dibaca.
    let matchedOp: string | null = null;
    for (const op of OPERATORS) {
      if (input.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp) {
      tokens.push({ type: 'OPERATOR', value: matchedOp, pos: i });
      i += matchedOp.length;
      continue;
    }

    // ── String: diawali " atau ' ──
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++; // lewati tanda kutip pembuka
      let str = '';
      let closed = false;
      while (i < input.length) {
        if (input[i] === '\\' && input[i + 1] === quote) {
          str += quote; // escape: \" → "
          i += 2;
          continue;
        }
        if (input[i] === quote) {
          closed = true;
          i++; // lewati tanda kutip penutup
          break;
        }
        str += input[i];
        i++;
      }
      if (!closed) fail('string tidak ditutup (kurang tanda kutip)', start);
      tokens.push({ type: 'STRING', value: str, pos: start });
      continue;
    }

    // ── Angka (termasuk negatif & desimal) ──
    if (/\d/.test(ch) || (ch === '-' && /\d/.test(input[i + 1] ?? ''))) {
      const start = i;
      if (ch === '-') i++;
      while (i < input.length && /[\d.]/.test(input[i])) i++;
      const numStr = input.slice(start, i);
      const num = Number(numStr);
      if (isNaN(num)) fail(`angka tidak valid: '${numStr}'`, start);
      tokens.push({ type: 'NUMBER', value: num, pos: start });
      continue;
    }

    // ── Identifier / keyword (true, false, null) ──
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      // identifier bisa berisi huruf, angka, underscore, TITIK (untuk relasi nanti)
      while (i < input.length && /[a-zA-Z0-9_.]/.test(input[i])) i++;
      const word = input.slice(start, i);

      // keyword khusus
      if (word === 'true') {
        tokens.push({ type: 'BOOL', value: true, pos: start });
      } else if (word === 'false') {
        tokens.push({ type: 'BOOL', value: false, pos: start });
      } else if (word === 'null') {
        tokens.push({ type: 'NULL', value: null, pos: start });
      } else {
        tokens.push({ type: 'IDENT', value: word, pos: start });
      }
      continue;
    }

    // ── Karakter tidak dikenal ──
    fail(`karakter tidak dikenal: '${ch}'`, i);
  }

  tokens.push({ type: 'EOF', value: null, pos: i });
  return tokens;
}
