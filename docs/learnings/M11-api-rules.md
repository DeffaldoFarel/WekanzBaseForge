# M11 — API Rules: Row-Level Security

> **Konsep:** rules per collection (list/view/create/update/delete), evaluasi `@request.auth.*`, dan rekomposisi query parser M04 untuk keamanan.

## 🎯 Masalah yang Dipecahkan

Sampai sekarang, siapa pun yang punya akses API bisa membaca SEMUA data.
Untuk produksi (multi-user), kebutuhannya:

```
"User hanya boleh melihat habits miliknya SENDIRI"
"Semua orang boleh membaca posts publik"
"Hanya pembuat yang boleh menghapus komentarnya"
```

Inilah API rules — kebijakan keamanan per collection, per operasi.

## 🧠 Semantik PocketBase (yang kita tiru)

Setiap collection punya 5 rules:

| Rule | Mengatur |
|------|----------|
| `listRule` | siapa boleh LIST |
| `viewRule` | siapa boleh lihat 1 record |
| `createRule` | siapa boleh buat |
| `updateRule` | siapa boleh ubah |
| `deleteRule` | siapa boleh hapus |

**Nilai rule punya 3 makna:**

| Nilai | Arti |
|-------|------|
| `null` | 🔒 Hanya admin |
| `""` (kosong) | 🌐 Publik (siapa pun, bahkan tanpa login) |
| `"rule string"` | 🧮 Evaluasi rule — hanya record yang cocok |

## 💡 Kejeniusan Arsitektur: Rules = Query Parser M04!

Rule ditulis dengan bahasa filter yang SAMA dengan M04:

```
listRule: 'user = @request.auth.id'
                ↓  parser M04 (+ @request support)
          WHERE user = ?  params [authUserId]
```

`@request.auth.id` di-resolve menjadi id user yang sedang login —
nilai di-bind sebagai parameter (anti SQL injection otomatis, warisan M04!).

Kalau rule merujuk @request tapi user belum login → `1 = 0` (tidak ada
baris yang cocok — default aman).

## 📐 Semantik Evaluasi per Operasi

| Operasi | Cara evaluasi |
|---------|---------------|
| list | rule jadi WHERE tambahan (digabung dengan filter user) |
| view | `WHERE id = ? AND (rule)` — record harus lolos rule |
| update | record EXISTING harus lolos rule sebelum diubah |
| delete | record EXISTING harus lolos rule sebelum dihapus |
| create | rule dievaluasi terhadap DATA yang dikirim (JS evaluator) |

## 📁 Perubahan

```
query/lexer.ts    → token AT_IDENT (@request.auth.id)
query/parser.ts   → @request di posisi field & value
query/sqlBuilder.ts → resolve @request → bind param; flip operator
core/rules.ts     → decideRule + evaluateRuleOnData
core/schema.ts    → rules di definisi & meta
core/records.ts   → RuleContext + enforcement di CRUD + ForbiddenError
```

## ✅ Definisi Selesai

- [ ] Rules tersimpan di meta collection
- [ ] list: rule memfilter rows; null → kosong untuk user biasa
- [ ] view: record milik orang lain → null
- [ ] create: data melanggar rule → ForbiddenError
- [ ] update/delete: record milik orang lain → ForbiddenError
- [ ] Rule "" (publik) → anonymous bisa akses
- [ ] Rule null → hanya admin (bypass tanpa ctx)
- [ ] @request.auth.id/email/verified ter-resolve
- [ ] Test lulus + jurnal

## 📝 Aha! Moments

### Aha! #1 — Rules adalah filter biasa (rekomposisi M04!)
Tidak ada evaluator baru untuk rules SQL — `listRule` HANYA filter M04
dengan `@request.auth.id` yang di-resolve jadi bind parameter. Query
parser yang dibangun di M04 ternyata adalah separuh dari sistem
keamanan. "Build once, compose forever."

### Aha! #2 — @request di sisi FIELD adalah kondisi KONSTAN, bukan kolom
`@request.auth.id = "xyz"` TIDAK berarti `WHERE id = 'xyz'` (kesalahan
umum yang mengfilter baris berdasarkan id!). Kedua sisi adalah konstanta
request → dievaluasi di JS → `1=1` atau `1=0` untuk SEMUA baris.

### Aha! #3 — Tiga makna rule = matriks akses yang elegan
`null` → admin-only | `""` → publik | `"expr"` → evaluasi. Ditambah
`@request` yang resolve ke `null` untuk anonymous → `1=0` (default
aman). Semua kasus keamanan tercakup tanpa SATU PUN `if role == 'admin'`
yang tersebar di kode.

### Aha! #4 — getRecordRaw: rules untuk pengguna, bypass untuk mesin
Bug terbesar M11: panggilan INTERNAL (updateRecord ambil record sebelum
cek rule) ikut kena viewRule → update selalu gagal. Solusi: pisahkan
`getRecordRaw` (internal, tanpa rules) dari `getRecord` (publik, dengan
rules). Pelajaran arsitektur: keamanan harus di LAPISAN API, bukan
menular ke fungsi internal yang dipakai mesin sendiri.

### Aha! #5 — reqCtx sebagai "penanda identitas" yang serba-guna
`undefined` = admin (bypass semua) | `{ auth: {...} }` = end user
(rules dievaluasi) | `{ auth: null }` = anonymous (rule @request → 1=0).
SATU parameter opsional mengelola tiga tingkat akses tanpa middleware
baru — hanya dengan semantik yang disiplin.

## ✅ Status: SELESAI (12/12 test M11, 178/178 total) — 2026-09-12
