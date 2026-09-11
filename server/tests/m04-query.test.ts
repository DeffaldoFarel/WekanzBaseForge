// ============================================================================
// M04: TEST QUERY PARSER
//
// Tiga bagian: lexer, parser (AST + prioritas), sqlBuilder (SQL + params).
// Plus test keamanan: serangan SQL injection harus DITOLAK.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '../src/core/query/lexer.js';
import { parse } from '../src/core/query/parser.js';
import { filterToSql } from '../src/core/query/sqlBuilder.js';
import { FieldDefinition } from '../src/core/fieldTypes.js';

const habitFields: FieldDefinition[] = [
  { name: 'title', type: 'text', required: true },
  { name: 'streak', type: 'number' },
  { name: 'done', type: 'bool' },
  { name: 'type', type: 'text' },
];

// ════════════════════════════════════════════════════════════════════════════
// TAHAP 1: LEXER
// ════════════════════════════════════════════════════════════════════════════

test('M04 lexer: memecah filter sederhana jadi token', () => {
  const tokens = tokenize('streak > 5');
  assert.deepEqual(
    tokens.map((t) => [t.type, t.value]),
    [
      ['IDENT', 'streak'],
      ['OPERATOR', '>'],
      ['NUMBER', 5],
      ['EOF', null],
    ]
  );
});

test('M04 lexer: string dengan spasi dan operator 2-karakter', () => {
  const tokens = tokenize('title ~ "baca buku" && streak >= 3');
  assert.deepEqual(
    tokens.map((t) => [t.type, t.value]),
    [
      ['IDENT', 'title'],
      ['OPERATOR', '~'],
      ['STRING', 'baca buku'],
      ['AND', '&&'],
      ['IDENT', 'streak'],
      ['OPERATOR', '>='],
      ['NUMBER', 3],
      ['EOF', null],
    ]
  );
});

test('M04 lexer: boolean, null, kurung, angka negatif/desimal', () => {
  const tokens = tokenize('(done = true) && note != null && score <= -3.5');
  assert.deepEqual(
    tokens.map((t) => t.type),
    ['LPAREN', 'IDENT', 'OPERATOR', 'BOOL', 'RPAREN', 'AND', 'IDENT', 'OPERATOR', 'NULL', 'AND', 'IDENT', 'OPERATOR', 'NUMBER', 'EOF']
  );
});

test('M04 lexer: string tidak ditutup → error jelas', () => {
  assert.throws(() => tokenize('title = "tidak ditutup'), /tidak ditutup/);
});

// ════════════════════════════════════════════════════════════════════════════
// TAHAP 2: PARSER (AST + PRIORITAS)
// ════════════════════════════════════════════════════════════════════════════

test('M04 parser: perbandingan sederhana', () => {
  const ast = parse(tokenize('streak > 5'));
  assert.deepEqual(ast, {
    kind: 'comparison',
    field: 'streak',
    operator: '>',
    value: 5,
  });
});

test('M04 parser: prioritas && lebih tinggi dari ||', () => {
  // 'a = 1 || b = 2 && c = 3' harus jadi: a OR (b AND c)
  const ast = parse(tokenize('a = 1 || b = 2 && c = 3'));

  assert.equal(ast.kind, 'logical');
  if (ast.kind !== 'logical') return;
  assert.equal(ast.operator, 'OR');

  // sisi kanan harus AND (b && c), bukan (a || b) && c
  const right = ast.right;
  assert.equal(right.kind, 'logical');
  if (right.kind !== 'logical') return;
  assert.equal(right.operator, 'AND');
});

test('M04 parser: kurung mengubah prioritas', () => {
  // '(a = 1 || b = 2) && c = 3' harus jadi: (a OR b) AND c
  const ast = parse(tokenize('(a = 1 || b = 2) && c = 3'));

  assert.equal(ast.kind, 'logical');
  if (ast.kind !== 'logical') return;
  assert.equal(ast.operator, 'AND');

  const left = ast.left;
  assert.equal(left.kind, 'logical');
  if (left.kind !== 'logical') return;
  assert.equal(left.operator, 'OR'); // OR ada di dalam kurung → jadi sisi kiri AND
});

// ════════════════════════════════════════════════════════════════════════════
// TAHAP 3: SQL BUILDER (SQL + PARAMS)
// ════════════════════════════════════════════════════════════════════════════

test('M04 sqlBuilder: filter sederhana → WHERE + params terpisah', () => {
  const { where, params } = filterToSql('streak > 5', habitFields);

  assert.equal(where, '"streak" > ?');
  assert.deepEqual(params, [5]);
});

test('M04 sqlBuilder: filter kompleks dari dokumen konsep', () => {
  const { where, params } = filterToSql(
    'streak > 5 && (type = "daily" || type = "weekly")',
    habitFields
  );

  console.log('\n   📜 Filter:', 'streak > 5 && (type = "daily" || type = "weekly")');
  console.log('   📜 SQL   :', where);
  console.log('   📜 Params:', params);

  assert.equal(where, '("streak" > ? AND ("type" = ? OR "type" = ?))');
  assert.deepEqual(params, [5, 'daily', 'weekly']);
});

