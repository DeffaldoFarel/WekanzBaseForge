# M09u — Auth API: HTTP Endpoints untuk End Users

> **Konsep:** mengubah mesin auth (M08-M09) menjadi HTTP API yang bisa dipakai aplikasi, dengan rate limiting anti-brute-force.

## 🎯 Tujuan Milestone

Membangun jembatan HTTP antara mesin auth (M08-M09) dan aplikasi user:
- Register, login, refresh, logout, /me
- Rate limiting login (anti brute force)
- Pesan error seragam (anti user enumeration)

Ini melengkapi pola yang sama dengan M05u: mesin dulu (M08-M09), HTTP kemudian.

## 🧠 Konsep Kunci: Dua Jenis API

```
/api/admin/*     → untuk ADMIN BaseForge (dashboard) — API key
/api/p/:pid/*    → untuk END USERS aplikasi (Wekanz nanti) — JWT auth

Dunia yang terpisah:
  Admin mengelola PLATFORM (projects, collections, skema)
  End user mengakses DATA project tempat dia terdaftar
```

Ini keputusan arsitektur dari M00 yang sekarang mulai terbayang penuh.

## 🔐 Keputusan Desain (disetujui user)

1. **Rate limiting login**: ya, sederhana (in-memory counter per IP, 10/menit)
2. **Register langsung login**: ya (dapat tokens setelah daftar)
3. **Email verification**: skip dulu (butuh SMTP), verified = true langsung

## 📐 API

Semua endpoint: `/api/p/:pid/auth/...` (pid = project id)

```
POST /auth/register   { email, password, name? }
  → 201 { user, accessToken, refreshToken, expiresIn }
  → 400 password lemah / email invalid
  → 409 email sudah terdaftar

POST /auth/login      { email, password }
  → 200 { user, accessToken, refreshToken, expiresIn }
  → 401 "Email atau password salah" (SERAGAM)
  → 429 terlalu banyak percobaan (rate limit)

POST /auth/refresh    { refreshToken }
  → 200 { accessToken, refreshToken, expiresIn }  (rotasi: refresh baru)
  → 401 refresh invalid/expired/revoked

GET  /auth/me         (Authorization: Bearer <access>)
  → 200 { user }
  → 401 token invalid/expired

POST /auth/logout     { refreshToken }
  → 200 (revoke refresh)
```

## 🛡️ Rate Limiting (sederhana, in-memory)

```
Map<ip, { count, resetAt }>
- login/register: maks 10 percobaan per menit per IP
- lewat: 429 Too Many Requests + Retry-After
- Catatan produksi: untuk multi-instance server, butuh Redis/DB.
  Untuk Skenario A (single VPS), in-memory cukup.
```

## 📁 Perubahan

```
server/src/auth/rateLimiter.ts   ← rate limiter sederhana
server/src/api/authRoutes.ts     ← endpoint auth per project
server/tests/m09u-auth-api.test.ts ← test integrasi HTTP lengkap
```

## ✅ Definisi Selesai

- [ ] Register → user + tokens (auto-login)
- [ ] Login → user + tokens; error seragam
- [ ] Refresh → access baru (rotasi refresh)
- [ ] /me → identitas dari JWT
- [ ] Logout → refresh revoked
- [ ] Rate limit login 429 setelah 10 percobaan/menit
- [ ] Duplikat email → 409
- [ ] Semua endpoint per-project (data terisolasi)
- [ ] Test lulus + dokumentasi

## 📝 Aha! Moments

### Aha! #1 — Module-level config adalah jebakan klasik
Bug tersulit M09u: adminAuth membaca `process.env` saat MODULE DIMUAT
(const di top-level), sedangkan test mengubah env di `before()` — setelah
module ter-load. Hasil: 401 misterius. Solusinya lazy loading (fungsi
`getAdminCredentials()` yang membaca env saat dipanggil). Ini pola yang
sama dengan "lazy init" Firebase yang kita bahas — config sebaiknya
dibaca SAAT DIBUTUHKAN, bukan saat aplikasi start.

### Aha! #2 — Rate limiter 40 baris menghentikan brute force 190 TAHUN
Dengan batas 10 login/menit per IP: 1 miliar kombinasi password ÷ 10/menit
= ~190 tahun untuk SATU akun. Rate limiter sederhana (Map + window) adalah
defense dengan rasio effort/impact tertinggi di seluruh auth.

### Aha! #3 — Isolasi per-project terbukti lewat API
Test membuktikan: user yang register di project A tidak bisa login di
project B (401). Ini bukan magic — karena tiap project punya file DB
sendiri (M00), tabel `_auth_users` mereka terpisah total. Arsitektur
multi-tenant dari awal membuat isolasi auth jadi gratis.

### Aha! #4 — HTTP integration test dengan server sungguhan
Test M09u menjalankan HTTP server sungguhan di port acak dan memakai
`http.request` sungguhan — bukan mock. Menangkap bug yang tidak terlihat
di unit test (format response, header, status code). Kelemahan ditemukan:
`import http from 'node:http'` bentrok dengan fungsi helper bernama `http`
— diperbaiki dengan alias `nodeHttp`. Lesson: penamaan test helper harus
tidak bentrok dengan module yang di-test.

## ✅ Status: SELESAI (13/13 test M09u, 166/166 total) — 2026-09-12
