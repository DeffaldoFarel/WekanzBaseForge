# M04 — Query Parser: Dari String Filter ke SQL

> **Konsep yang dipelajari:** lexer (tokenizer), parser, AST (Abstract Syntax Tree), dan kenapa SQL injection dicegah di DUA lapisan.

## 🎯 Tujuan Milestone

Membangun "compiler mini" yang menerjemahkan bahasa filter (seperti PocketBase):

```
INPUT:  'streak > 5 && (type = "daily" || type = "weekly")'
                ↓  LEXER (pecah jadi token)
        [streak] [>] [5] [&&] [(] [type] [=] ["daily"] [||] ...
                ↓  PARSER (susun jadi pohon)
        AST:
            AND
           /   \
          >     OR
         / \   /  \
      streak 5 =    =
              / \  / \
           type .. type ..
                ↓  SQL BUILDER (jalan pohon → SQL)
OUTPUT: SQL:    (streak > ?) AND ((type = ?) OR (type = ?))
        PARAMS: [5, 'daily', 'weekly']
```

## 🧠 Kenapa Tidak Pakai String Replace Saja?

Pertanyaan jujur: kenapa tidak `filter.replace('&&', 'AND')` lalu selesai?

```typescript
// ❌ NAIK — tampaknya bekerja:
const sql = filter.replace(/&&/g, ' AND ').replace(/\|\|/g, ' OR ');
// Masalah: nilai user tetap mentah di SQL → SQL INJECTION!
filter = "title = 'x' OR '1'='1' --"
// → WHERE title = 'x' OR '1'='1' --'  (semua data bocor!)
```

Filter adalah **input dari user** → tidak pernah boleh dipercaya.
Satu-satunya cara aman: PARSE dulu strukturnya, lalu bangun SQL dengan
nilai yang SELALU lewat parameter binding.

## 🧩 Tiga Tahap

### Tahap 1: LEXER (tokenizer)
Memecah string mentah menjadi "kata-kata" (token) yang bermakna.

```
INPUT:  'streak > 5 && title ~ "ola"'
TOKENS:
  { type: 'IDENT',    value: 'streak' }
  { type: 'OPERATOR', value: '>' }
  { type: 'NUMBER',   value: 5 }
  { type: 'AND',      value: '&&' }
  { type: 'IDENT',    value: 'title' }
  { type: 'OPERATOR', value: '~' }      ← ~ = "mengandung" (LIKE)
  { type: 'STRING',   value: 'ola' }
```

Token tidak tahu artinya — hanya tahu "ini angka, ini operator, ini string".

### Tahap 2: PARSER
Menyusun token menjadi **AST** (pohon) yang menangkap STRUKTUR & PRIORITAS.

Aturan prioritas (seperti matematika: × sebelum +):
1. `(...)` — kurung dulu
2. `> >= < <= = != ~ !~` — perbandingan
3. `&&` — AND
4. `||` — OR (paling akhir)

```
'streak > 5 && done = true || title ~ "x"'
         ↓
      OR                    ← || paling akhir dievaluasi
     /  \
   AND   ~                 ← && lebih dulu
  /  \   / \
 >   =  title "x"
/ \ / \
.. .. ..
```

### Tahap 3: SQL BUILDER
Berjalan menuruni pohon, membangun SQL dengan parameter binding.

```
Node '>' dengan anak [streak, 5]
  → SQL: "(streak > ?)"  params: [5]

Node 'AND' dengan anak [>, =]
  → SQL: "(left) AND (right)"
```

**Nilai TIDAK PERNAH masuk ke string SQL — hanya ke array params.**

## 📐 Operator yang Didukung (subset PocketBase)

| Filter | SQL | Arti |
|--------|-----|------|
| `a = b` | `a = ?` | sama dengan |
| `a != b` | `a != ?` | tidak sama |
| `a > b` | `a > ?` | lebih besar |
| `a >= b` | `a >= ?` | lebih besar atau sama |
| `a < b` | `a < ?` | lebih kecil |
| `a <= b` | `a <= ?` | lebih kecil atau sama |
| `a ~ b` | `a LIKE ?` | mengandung (b → '%b%') |
| `a !~ b` | `a NOT LIKE ?` | tidak mengandung |
| `&&` | `AND` | dan |
| `||` | `OR` | atau |
| `(...)` | `(...)` | pengelompokan |

