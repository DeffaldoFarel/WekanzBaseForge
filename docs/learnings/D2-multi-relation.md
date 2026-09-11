# D2 — Multi-Relation: Satu Record, Banyak Rujukan

> **Konsep:** relation array, expand array, dan maxSelect validation.

## 🎯 Masalah yang Dipecahkan

Di M12, satu field relation hanya bisa menunjuk SATU record:
```typescript
{ title: 'Olahraga', user: 'u1' }   // hanya 1 user
```

Tapi dunia nyata penuh hubungan satu-ke-banyak:
```typescript
{ title: 'Post tentang SQLite', tags: ['tag1', 'tag2', 'tag3'] }  // BANYAK tags!
{ name: 'Proyek A', members: ['u1', 'u2', 'u5'] }                 // BANYAK members!
```

## 🧠 Keputusan Desain: Simpan sebagai JSON Array

Cara PocketBase & banyak database dokumen: field relation multi disimpan
sebagai **JSON array of ids** dalam SATU kolom:

```
posts
┌────┬───────────────────┬──────────────────────────┐
│ id │ title             │ tags                     │
├────┼───────────────────┼──────────────────────────┤
│ p1 │ Belajar SQLite    │ ["tag1","tag2","tag3"]   │  ← JSON array!
│ p2 │ Tips Produksi     │ ["tag2"]                 │
└────┴───────────────────┴──────────────────────────┘
```

**Kenapa bukan tabel penghubung (junction table)?** Itu cara relasional
klasik (post_tags: post_id + tag_id). Untuk gaya dokumen/BaseForge,
JSON array lebih sederhana dan cukup untuk kebanyakan kasus. PocketBase
juga memakai pendekatan serupa.

## 📐 Desain

### 1. Field definition dengan maxSelect
```typescript
{
  name: 'tags',
  type: 'relation',
  options: {
    collectionId: 'tags',
    maxSelect: 5,   // >1 = multi-relation (array); 1/undefined = single
  },
}
```

**Aturan:**
- `maxSelect` tidak diisi atau `1` → single relation (string id, seperti M12)
- `maxSelect > 1` → multi relation (array of ids, maksimal maxSelect elemen)

### 2. Penyimpanan
```
single: user = "u1"                        (TEXT biasa)
multi:  tags = '["tag1","tag2"]'           (JSON string di kolom TEXT)
```

### 3. Serialize/Deserialize (di records.ts)
```
User kirim:  ['tag1', 'tag2']  → simpan: '["tag1","tag2"]'  (JSON.stringify)
DB mentah:   '["tag1","tag2"]' → user terima: ['tag1','tag2'] (JSON.parse)
```

### 4. Validasi
- Nilai multi harus array
- Setiap elemen harus string (id)
- Panjang array ≤ maxSelect

### 5. Expand (relations.ts)
```
single: expand.user  → { id, name }              (object)
multi:  expand.tags  → [{id,name}, {id,name}]    (ARRAY of objects)
```
Batch loading tetap dipakai: kumpulkan SEMUA id dari SEMUA array,
satu query IN(...), lalu petakan kembali per record.

## 📁 Perubahan

```
fieldTypes.ts   → maxSelect + validasi multi (array, panjang, tipe elemen)
records.ts      → serialize/deserialize multi-relation (JSON array)
relations.ts    → expand multi (hasilkan array of objects)
tests/d2-multi-relation.test.ts → bukti semua skenario
```

## ✅ Definisi Selesai

- [ ] maxSelect > 1 → nilai disimpan sebagai JSON array
- [ ] Validasi: nilai non-array ditolak; melebihi maxSelect ditolak
- [ ] Serialize: array → JSON string; Deserialize: JSON string → array
- [ ] Expand multi menghasilkan ARRAY of objects
- [ ] Expand multi memakai batch loading (bukan N+1)
- [ ] Single relation (maxSelect 1) tetap bekerja seperti M12 (kontrol)
- [ ] Test lulus + dokumentasi

## 📝 Aha! Moments

### Aha! #1 — Satu kolom bisa menampung banyak relasi (JSON array)
Multi-relation tidak butuh tabel penghubung yang rumit — cukup satu kolom
berisi JSON array of ids: `["tag1","tag2","tag3"]`. Ini pendekatan dokumen
yang jauh lebih sederhana daripada junction table relasional, dan cukup
untuk kebanyakan kasus nyata (tags, members, categories).

### Aha! #2 — maxSelect adalah batas yang melindungi data
Tanpa maxSelect, satu field bisa diisi ribuan id dan membengkak tak
terkendali. Validasi maxSelect di level create/update memastikan ukuran
array tetap masuk akal — dan sekali lagi, ditegakkan SEBELUM data masuk,
bukan setelah jadi masalah.

### Aha! #3 — Expand harus toleran terhadap bentuk data mentah
Bug yang kita temui: expand gagal karena nilai multi masih berupa string
JSON (belum di-deserialize). Pelajaran: fungsi yang bekerja di "batas
antara" lapisan (expand membaca hasil query) harus toleran terhadap
berbagai bentuk input — array yang sudah di-parse ATAU string mentah.
Defensive coding di titik sambung itu penting.

### Aha! #4 — Serialize/deserialize harus simetris di SETIAP tipe baru
Setiap kali menambah tipe field, kita harus memastikan pasangan
serialize (user→DB) dan deserialize (DB→user) keduanya diperbarui.
Lupa salah satu = data "nyangkut" dalam bentuk mentah. Ini kenapa
pola "satu tempat untuk satu tipe" (fieldTypes sebagai sumber kebenaran)
sangat membantu.

### 🎉 D2 SELESAI — relasi sekarang satu-ke-banyak
Single (M12) DAN multi (D2) relation bekerja berdampingan, keduanya
dengan expand + batch loading. Ini menutup hampir semua kebutuhan
relasi di aplikasi nyata.

## ✅ Status: SELESAI (7/7 test D2, 80/80 total) — 2026-09-11
