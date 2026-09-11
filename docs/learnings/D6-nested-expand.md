# D6 — Nested Expand: Relasi Bertingkat

> **Konsep:** rekursi dalam expand, tetap batch loading di setiap level, dan menghindari N+1 berlapis.

## 🎯 Masalah yang Dipecahkan

Di M12/D2, expand bekerja untuk 1 level:
```typescript
expand: 'user'   // habit → user ✓
```

Tapi dunia nyata sering butuh lebih dalam:
```typescript
expand: 'user.profile'   // habit → user → profile
expand: 'author.company.country'  // post → author → company → country
```

Tanpa nested expand, kamu harus mengambil berlapis-lapis secara manual (N+1 berlapis-lapis!).

## 🧠 Tantangan: N+1 Berlapis

```
Naif (N+1 di SETIAP level):
  ambil 10 habits          → 1 query
  untuk tiap habit: user   → 10 query (level 1)
  untuk tiap user: profile → 10 query (level 2)
  Total: 21 query! 💀

Batch loading di SETIAP level:
  ambil 10 habits                    → 1 query
  kumpulkan userIds, ambil sekaligus → 1 query (level 1)
  kumpulkan profileIds, ambil lagi   → 1 query (level 2)
  Total: 3 query — tidak peduli berapa habits! ✨
```

**Kuncinya: setiap LEVEL melakukan batch loading sendiri**, lalu hasilnya
dirangkai. Rekursi yang tetap efisien.

## 📐 Desain

`expandRecords` sudah punya fondasi rekursi dari M12 (parameter `restSpec`).
D6 memastikan:
1. `author.profile` → proses `author` dulu, lalu `profile` pada hasilnya
2. Setiap level batch loading (kumpulkan semua id level itu → 1 query)
3. Multi-level bekerja untuk single DAN multi relation
4. Kedalaman wajar (batasi untuk mencegah rekursi tak terkendali)

## 📁 Perubahan

```
relations.ts    → perkuat rekursi nested + batasi kedalaman
tests/d6-nested-expand.test.ts → bukti 2-level & 3-level + batch per level
```

## ✅ Definisi Selesai

- [ ] `expand: 'a.b'` bekerja (2 level)
- [ ] `expand: 'a.b.c'` bekerja (3 level)
- [ ] Setiap level batch loading (query count terbukti minimal)
- [ ] Bekerja untuk single & multi relation
- [ ] Kedalaman dibatasi (misal max 5) → lebih dari itu ditolak/diabaikan
- [ ] Test lulus + dokumentasi

## 📝 Aha! Moments

### Aha! #1 — N+1 bisa bersembunyi di SETIAP level rekursi
Bug yang kita perbaiki itu halus: expand level 1 sudah batch (1 query),
tapi level 2 memanggil expand PER target — jadi N query lagi! N+1 tidak
hanya masalah "satu level", melainkan bisa berlapis. Solusinya: kumpulkan
SEMUA target level ini dulu, expand SEKALI untuk semuanya, baru petakan
kembali. Prinsip batch loading harus diterapkan di SETIAP level rekursi.

### Aha! #2 — Rekursi yang efisien = batch dulu, baru turun
Pola yang benar untuk nested expand: jangan "selami dulu satu cabang
sampai dalam", melainkan "selesaikan satu level untuk semua, baru turun
ke level berikutnya". Ini BFS (breadth-first) vs DFS (depth-first) —
dan untuk batch loading, BFS jauh lebih efisien karena setiap level
hanya butuh 1 query.

### Aha! #3 — Batas kedalaman itu bukan kemalasan, melainkan perlindungan
Relasi sirkular (a→b→a→b...) bisa membuat expand tak berujung dan hang.
MAX_EXPAND_DEPTH melindungi dari itu — sistem yang baik menolak bekerja
tanpa henti pada input patologis, daripada crash atau hang.

### 🎉 D6 SELESAI — expand sekarang rekursif DAN efisien
`expand: 'author.profile.city'` bekerja dengan batch loading di setiap
level. Ini menutup kemampuan relasi BaseForge sepenuhnya.

## ✅ Status: SELESAI (4/4 test D6, 101/101 total) — 2026-09-11