test('M04 sqlBuilder: operator ~ menjadi LIKE dengan wildcard', () => {
  const { where, params } = filterToSql('title ~ "ola"', habitFields);
  assert.equal(where, '"title" LIKE ?');
  assert.deepEqual(params, ['%ola%']);
});

test('M04 sqlBuilder: semua operator perbandingan', () => {
  assert.equal(filterToSql('streak = 5', habitFields).where, '"streak" = ?');
  assert.equal(filterToSql('streak != 5', habitFields).where, '"streak" != ?');
  assert.equal(filterToSql('streak >= 5', habitFields).where, '"streak" >= ?');
  assert.equal(filterToSql('streak < 5', habitFields).where, '"streak" < ?');
  assert.equal(filterToSql('streak <= 5', habitFields).where, '"streak" <= ?');
  assert.equal(filterToSql('title !~ "x"', habitFields).where, '"title" NOT LIKE ?');
});

test('M04 sqlBuilder: null menjadi IS NULL / IS NOT NULL', () => {
  assert.equal(filterToSql('title = null', habitFields).where, '"title" IS NULL');
  assert.equal(filterToSql('title != null', habitFields).where, '"title" IS NOT NULL');
});

// ════════════════════════════════════════════════════════════════════════════
// KEAMANAN
// ════════════════════════════════════════════════════════════════════════════

test('M04 keamanan: field yang tidak ada di skema → DITOLAK', () => {
  assert.throws(
    () => filterToSql('password = "x"', habitFields),
    /tidak ada di collection/
  );
});

test('M04 keamanan: nilai berisi SQL tidak pernah jadi perintah', () => {
  // Serangan klasik: suntikkan ' OR '1'='1' di dalam nilai string.
  // Lexer membaca dari " pembuka sampai " penutup → seluruhnya jadi
  // SATU token STRING biasa → nilainya hanya parameter, bukan perintah.
  const { where, params } = filterToSql(`title = "x' OR '1'='1"`, habitFields);

  // SQL-nya tetap bersih — tidak ada OR suntikan!
  assert.equal(where, '"title" = ?');
  // Nilai serangan tersimpan sebagai DATA (parameter), tidak dieksekusi
  assert.deepEqual(params, [`x' OR '1'='1`]);
  console.log('\n   🛡️  Serangan "\' OR \'1\'=\'1" dinetralkan menjadi parameter biasa.');
});

test('M04 keamanan: usaha keluar dari sintaks filter → gagal di parser', () => {
  // Serangan yang mencoba MENUTUP string lalu menyambung SQL:
  // nilai tidak dikutip tapi mengandung perintah
  assert.throws(() =>
    filterToSql(`streak = 5; DROP TABLE habits`, habitFields)
  ); // ';' bukan token valid → lexer menolak

  assert.throws(() =>
    filterToSql(`streak = 5 OR 1=1 --`, habitFields)
  ); // '--' dan 'OR' (tanpa ||) bukan sintaks filter valid

  console.log('   🛡️  Usaha keluar sintaks (titik koma, komentar SQL) → ditolak lexer.');
});

test('M04 keamanan: nilai tidak pernah masuk string SQL', () => {
  // Bahkan nilai yang MENGANDUNG SQL hanya menjadi parameter
  const { where, params } = filterToSql('title = "DROP TABLE habits"', habitFields);

  assert.equal(where, '"title" = ?'); // tidak ada "DROP TABLE" di SQL!
  assert.deepEqual(params, ['DROP TABLE habits']); // hanya sebagai data
  console.log('   🛡️  "DROP TABLE habits" hanya menjadi parameter, bukan perintah.');
});

// ════════════════════════════════════════════════════════════════════════════
// INTEGRASI NYATA: filter dipakai di query sungguhan
// ════════════════════════════════════════════════════════════════════════════

test('M04 integrasi: filterToSql bekerja di SQLite sungguhan', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');

  db.exec(`CREATE TABLE habits (
    id TEXT PRIMARY KEY, title TEXT, streak INTEGER, type TEXT
  )`);

  const insert = db.prepare('INSERT INTO habits (id, title, streak, type) VALUES (?, ?, ?, ?)');
  insert.run('h1', 'Olahraga pagi', 7, 'daily');
  insert.run('h2', 'Baca buku', 3, 'daily');
  insert.run('h3', 'Review mingguan', 10, 'weekly');
  insert.run('h4', 'Meditasi', 2, 'monthly');

  // Query dengan filter yang di-parse!
  const { where, params } = filterToSql(
    'streak > 5 && (type = "daily" || type = "weekly")',
    habitFields
  );

  const rows = db
    .prepare(`SELECT * FROM habits WHERE ${where}`)
    .all(...params) as { id: string; title: string }[];

  const titles = rows.map((r) => r.title);
  console.log('\n   🎯 Hasil query nyata:', titles);

  assert.equal(rows.length, 2); // Olahraga (7,daily) + Review (10,weekly)
  assert.ok(titles.includes('Olahraga pagi'));
  assert.ok(titles.includes('Review mingguan'));

  db.close();
});