## 🛡️ Pertahanan Keamanan (3 lapis!)

1. **Nama field divalidasi** terhadap skema collection (hanya field yang ADA boleh dipakai)
2. **Nilai lewat parameter binding** — tidak pernah masuk string SQL
3. **Struktur di-parse** — input aneh gagal di parser, bukan di database

## 📁 File yang Dibangun

```
server/src/core/query/
├── lexer.ts        ← Tahap 1: string → tokens
├── parser.ts       ← Tahap 2: tokens → AST
└── sqlBuilder.ts   ← Tahap 3: AST → SQL + params
server/tests/
└── m04-query.test.ts
docs/learnings/
└── M04-query-parser.md  ← jurnal ini
```

## ✅ Definisi Selesai

- [ ] Lexer memecah string jadi token dengan benar
- [ ] Parser membangun AST dengan prioritas benar (kurung, &&, ||)
- [ ] SQL builder menghasilkan WHERE + params terpisah
- [ ] Field yang tidak ada di skema → ditolak
- [ ] Upaya SQL injection → gagal di parser
- [ ] Operator lengkap bekerja (=, !=, >, >=, <, <=, ~, !~, &&, ||, kurung)
- [ ] Test lulus + jurnal diisi

## 📝 Aha! Moments

### Aha! #1 — Compiler itu hanya 3 fungsi sederhana
Selama ini "parser" terdengar seperti sihir tingkat tinggi. Ternyata
intinya hanya: lexer (pecah jadi kata), parser (susun jadi pohon dengan
recursive descent — SATU fungsi per level prioritas), dan walker
(jalan pohon → output). ~300 baris dan kita punya bahasa mini sendiri.
"Compiler" berhenti menjadi kotak hitam.

### Aha! #2 — Recursive descent = prioritas sebagai call stack
Trik elegan parser kita: `parseOr` memanggil `parseAnd`, yang memanggil
`parseComparison`, yang memanggil kurung kembali ke `parseOr`.
Prioritas operator BUKAN ditulis sebagai angka/tabel — ia terwujud
sebagai urutan pemanggilan fungsi. `||` "kalah" dari `&&` karena
`parseOr` menunggu `parseAnd` selesai duluan. Sederhana dan indah.

### Aha! #3 — SQL injection mati karena ARSITEKTUR, bukan kewaspadaan
Pelajaran keamanan terdalam: serangan `' OR '1'='1` TIDAK ditolak —
ia justru diterima sebagai string biasa dan menjadi parameter!
Keamanan yang kuat bukan "berhasil mendeteksi serangan", melainkan
"membuat serangan MUSTAHIL secara struktur". Karena nilai tidak pernah
menyentuh string SQL (hanya array params), TIDAK ADA cara bagi input
user untuk menjadi perintah. Ini level keamanan yang lebih tinggi
daripada "filter input yang mencurigakan".

### Aha! #4 — Test yang salah itu juga pelajaran
Test keamanan pertama saya salah ekspektasi (mengharapkan error padahal
serangan justru dinetralkan dengan benar). Debugging-nya justru
memperdalam pemahaman: lexer membaca `"` sampai `"` penutup, jadi
serangan di dalam string hanyalah data. Kadang test yang "gagal"
mengajarimu lebih banyak daripada yang langsung lulus.

### Aha! #5 — Validasi berlapis itu saling melengkapi
M04 punya TIGA lapis pertahanan: (1) lexer menolak karakter aneh,
(2) builder menolak field yang tidak ada di skema, (3) params memisahkan
nilai dari perintah. Serangan harus menembus KETIGANYA sekaligus.
Inilah "defense in depth" — prinsip yang sama seperti di M03.

### Jembatan ke M05
Sekarang kita bisa: buat collection (M03) + query dengan filter (M04).
Tinggal satu: membungkusnya dalam API generik — `listRecords()` yang
bekerja untuk SEMUA collection tanpa hardcode. Itulah M05, dan dengan
itu fase SQL Database inti selesai!

## ✅ Status: SELESAI (16/16 test M04 lulus, 41/41 total) — 2026-09-11
