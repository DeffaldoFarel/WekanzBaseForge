# M03 — Meta-Tables: Database yang Mendeskripsikan Dirinya Sendiri

> **Konsep yang dipelajari:** schema-as-data, SQL generation, tipe field dinamis — inti arsitektur PocketBase.

## 🎯 Tujuan Milestone

Membangun sistem di mana **skema collection disimpan sebagai DATA di dalam database itu sendiri**, dan SQL (`CREATE TABLE` dll.) di-generate secara otomatis dari data itu.

Ini adalah "rahasia" terbesar PocketBase — dan konsep paling elegan di seluruh fase SQL Database.

## 🧠 Masalah yang Dipecahkan

Di M02, kita menulis ini dengan TANGAN:

```sql
CREATE TABLE habits (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  streak INTEGER DEFAULT 0,
  created TEXT ...
);
```

Tapi PocketBase tidak menulis SQL untuk setiap collection. Kalau kamu membuat collection "posts" lewat UI-nya, tabel `posts` terbentuk otomatis. Bagaimana?

## 💡 Ide Jeniusnya: Skema itu Data

```
┌──────────────────────────────────────────────────────────┐
│  Tabel _collections (META — data TENTANG collections)    │
├────────────┬─────────────────────────────────────────────┤
│ id         │ name    │ fields (JSON)                     │
├────────────┼─────────┼───────────────────────────────────┤
│ c1         │ habits  │ [                                 │
│            │         │   {name:'title', type:'text',     │
│            │         │    required:true},                │
│            │         │   {name:'streak', type:'number'}  │
│            │         │ ]                                 │
│ c2         │ posts   │ [ {name:'body', type:'text'} ]    │
└────────────┴─────────┴───────────────────────────────────┘
         │
         ▼  GENERATE (kode kita membaca data ini → membuat SQL)
┌──────────────────────────────────────────────────────────┐
│  Tabel habits (ASLI — hasil generate)                    │
│  CREATE TABLE habits (id TEXT PK, title TEXT NOT NULL,   │
│                       streak REAL, ...)                  │
└──────────────────────────────────────────────────────────┘
```

**Skema collection disimpan sebagai baris di tabel `_collections` — dan kode kita menerjemahkannya menjadi tabel sungguhan.**

Inilah pola "meta-database" yang sama dengan M00 (`platform.db` menyimpan data TENTANG projects) — sekarang di level yang lebih dalam.

## 📐 Desain M03

### Tipe field yang didukung (subset PocketBase)

| Tipe BaseForge | Tipe SQLite | Contoh |
|----------------|-------------|--------|
| `text` | TEXT | judul, nama |
| `number` | REAL | streak, harga |
| `bool` | INTEGER (0/1) | isActive |
| `email` | TEXT (dengan validasi format) | email user |
| `date` | TEXT (ISO 8601) | deadline |
| `json` | TEXT (JSON string) | settings bebas |
| `relation` | TEXT (id record lain) | penunjuk ke collection lain (M12) |

### Field sistem otomatis (seperti PocketBase)

Setiap collection OTOMATIS mendapat:
```
id      TEXT PRIMARY KEY   ← 15-char random (dari M00!)
created TEXT               ← timestamp ISO otomatis
updated TEXT               ← diupdate setiap perubahan
```

### API yang dibangun

```typescript
// 1. Definisikan collection → tabel terbentuk
await defineCollection(projectDb, {
  name: 'habits',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'streak', type: 'number' },
    { name: 'done', type: 'bool' },
  ],
});

// 2. Lihat skema yang tersimpan
await getCollection(projectDb, 'habits');
// → { id: 'c1', name: 'habits', fields: [...] }

// 3. Update skema → ALTER TABLE otomatis (tambah kolom)
await updateCollection(projectDb, 'habits', {
  fields: [ ..., { name: 'note', type: 'text' } ]  // kolom baru!
});

// 4. Hapus collection → DROP TABLE
await deleteCollection(projectDb, 'habits');
```

### Mapping tipe → SQL

```typescript
function fieldToSql(field): string {
  switch (field.type) {
    case 'text':    return `"${field.name}" TEXT ${req(field)}`;
    case 'number':  return `"${field.name}" REAL ${req(field)}`;
    case 'bool':    return `"${field.name}" INTEGER DEFAULT 0 ${req(field)}`;
    // ... dst
  }
}
// req(field) = field.required ? 'NOT NULL' : ''
```

## ⚠️ Aturan Penting (yang juga berlaku di PocketBase)

