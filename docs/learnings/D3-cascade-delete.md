# D3 — Cascade Delete: Mencegah Data Yatim

> **Konsep:** referential integrity, orphan records, dan 3 strategi delete: cascade, setNull, restrict.

## 🎯 Masalah yang Dipecahkan

```typescript
// Ada user dan habits yang menunjuk ke user itu:
users:  { id: 'u1', name: 'Farel' }
habits: { id: 'h1', title: 'Olahraga', user: 'u1' }
        { id: 'h2', title: 'Baca', user: 'u1' }

// Kalau user 'u1' DIHAPUS, apa yang terjadi dengan h1 & h2?
deleteRecord('users', 'u1');
```

Tanpa aturan, habits tetap ada tapi `user: 'u1'` menunjuk ke record yang
**sudah tidak ada** — inilah "orphan record" (data yatim). Data yatim adalah
sumber bug tersembunyi: expand gagal, laporan salah, join rusak.

## 🧠 Tiga Strategi (seperti SQL foreign keys)

| Strategi | Perilaku saat induk dihapus | Kapan dipakai |
|----------|------------------------------|---------------|
| **cascade** | Ikut menghapus semua record yang merujuk | Data anak tidak berarti tanpa induk (habits tanpa user) |
| **setNull** | Mengosongkan field relasi anak (jadi null) | Anak tetap berarti, hanya kehilangan rujukan (komentar kehilangan author) |
| **restrict** | MENOLAK penghapusan kalau masih ada yang merujuk | Induk tidak boleh dihapus sembarangan (user dengan transaksi) |

```
deleteRecord('users', 'u1'):

cascade  → habits h1,h2 IKUT TERHAPUS
setNull  → habits h1,h2 tetap ada, tapi user = null
restrict → ERROR: "tidak bisa hapus, masih ada 2 habits yang merujuk"
```

## 📐 Desain

### 1. Tambah `cascadeDelete` di options relation
```typescript
{
  name: 'user',
  type: 'relation',
  options: {
    collectionId: 'users',
    cascadeDelete: 'cascade' | 'setNull' | 'restrict',  // default: 'setNull'
  },
}
```

### 2. Logika di deleteRecord
Saat menghapus record X dari collection A:
1. Cari SEMUA collection lain yang punya field relation menunjuk ke A
2. Untuk setiap record yang merujuk ke X:
   - cascade → hapus record itu
   - setNull → set field relasinya jadi null
   - restrict → lempar error, batalkan penghapusan
3. Baru hapus X

### 3. Multi-relation juga harus ditangani (D2!)
```
cascade  → hapus record anak
setNull  → HAPUS id X dari ARRAY relasi anak (bukan null-kan seluruhnya!)
restrict → error kalau X ada di array manapun
```

### 4. Restrict harus ATOMIK
Cek restrict dulu SEBELUM menghapus apapun — kalau ada yang melarang,
tidak boleh ada perubahan sama sekali (semua atau tidak sama sekali).
Bungkus dalam transaksi (M07!).

## 📁 Perubahan

```
fieldTypes.ts   → cascadeDelete di options + validasi nilainya
records.ts      → deleteRecord dengan logika cascade/setNull/restrict
tests/d3-cascade-delete.test.ts → bukti ketiga strategi + multi-relation
```

## ✅ Definisi Selesai

- [ ] cascade: hapus induk → anak ikut terhapus
- [ ] setNull: hapus induk → field relasi anak jadi null (default)
- [ ] restrict: hapus induk yang masih dirujuk → ditolak dengan pesan jelas
- [ ] Multi-relation: setNull menghapus id dari array (bukan null seluruhnya)
- [ ] Restrict atomik: gagal total, tidak ada perubahan sebagian
- [ ] Semua dalam satu transaksi
- [ ] Test lulus + dokumentasi

## 📝 Aha! Moments

### Aha! #1 — Relasi itu dua arah, dan arah baliknya yang berbahaya
Selama ini kita melihat relasi dari sisi "record menunjuk ke mana"
(habit.user → user). D3 memaksa kita melihat arah SEBALIKNYA: "siapa yang
menunjuk ke sini?" — dan itu jauh lebih sulit karena harus mencari di
SEMUA collection. Data yatim lahir dari melupakan arah balik ini.

### Aha! #2 — Tiga strategi = tiga filosofi kepemilikan data
- cascade: "anak tidak berarti tanpa induk" (habits milik user)
- setNull: "anak berdiri sendiri, hanya kehilangan rujukan" (komentar tanpa author)
- restrict: "induk terlalu penting untuk dihapus sembarangan" (user dengan transaksi)
Tidak ada yang "paling benar" — pilihan strategi adalah KEPUTUSAN BISNIS
tentang makna data, bukan sekadar teknis.

### Aha! #3 — setNull pada multi-relation itu beda: hapus dari array, bukan null-kan
Detail penting yang mudah terlewat: pada multi-relation, setNull BUKAN
menjadikan seluruh field null — melainkan menghapus HANYA id yang dihapus
dari array, menyisakan yang lain. `[t1,t2,t3]` hapus t2 → `[t1,t3]`.
Operasi "hapus dari array" vs "kosongkan nilai" itu berbeda makna.

### Aha! #4 — Restrict harus atomik, dan itu butuh transaksi
Kalau kita memproses cascade dulu baru menemukan restrict di tengah,
sebagian data sudah terhapus sebelum penghapusan dibatalkan — bencana!
Dengan membungkus SEMUANYA dalam SATU transaksi (M07): kalau ada restrict
yang melarang, ROLLBACK mengembalikan keadaan — tidak ada perubahan
sebagian. Atomicity menyelamatkan integritas data.

### 🎉 D3 SELESAI — tidak ada lagi data yatim
Referential integrity terjaga: hapus induk tidak akan meninggalkan
record yang menunjuk ke "ketiadaan". Ini syarat penting data produksi
yang bersih dan bisa dipercaya.

## ✅ Status: SELESAI (6/6 test D3, 86/86 total) — 2026-09-11
