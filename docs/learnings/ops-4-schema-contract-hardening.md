# Ops-4 — Menutup tiga celah yang ditemukan real-test WekanzDashboard

**Status:** SEDANG BERJALAN
**Asal:** provisioning 21 collection WekanzDashboard (2026-09-18) — pemakaian
BaseForge pertama oleh aplikasi multi-collection. Temuan mentah ada di
`docs/learnings/real-test-dashboard-provisioning.md`.

## Masalah

Tiga celah, satu tema: **server membalas sukses padahal permintaan klien tidak
terlaksana.** Ketiganya lolos `tsc`, lolos test yang ada, dan hanya terlihat
kalau seseorang membaca ulang state dari server.

### B1 — `POST /collections` menerima rules salah bentuk tanpa protes

Body yang benar `{ name, fields, rules: { listRule, ... } }`. Mengirim rule
secara flat di tingkat teratas:

```json
{ "name": "preferences", "fields": [...], "listRule": "userId = @request.auth.id" }
```

membalas **201 Created** sementara seluruh rule tersimpan `null`. Rule `null`
berarti mode admin (`decideRule`), jadi end-user tidak bisa mengakses datanya
sama sekali. 21 collection tampak sukses dibuat padahal tidak satu pun berguna.

Tidak terdeteksi karena klien provisioning memakai kredensial admin, dan admin
melewati rules — semuanya terasa normal sampai end-user pertama mencoba.

### B2 — `PATCH /collections/:name` membuang `rules` dalam diam

`PATCH` hanya membaca `body.fields` (`databaseRoutes.ts:158`). Mengirim
`{ rules: {...} }` membalas **200 OK** tanpa mengubah apa pun.

Catatan penting: mengubah rules memang **bisa** lewat
`PATCH /collections/:name/rules` (M11, `publicRoutes.ts:121`) dan lewat `PUT`.
Jadi ini bukan fitur yang hilang — ini balasan 200 yang menyesatkan pada
endpoint yang kebetulan bersebelahan.

Pola "rules diterima lalu dibuang" ini adalah **kekambuhan**: komentar
`schema.ts:117-121` mencatat bug identik pernah diperbaiki di M21 pada jalur
`PUT`. Dua kali muncul di dua rute berbeda = validasi ad-hoc per rute tidak
memadai.

### B3 — Rule pemilik tidak pernah mendapat index

`listRule: "userId = @request.auth.id"` diterjemahkan menjadi `WHERE userId = ?`
pada setiap list (`records.ts:824-830`), tetapi `defineCollection` tidak membuat
index untuk kolom itu dan tidak memperingatkan apa pun.

Terukur pada project dashboard (21 collection, sebelum diperbaiki manual):

```
index non-sistem: 3      ← semuanya milik tabel auth internal
EXPLAIN QUERY PLAN SELECT * FROM investments WHERE userId = ?
  → SCAN investments
```

Aplikasi ini membaca 21 collection saat memuat halaman → 21 full scan per
pemuatan, tumbuh linear terhadap jumlah user dalam project yang sama.

## Rancangan

### B1 — tolak properti tak dikenal di body collection

Server sudah punya kebiasaan ini untuk *record*
(`Field 'updatedAt' does not exist in collection 'quick_notes'`). Bawa
konsistensi yang sama ke jalur schema.

Helper baru di `server/src/core/schema.ts`:

```ts
export function validateCollectionBody(body: Record<string, unknown>): string | null
```

- Daftar putih kunci tingkat teratas: `name`, `type`, `fields`, `indexes`,
  `rules`, `viewQuery`.
- Kunci tak dikenal → pesan error.
- Kunci yang **tepat** merupakan nama rule (`listRule`, `viewRule`,
  `createRule`, `updateRule`, `deleteRule`) mendapat pesan khusus yang
  menunjukkan bentuk benar, karena itu kesalahan yang benar-benar terjadi:
  `unknown field 'listRule' at top level — did you mean rules.listRule?`

Dipasang di `POST /collections` dan `PUT /collections/:name`.

### B2 — `PATCH` tidak boleh membalas 200 untuk rules yang diabaikan

Pilihan: (a) teruskan rules seperti PUT, atau (b) tolak 400.

Dipilih **(b) tolak 400**. Alasan: `PATCH` bersandar pada `updateCollection`
yang secara sengaja hanya bersifat **aditif** (`ALTER TABLE ADD COLUMN`),
sementara rules punya rumah yang sudah benar (`PATCH .../rules` sejak M11).
Menambahkan rules ke sini akan menduplikasi jalur dan membuat dua sumber
kebenaran. Yang salah adalah balasan 200-nya, bukan ketiadaan fiturnya.

Pesan error harus menunjuk jalur yang benar, bukan sekadar menolak:

```
rules cannot be updated via PATCH /collections/:name —
use PATCH /collections/:name/rules or PUT /collections/:name
```

### B3 — buat index otomatis untuk kolom yang direferensikan rule

`validateRuleFields` (`rules.ts:184`) sudah mengekstrak nama field dari string
rule. Pakai ulang mesin yang sama untuk mengumpulkan kolom yang dipakai rule,
lalu buat B-Tree index untuk masing-masing saat collection dibuat/di-rebuild.

Helper baru di `rules.ts`:

```ts
export function collectRuleFieldNames(rules: Partial<CollectionRules>): string[]
```

Aturan:
- Hanya field yang benar-benar ada di skema (abaikan `@request.*`, literal).
- Lewati `id` — sudah PRIMARY KEY.
- Lewati kolom yang sudah punya index (hindari duplikat dengan `IF NOT EXISTS`).
- Nama index: `idx_<collection>_<field>_rule`, akhiran `_rule` supaya jelas
  index ini lahir otomatis dan bukan buatan pengguna.

Ini **aditif dan aman**: index tidak mengubah semantik query, hanya rencana
eksekusi. Index buatan pengguna tidak disentuh.

## File yang berubah

- `server/src/core/rules.ts` — `collectRuleFieldNames()` (baru)
- `server/src/core/schema.ts` — `validateCollectionBody()` (baru),
  pembuatan index rule di `defineCollection` dan `rebuildCollection`
- `server/src/api/databaseRoutes.ts` — pasang validasi di POST & PUT, tolak
  rules di PATCH
- `server/tests/ops-4-schema-contract.test.ts` (baru)
- `docs/admin-api.md` (baru) — bentuk body endpoint admin (celah dokumentasi #4)

## Checklist

- [ ] `collectRuleFieldNames()` + unit-level bukti ekstraksi benar
- [ ] `validateCollectionBody()` menolak flat rules dengan pesan yang menuntun
- [ ] POST menolak body salah bentuk (400, bukan 201)
- [ ] PUT menolak body salah bentuk
- [ ] PATCH menolak `rules` dengan 400 + menunjuk jalur benar
- [ ] index rule dibuat otomatis saat `defineCollection`
- [ ] index rule dibuat saat `rebuildCollection`
- [ ] `EXPLAIN QUERY PLAN` membuktikan `SEARCH ... USING INDEX`, bukan `SCAN`
- [ ] collection lama tanpa index tetap bisa di-rebuild (tidak pecah)
- [ ] `tsc --noEmit` bersih (server + dashboard)
- [ ] full suite hijau, angka dilaporkan
- [ ] `docs/admin-api.md` ditulis
- [ ] README + COMPARISON diperbarui bila perlu

## Aha Moments

(diisi setelah implementasi)
