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

## Checklist Fase 2 (rombak halaman)

- [x] `[collection]/page.tsx` — 1464 → 620 baris (-58%), 9 komponen studio terpisah (`StudioSidebar`, `StudioTabs`, `RecordsTab`, `SchemaTab`, `RulesTab`, `ImportExportTab`, `RawJsonModal`, `DuplicateModal`, `RecordFormModal`, `RenderTableCell`)
- [x] `CreateCollectionModal.tsx` — 613 baris, modal manual → `Dialog` shadcn
- [x] `functions/page.tsx` — 437 → 298 baris, `FunctionEditor` terpisah
- [x] `login/page.tsx` — hex `#3ECF8E`/`#A7F3D0` → token `bg-brand`/`bg-emerald-200`
- [x] `projects/page.tsx` — `page`/`error-text`/hex → token
- [x] `projects/[id]/page.tsx` — `page`/`error-text` → token
- [x] `projects/[id]/auth/page.tsx` — `card`/`btn` → `Card`/`Button`
- [x] `projects/[id]/database/page.tsx` — `card`/`btn`/`badge` → `Card`/`Button`/`Badge`
- [x] `projects/[id]/storage/page.tsx` — `page` → Tailwind (sudah pakai shadcn)
- [x] `projects/[id]/[service]/page.tsx` — `card`/`muted` → `Card`
- [x] `Navbar.tsx` — `topbar`/`brand`/`nav-chip`/`#3ECF8E` → Tailwind + `bg-brand`
- [x] `ProjectSidebar.tsx` — sudah bersih (pakai `cn` + token)
- [x] `AggregatePanel.tsx` — `card`/`input`/`select`/`#5B86E5` → `Card`/`Input`/`Select`/`bg-brand-blue`
- [x] `IndexesEditor.tsx` — `input`/`select`/`btn`/`badge` → `Input`/`Select`/`Button`/`Badge`
- [x] `FieldOptionsEditor.tsx` — 24 `input` tangan → helper `OptInput`/`OptSelect`/`OptCheckbox` shadcn (14 tipe field)

## Checklist Fase 3 (verifikasi + hapus class tangan)

- [x] Verifikasi menyeluruh 44 file `.tsx` — **0 class tangan tersisa**
- [x] Hapus 365 baris class tangan DEPRECATED dari `globals.css` (441 → 71 baris, -84%)
- [x] Verifikasi visual 6 halaman setelah penghapusan — semua berfungsi (tabel 15 baris, sidebar, navbar, tabs)
- [x] `npx tsc --noEmit` → 0 error

## Aha Moments (tambahan Fase 2-3)

5. **Radix Tabs controlled mode tidak merespons klik.** `Tabs` dengan `value` + `onValueChange` tidak mengubah state — tab tetap `data-state="inactive"`. Solusinya: ganti dengan state langsung yang styled seperti Tabs (bukan Radix), karena navigasi tab adalah state UI sederhana, bukan komponen kompleks yang butuh Radix.

6. **Pemisahan komponen raksasa menurunkan kompleksitas drastis.** `[collection]/page.tsx` dari 1464 baris menjadi 620 baris (-58%) dengan 10 komponen studio terpisah. Setiap komponen sekarang bisa diuji dan dirombak independen.

7. **Helper kecil menghilangkan duplikasi besar.** `FieldOptionsEditor` punya 24 `input` tangan untuk 14 tipe field. Tiga helper (`OptInput`, `OptSelect`, `OptCheckbox`) menghapus duplikasi itu sekaligus memaksa konsistensi.

## Status

**SELESAI (Fase 1 + 2 + 3)** — Redesign sistem desain lengkap:
- 10 komponen shadcn baru di `components/ui/`
- 22+ file dirombak ke shadcn
- 365 baris class tangan dihapus dari `globals.css`
- `tsc` 0 error, semua halaman terverifikasi berfungsi
- Dashboard sekarang konsisten menggunakan token semantik + komponen shadcn, bukan class CSS tulisan tangan

