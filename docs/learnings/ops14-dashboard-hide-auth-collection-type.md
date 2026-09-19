# Ops-14 — Hilangkan opsi collection `type=auth` dari dashboard admin

**Tanggal:** 2026-09-19
**Commit:** (belum — lokal dulu atas permintaan user; push + deploy setelah dinilai stabil)
**Konteks:** Pertanyaan produk terbuka dari Ops-13. Diputuskan user: **hilangkan**.

## Masalah

Sejak Ops-12 tidak ada endpoint login untuk collection `type=auth`
(`auth-with-password` dkk. sudah 404). Tapi `CreateCollectionModal` di dashboard
admin masih menawarkan **Type → Auth**, lengkap dengan badge system-field
`email`/`password`/`verified` dan preset field `name`+`avatar`. Itu mengiklankan
kapabilitas yang tidak ada: user membuat "auth collection" lalu tidak menemukan
cara login ke dalamnya.

## Batas perubahan — apa yang SENGAJA dipertahankan

Yang dicabut hanya **jalur pembuatan**. Collection `type=auth` yang sudah ada
(mis. `explore_users` di produksi) harus tetap tampil dan berperilaku benar:

| Tempat | Keputusan | Alasan |
|---|---|---|
| `CreateCollectionModal.tsx` — opsi Auth, ikon `Users`, badge email/password/verified, preset field | **DIHAPUS** | jalur pembuatan |
| `database/page.tsx` + `StudioSidebar.tsx` — badge "Auth" pada listing | **TETAP** | collection lama harus berlabel benar, bukan salah tampil sebagai "Base" |
| `RecordFormModal.tsx` — field password untuk `type=auth` | **TETAP** | record di collection lama masih punya `password_hash`; edit tanpa password harus tetap tidak menimpa hash |
| Server `defineCollection` menerima `type:'auth'` | **TETAP** | tidak disentuh — Admin API tetap bisa membuatnya bila memang perlu tabel dengan hash tersaring; ini perubahan UI, bukan kontrak API |

## Perubahan

- [x] `dashboard/components/CreateCollectionModal.tsx`: tipe state `"base" | "view"`, opsi `<SelectItem value="auth">` dihapus, handler preset field auth dihapus, badge system-field auth dihapus, cabang ikon `Users` dihapus, 3 import lucide yatim (`Users`, `Mail`, `Check`) dibuang — `Lock` tetap (masih dipakai di tab Rules)
- [x] `npx tsc --noEmit` dashboard → 0 error
- [x] **Bukti UI (DOM, bukan screenshot)** di `localhost:7701`:
  - Modal Create collection → opsi Type = **`['Base', 'View']`**
  - Project `ops12app` yang punya `ops12_users` (type auth) → listing tetap menampilkan **badge `Auth`** + "Auth Collection · 3 fields · 2 records"
- [ ] Push + deploy — **menunggu keputusan user**

## Aha Moments

1. **"Hilangkan fitur" hampir selalu berarti "hilangkan jalur MEMBUAT, pertahankan jalur MELIHAT".**
   Data yang sudah ada tidak ikut hilang saat opsinya dicabut. Kalau badge "Auth"
   ikut dihapus, `explore_users` di produksi akan tampil sebagai "Base" — label
   yang salah dan menyesatkan untuk tabel yang menyimpan `password_hash`.
   Sebelum menghapus cabang `type === "auth"` mana pun, tanyakan: cabang ini
   untuk *membuat* atau untuk *menampilkan yang sudah ada*?

2. **Bukti UI harus dua arah: yang dihapus HILANG dan yang dipertahankan MASIH ADA.**
   Membuktikan opsi "Auth" hilang dari dropdown saja tidak cukup — regresi paling
   mungkin dari perubahan ini justru di sisi lain (badge/form untuk data lama).
   Kedua asersi dijalankan terhadap DOM nyata dengan data nyata (`ops12_users`).

3. **Vault yang terikat origin produksi tidak bisa dipakai untuk dashboard lokal — dan itu benar.**
   `BaseForge Console` di vault terikat `https://baseforge.wekanz.id`. Untuk
   `localhost:7701`, jalannya: reset password admin dev lokal via CLI Ops-5
   (`reset-admin-password`), bukan memaksa vault lintas origin. Admin lokal
   `ops5-admin@test.local` adalah sisa test Ops-5, bukan akun asli.

## Catatan lingkungan

- `platform.db` lokal berisi **918 project** sisa test. Tidak disentuh di pass ini
  (di luar scope), tapi ini kandidat bersih-bersih — lihat pitfall "mass-clean"
  di skill (matikan server dulu, dua langkah: rows + folder).
