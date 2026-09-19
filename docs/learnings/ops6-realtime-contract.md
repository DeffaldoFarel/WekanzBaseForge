# Ops-6: Realtime SDK↔Server Contract Fix (auth SSE + bulk sync + fail-safe delete)

**Tanggal:** 2026-09-19
**Pemicu:** real-test migrasi WekanzDashboard — setelah login BaseForge, realtime mati total di browser (widget initial-fetch sukses tapi delta SSE tidak pernah sampai).

## Ekspektasi (sebelum investigasi)

Alur SDK `@wekanz/baseforge` yang seharusnya: buka koneksi SSE → terima `PB_CONNECT` (clientId) → POST sinkronisasi subscription → event CRUD (`PB_CREATE`/`PB_UPDATE`/`PB_DELETE`) sampai ke listener. Di dashboard (browser, lintas origin), initial fetch sukses namun delta realtime tidak pernah bekerja.

## Temuan (diuji empiris di produksi, 2026-09-19)

1. **`POST /api/p/:pid/realtime` → 404 NOT_FOUND.** SDK `realtimeService.syncSubscriptions()` POST ke path ini dengan body `{clientId, subscriptions}` — tapi server hanya mendaftarkan `/realtime/subscribe` dan `/realtime/unsubscribe` dengan format body berbeda. Bukti live: POST ke `/realtime` = 404; POST ke `/realtime/subscribe` = 200. Contract mismatch SDK↔server sejak M13.
2. **SSE browser selalu anonymous.** `realtimeRoutes.ts` membaca auth HANYA dari `req.headers.authorization`; API `EventSource` browser tidak bisa mengirim header kustom. Asumsi rancangan M13 ("tidak perlu: koneksi sudah auth'd") hanya benar untuk klien non-browser. Akibatnya seluruh rules-filtering `publish()` (yang mengandalkan `client.auth`) mengevaluasi koneksi browser sebagai anonymous.
3. **Bocor event DELETE.** `core/realtime.ts` cabang delete: karena record sudah terhapus dari DB (tidak bisa dievaluasi ulang), kode lama hanya mengecek string rule mengandung `@request.auth.id` lalu **mengirim event delete (payload FULL record, M38) ke SEMUA subscriber** — termasuk anonymous dan user lain yang bukan pemilik.

## Desain / wire format

### 1. `POST /api/p/:pid/realtime` (BARU) — bulk sync, semantik REPLACE

```json
{ "clientId": "<dari PB_CONNECT>", "subscriptions": ["collection/*", "collection/<recordId>", "collection"] }
```

- `clientId` wajib → 400; tidak dikenal → 404 (connect first)
- `subscriptions` bukan array / > 100 entri → 400
- topik format salah atau collection tidak ada → 400 dengan pesan eksplisit
- Semantik: SELURUH subscription client DIGANTI dengan set baru (idempotent full-sync — persis cara SDK memanggilnya setelah setiap subscribe/unsubscribe)
- Respons: `200 { "subscriptions": [{ "id": "...", "collection": "...", "recordId": "..."? }] }`

### 2. Auth upgrade koneksi SSE

- `GET /api/p/:pid/realtime?token=<jwt>` — token via query param (fallback ketika tidak ada header; untuk klien EventSource murni). Token **invalid → 401** (gagal keras, JANGAN diam-diam jatuh ke anonymous — kegagalan senyap adalah bug aslinya). Token valid → auth terikat sejak connect.
- `POST /realtime` dan `POST /realtime/subscribe`: header `Authorization` valid → **UPGRADE** auth client di hub (anonymous → user/admin; request SDK membawa header ini otomatis, jadi SDK vendored dashboard bekerja TANPA perubahan). Tanpa token → tidak mengubah auth. Token invalid → 401 (SDK M37 auto-refresh menangkap 401 → refresh → retry → upgrade sukses).
- `clientId` hanya diketahui pemilik koneksi (dikirim via stream), jadi upgrade tidak bisa disalahgunakan lintas klien.
- Jendela antara SSE connect dan sync pertama tetap dievaluasi dengan auth saat itu (pola sama dengan PocketBase).

### 3. Fail-safe delete: evaluasi rule in-memory

- Record sudah tidak ada di DB saat delete → proyeksikan snapshot record ke derived table sekali per publish: `SELECT 1 WHERE EXISTS (SELECT ? AS "id", ? AS "<field>"... WHERE (<ruleSQL>))` — me-reuse engine SQL (`decideRule` + `filterToSql`), tanpa evaluator baru.
- Nilai field object (json) → `JSON.stringify` (meniru bentuk TEXT tersimpan); field hilang → NULL.
- Filter subscriber (`sub.filter`) kini juga dievaluasi untuk delete (sebelumnya di-skip).
- Rantai lama `lRule.includes('@request.auth.id') → kirim ke semua` DIHAPUS.