1. **Nama collection & field divalidasi** — hanya `[a-z0-9_]` supaya aman disisipkan ke SQL (nama tidak bisa lewat parameter binding!)
2. **Tambah kolom** = `ALTER TABLE ADD COLUMN` — aman
3. **Hapus/ubah tipe kolom** = SQLite tidak bisa `DROP COLUMN` dengan mudah → untuk M03 kita batasi: hanya bisa TAMBAH kolom, tidak bisa hapus/ubah tipe (PocketBase punya mekanisme table-rebuild untuk ini — advanced!)
4. **`_collections` diawali underscore** — konvensi PocketBase: underscore = tabel sistem, jangan disentuh user

## 📁 File yang Dibangun

```
server/src/core/
├── schema.ts       ← defineCollection, getCollection, update, delete
└── fieldTypes.ts   ← mapping tipe → SQL + validasi
server/tests/
└── m03-schema.test.ts
docs/learnings/
└── M03-meta-tables.md  ← jurnal ini
```

## ✅ Definisi Selesai

- [ ] `_collections` tabel meta terbentuk
- [ ] `defineCollection` membuat tabel asli dengan kolom yang benar
- [ ] Field sistem (id/created/updated) otomatis ada
- [ ] Validasi nama collection/field (tolak nama aneh → anti SQL injection)
- [ ] Tambah kolom via updateCollection → ALTER TABLE
- [ ] deleteCollection → DROP TABLE + hapus dari meta
- [ ] INSERT record ke tabel hasil generate → bekerja (bukti nyata!)
- [ ] Test lulus + jurnal diisi

## 🌉 Jembatan ke M04/M05

Setelah tabel bisa terbentuk dari data, dua pertanyaan berikutnya:
1. "Bagaimana cara QUERY-nya?" → M04: query parser (filter string → SQL)
2. "Bagaimana CRUD-nya lewat API?" → M05: record API generik

## 📝 Aha! Moments

### Aha! #1 — Skema itu DATA, dan itu mengubah segalanya
Selama M02, skema ada di kepala programmer (ditulis tangan sebagai SQL).
Di M03, skema pindah ke dalam database sebagai baris di `_collections`.
Sekali skema menjadi data, ia bisa: dibaca, diubah, divalidasi, dan
yang terpenting — DIPROSES oleh kode. "CREATE TABLE" berubah dari
tulisan tangan menjadi OUTPUT dari fungsi. Inilah momen ketika
database berhenti menjadi tempat pasif dan mulai mendeskripsikan
dirinya sendiri.

### Aha! #2 — Fungsi murni adalah kunci testability
`generateCreateTableSql()` tidak menyentuh database sama sekali —
ia murni data → string SQL. Karena itu ia bisa di-test tanpa database,
tanpa setup, tanpa cleanup. Pemisahan "membuat SQL" (murni) dari
"menjalankan SQL" (efek samping) adalah pola yang akan kita temui
terus di sistem yang baik.

### Aha! #3 — Dua lapisan pertahanan untuk nama
Nama tabel/kolom TIDAK BISA lewat parameter binding (itu hanya untuk
nilai). Jadi satu-satunya pertahanan adalah validasi di dua lapis:
(1) regex ketat `[a-z][a-z0-9_]*`, (2) dibungkus double-quote.
Ini prinsip "defense in depth" — jangan andalkan satu lapisan.
Nama `habits"; DROP TABLE users; --` langsung ditolak di lapisan pertama.

### Aha! #4 — SQLite tidak bisa semuanya, dan itu OK
Menghapus kolom itu ternyata SULIT di SQLite (harus rebuild tabel).
PocketBase punya mekanisme khusus untuk ini. Pelajaran: bahkan
database matang punya batasan — sistem yang baik mengakuinya secara
eksplisit (kita menolak dengan pesan jelas) daripada gagal diam-diam.

### Aha! #5 — sqlite_master: database yang tahu isinya
Test membuktikan tabel terbentuk lewat `SELECT name FROM sqlite_master`
— tabel katalog bawaan SQLite yang mendata semua tabel. Jadi konsep
"meta-data tentang struktur" itu BUKAN ciptaan kita — SQLite sendiri
sudah melakukannya! Kita hanya menambahkan lapisan `_collections`
di atasnya untuk level yang lebih tinggi (tipe 'text'/'bool', required,
dll. yang tidak diketahui SQLite).

### Jembatan ke M04/M05
Sekarang tabel bisa terbentuk dari data. Dua pertanyaan berikutnya:
1. "Bagaimana cara QUERY generiknya?" → M04: query parser
   (filter string seperti `streak > 5 && title ~ "a"` → SQL WHERE)
2. "Bagaimana CRUD-nya lewat API?" → M05: record API generik
   (satu set endpoint untuk SEMUA collection)

## ✅ Status: SELESAI (9/9 test lulus, bukti nyata tabel generate berfungsi) — 2026-09-11
