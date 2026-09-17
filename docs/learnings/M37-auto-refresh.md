# M37 — 401 Auto-Refresh: session yang gak bunuh SPA diam-diam

## Apa yang kupikirkan sebelumnya
Access token 15 menit itu standar industri. Klien tinggal refresh sebelum
expiry. 401 cuma kasus tepi.

## Apa yang ternyata benar
SPA yang hidup berjam-jam (WekanzDashboard dibuka seharian) PASTI kena:
tab idle 20 menit → token expired → request CRUD berikutnya 401 → SDK lama
langsung throw → user "logout sendiri" tanpa sengaja, modal form gak ke-save.

Intercept 401 → refresh → retry bukan fitur mewah — itu syarat SPA nyata
bisa pakai session 15-menit sama sekali.

## Aha! moment

**1. Singleton refresh lock — 3+ request 401 bersamaan.** Tab dengan
4 parallel fetch yang semuanya 401 bersamaan = 4 POST refresh. Race pertama:
refresh kedua invalidates token hasil refresh pertama → semua gagal →
logout massal. Solusi: `static refreshPromise` — request pertama yang
refresh, sisanya `await` promise yang sama. Test "3 simultaneous 401s →
all succeed after 1 refresh" membuktikan (88ms, 1 POST).

**2. Refresh endpoint WAJIB di-exclude.** Request refresh yang sendiri
401 (refreshToken expired) gak boleh memicu refresh lagi — infinite loop
menunggu terjadi. Guard: kalau URL request == refresh endpoint, skip
auto-refresh, langsung SESSION_EXPIRED.

**3. Refresh gagal = clear authStore SEKALI, pasti.** Semua request yang
menunggu lock harus lihat kegagalan yang sama — bukan setiap request
mencoba refresh sendiri dan gagal sendiri. Lock yang share failure state.

**4. Retry body harus replayable.** `fetch` dengan FormData/binary body
gak bisa di-retry begitu saja — request interceptor yang rebuild body.
(Kasus ini: JSON string sudah di-serialize sebelum retry — aman.)

## Keputusan yang dipertahankan

- Interceptor di baseService (satu tempat, semua service kena)
- Singleton lock statis + failure share
- Refresh endpoint excluded dari auto-refresh
- `SESSION_EXPIRED` sebagai kode error terpisah — adapter/adapter bisa
  redirect login dengan pesan jelas, bukan generic 401

## Pertanyaan yang masih tersisa

- Proactive refresh (refresh di background sebelum expiry, tanpa nunggu
  401 pertama) — lebih halus, tapi butuh timer
- Token rotation + reuse detection (keamanan: refreshToken sekali pakai)
- Multi-tab sync (storage event antar tab biar logout satu = logout semua)
