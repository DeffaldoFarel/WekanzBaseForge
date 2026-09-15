# M22 — Redesign Sistem Desain Dashboard

## Masalah (berdasarkan audit terukur)

Dashboard tumbuh organik selama M01–M21 tanpa satu sumber desain. Hasilnya 3 masalah nyata:

1. **Styling di-hardcode ke `globals.css`, bukan ke komponen.** 31 class CSS tulisan tangan (`btn`, `btn-danger`, `card`, `field`, `input`, `modal-overlay`, `modal-box`, `badge`, `studio-*`, `nav-chip`, `topbar`, …) hidup **paralel** dengan shadcn. Halaman memakai `<button className="btn btn-secondary">` mentah padahal shadcn punya `<Button variant="secondary">`.
2. **shadcn baru 6 komponen.** Dari 60+ yang tersedia, repo baru punya `button, card, dialog, input, badge, tabs`. Akibatnya: **71 raw `<button>` vs 15 `<Button>`**, **54 raw `<input>` vs 5 `<Input>`**.
3. **Satu halaman raksasa.** `[collection]/page.tsx` = 1464 baris / 60KB memakai 20 dari 31 class kustom — sistem desain sendiri di dalam repo.

**Yang sudah benar (jangan dirusak):** warna sudah konsisten (palet Neo-Tactile sama di semua halaman), dan halaman **Storage** sudah pakai `Card/Button/Input/Badge/Dialog` shadcn dengan benar. Jadi polanya sudah ada — tinggal diratakan.

## Prinsip (dari referensi Supabase / PocketBase / Appwrite)

- **Satu sumber token.** Semua warna/spacing/radius dari CSS custom property semantik shadcn (`--background`, `--primary`, `--destructive`, `--muted`, `--border`, `--ring`, `--radius`). Tidak ada hex tersebar di komponen.
- **Komponen, bukan class.** Setiap kontrol pakai komponen shadcn dari `components/ui/`. Class tangan di `globals.css` dihapus seiring komponennya tersedia.
- **Palet Neo-Tactile Light Mode dipertahankan** (canvas `#DDE3EA`, card putih, jet black `#0A0B0D`, emerald `#3ECF8E` brand, pastel semantik) — yang berubah adalah *cara ia didistribusikan*, bukan warnanya.

## Desain

### Token semantik (globals.css — HSL shadcn murni)

| Token | Nilai | Pakai untuk |
|---|---|---|
| `--background` | `#DDE3EA` | canvas halaman |
| `--foreground` | `#1A1D23` | teks utama |
| `--card` / `--card-foreground` | `#FFFFFF` | permukaan kartu |
| `--popover` | `#FFFFFF` | dropdown/popover |
| `--primary` | `#0A0B0D` | tombol utama, pill aktif |
| `--secondary` | `#EFF3F8` | permukaan lunak |
| `--muted` / `--muted-foreground` | `#EFF3F8` / `#7E8896` | teks sekunder |
| `--accent` | `#E6ECF5` | hover/selection |
| `--destructive` | `#EB7167` | hapus / bahaya |
| `--border` / `--input` / `--ring` | abu lembut | border & focus |
| `--brand` (baru) | `#3ECF8E` | logo emerald — satu-satunya aksen non-netral yang dipertahankan |
| `--radius` | `1.25rem` (20px) | sudut kartu; `9999px` untuk pill |

### Komponen shadcn yang ditambahkan (yang dibutuhkan dashboard)

`select`, `checkbox`, `label`, `dropdown-menu`, `table`, `alert-dialog` (ganti konfirmasi hapus manual), `tooltip`, `skeleton`, `textarea`, `separator`, `scroll-area`. (Toast ditiadakan dulu — pakai pola `notice` yang ada, diganti di fase halaman.)

### Pemetaan class tangan → komponen

| Class tangan | Ganti dengan |
|---|---|
| `.btn` / `.btn-secondary` / `.btn-danger` / `.btn-icon` | `<Button variant="default|secondary|destructive|ghost" size="icon">` |
| `.input` / `.field` | `<Input>` + `<Label>` |
| `.card` | `<Card>` |
| `.modal-overlay` + `.modal-box` | `<Dialog>` |
| `.badge` / `.badge-gray` | `<Badge variant="...">` |
| `.studio-tabs` / `.studio-tab` | `<Tabs>` |
| konfirmasi hapus `window.confirm`/modal manual | `<AlertDialog>` |
| `.nav-chip` / `.topbar` | tetap di `Navbar.tsx` tapi lewat token, bukan hex |

## Checklist Fase 1 (fondasi)

- [x] Tulis ulang `globals.css`: token semantik murni, pertahankan `--brand` + `@keyframes bf-spin`; class tangan dikembalikan dengan label DEPRECATED (dihapus bertahap per halaman).
- [x] Tambah komponen shadcn inti ke `components/ui/`: `select`, `checkbox`, `label`, `textarea`, `skeleton`, `separator`, `alert-dialog`, `table`, `dropdown-menu`, `tooltip`.
- [x] `npx tsc --noEmit` di dashboard → 0 error.
- [x] Verifikasi render halaman `/login` + `/projects` + `/database/[collection]` tidak rusak.

## Aha Moments

1. **Token sudah benar, distribusinya yang salah.** Palet Neo-Tactile sudah konsisten di semua halaman (`#3ECF8E`, `#0A0B0D`, `#5B86E5`). Masalahnya bukan warna, melainkan *cara warna didistribusikan*: 31 class tangan di `globals.css` hidup paralel dengan shadcn. Solusinya bukan mengganti warna, melainkan memindahkan styling ke komponen dan menghapus class tangan secara bertahap.

2. **Halaman yang sudah benar adalah panduan, bukan referensi eksternal.** Storage sudah pakai `Card/Button/Input/Badge/Dialog` shadcn dengan benar. Tidak perlu mencontek Supabase untuk pola dasar — cukup ratakan pola Storage ke halaman lain.

3. **Menghapus class tangan sekaligus merusak halaman.** `globals.css` dihapus total → `/database/[collection]` langsung kosong (layout, sidebar, tabel hilang). Solusinya: kembalikan class tangan dengan label DEPRECATED, lalu hapus per halaman saat halaman itu dirombak.

4. **Regenerasi lockfile bisa kehilangan paket secara senyap.** `package-lock.json` yang dihapus dan dibuat ulang bisa kehilangan entri (`sharp` hilang, `grep -c` = 0), padahal `npm install` exit 0. Server crash dengan `ERR_MODULE_NOT_FOUND`. Satu-satunya cara pasti: hapus lockfile + semua `node_modules`, lalu install dari nol, dan verifikasi `grep -c "node_modules/sharp" package-lock.json` = 1.

## Status

**SELESAI (Fase 1 — Fondasi)**: 10 komponen shadcn baru, `tsc` 0 error, halaman terverifikasi tidak rusak. Class tangan masih ada di `globals.css` dengan label DEPRECATED, menunggu dihapus per halaman di fase berikutnya.