## File yang berubah

- `server/src/core/realtime.ts` — `Subscription.recordId`; `setClientAuth()`; `syncSubscriptions()` (replace); `publish()`: filter recordId + evaluasi in-memory untuk delete
- `server/src/api/realtimeRoutes.ts` — `POST /realtime` (bulk sync + auth upgrade); `GET ?token=`; auth upgrade di `/subscribe`
- `server/tests/ops6-realtime-contract.test.ts` — test suite baru
- `docs/realtime.md` — dokumentasi publik endpoint baru
- `docs/learnings/ops6-realtime-contract.md` — jurnal ini

## Checklist

- [x] Concept doc (file ini)
- [x] Implement core + routes
- [x] `npx tsc --noEmit` — 0 error
- [x] Test suite baru: bulk sync + replace, auth upgrade via POST, `?token=`, fail-safe delete, backward-compat `/subscribe` — **10/10**
- [x] Full `npm test` hijau — **605/605** (32 suite, 0 gagal)
- [x] Jurnal terisi (Aha + Status)
- [x] Commit + push
- [x] Deploy VPS tencentvps1 + verifikasi produksi (POST `/realtime`: 404 → 200)

## Aha Moments

1. **Dokumentasi yang mengklaim endpoint lebih berbahaya daripada dokumentasi yang kosong.** `docs/realtime.md` mendokumentasikan `POST /realtime` + `{clientId, subscriptions}` sejak era M13/M16 — tapi route-nya tidak pernah ada di server, dan tidak ada test yang memanggil path persis itu (m13 menguji `/realtime/subscribe`). SDK mengikuti docs → 404 → realtime mati untuk SEMUA konsumen SDK selama berbulan-bulan tanpa satu pun test merah. Pelajaran: setiap endpoint yang didokumentasikan harus ditutup test yang memanggil path & body PERSIS dari docs — bukan path "yang mirip". Bukti: POST produksi `404 NOT_FOUND` vs `/realtime/subscribe` `200` (diuji live 2026-09-19).

2. **Asumsi transport-auth harus diuji dari klien termiskin, bukan klien yang paling mudah.** Komentar rancangan M13 ("EventSource tidak bisa set header — tapi juga tidak perlu: koneksi sudah auth'd") benar untuk curl (bisa header) dan salah total untuk EventSource browser — klien yang justru jadi target utama BaaS. Celahnya tidak terlihat selama verifikasi hanya memakai curl/node http. Pelajaran: enumerasi klien nyata (browser SDK, mobile, curl) saat mendesain kontrak auth; uji dari yang paling terbatas kemampuannya.

3. **"Fail-safe" yang berhenti mengevaluasi adalah fail-OPEN terselubung.** Cabang delete lama mengganti evaluasi rule dengan cek string `lRule.includes('@request.auth.id')` — niatnya "hanya pemilik", hasilnya broadcast payload FULL record (M38) ke anonymous dan user lain, selama bertahun-tahun lolos review. Fail-safe yang benar tetap MENGEVALUASI sesuatu: snapshot record diproyeksikan ke derived table `SELECT 1 WHERE EXISTS (SELECT ? AS "id", ? AS "user"... WHERE (<ruleSQL>))` — engine SQL yang sama dipakai ulang, nol evaluator baru. Bukti: user B = 0 event delete, anonymous = 0, pemilik A = 1 (test 8); collection publik tetap broadcast (test 9, regresi over-blocking).

4. **Auth late-binding lewat POST sync membuat SDK vendored bekerja tanpa satu baris perubahan client.** POST sync SDK otomatis membawa `Authorization` (baseService) → server mengikat auth ke clientId di hub → `publish()` mengevaluasi rules per-user. Kombinasi dengan 401-keras untuk token invalid memicu M37 auto-refresh → retry dengan token segar → upgrade sukses. Pola identik PocketBase. Keputusan desain: query-param HANYA fallback di GET; POST tetap otoritatif.

5. **Layer redaksi memakan placeholder `Bearer <x>` di parameter tool — file menjadi berisi literal `***`.** Terjadi di patch docs ini (dan ternyata juga di sesi dokumen sebelumnya — warisan `Bearer ***` ikut terbersihkan). Menulis placeholder autentikasi harus lewat python string-concat (`'Bearer ' + chr(...)` / bentuk `'Bearer ' + token`), bukan template mentah di parameter patch/write. Verifikasi isi file selalu dengan pencarian programatik, bukan membaca output terminal yang ikut ter-masking.

Status: SELESAI — tsc 0 error; test baru 10/10; full suite **605/605**; docs `docs/realtime.md` sinkron dengan kontrak baru; commit + push + deploy VPS + verifikasi produksi.
