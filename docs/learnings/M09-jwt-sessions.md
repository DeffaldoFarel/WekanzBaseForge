# M09 — JWT & Sessions: Token yang Bisa Dipercaya

> **Konsep:** JWT (JSON Web Token), access token vs refresh token, token persistence, dan beda stateful vs stateless session.

## 🎯 Masalah yang Dipecahkan

Sampai sekarang, token login kita disimpan di **Map di memori** (M00):
```typescript
const sessions = new Map(); // ← hilang saat server restart!
```

Konsekuensi nyata: server restart → SEMUA user ditendang ke halaman login.
Untuk produksi, ini tidak bisa diterima.

## 🧠 Dua Pendekatan Session

### Pendekatan 1: Stateful (M00 — yang lama)
```
Login → server buat token acak → simpan di memori Map → kirim ke client
Request → server cari token di Map → valid?

+ Mudah dibatalkan (hapus dari Map)
− Hilang saat restart
− Sulit di-scale (tiap server punya Map sendiri)
```

### Pendekatan 2: Stateless JWT (M09 — yang baru)
```
Login → server buat JWT (berisi data + TANDA TANGAN digital) → kirim
Request → server VERIFIKASI tanda tangan → valid?

+ Tidak perlu simpan apapun (state-nya DI DALAM token)
+ Server restart tidak mempengaruhi (verifikasi = matematika, bukan lookup)
+ Scale: semua server yang punya kunci rahasia bisa memverifikasi
− Sulit dibatalkan sebelum expired (jawabannya: umur pendek + refresh token!)
```

## 🔐 Anatomi JWT

```
eyJhbGciOiJIUzI1NiJ9 . eyJzdWIiOiJ1MSIsImV4cCI6MTczfQ . SflKxwRJSMeKKF2QT4f...

   HEADER (algorithm)  .  PAYLOAD (data)      .  SIGNATURE (tanda tangan)

PAYLOAD berisi:
{
  "sub": "u1",           ← subject (id user)
  "email": "f@x.com",
  "iat": 1694428800,     ← issued at
  "exp": 1694515200      ← expired at (15 menit kemudian!)
}

SIGNATURE = HMAC-SHA256(header + "." + payload, SECRET_KEY)
  → siapa pun bisa MEMBACA payload (bukan enkripsi!)
  → tapi hanya pemilik SECRET_KEY bisa MEMBUAT token sah
  → mengubah payload = signature tidak cocok = ditolak
```

**⚠️ Penting: JWT TIDAK dienkripsi!** Jangan pernah menaruh data rahasia
di payload. JWT menjamin INTEGRITAS (tidak bisa dimodifikasi), bukan
kerahasiaan.

## 💡 Access Token + Refresh Token (pola industri)

```
ACCESS TOKEN  : umur PENDEK (15 menit) — dikirim di setiap request
REFRESH TOKEN : umur PANJANG (30 hari) — hanya untuk minta access token baru

Alur:
1. Login → dapat access (15m) + refresh (30d)
2. 15 menit kemudian: access expired → request ditolak 401
3. Client pakai refresh token → dapat access baru (tanpa login ulang!)
4. Setelah 30 hari tanpa aktivitas → refresh expired → login ulang
```

**Kenapa access pendek?** Kalau token dicuri, pencuri hanya memilikinya
15 menit. Refresh token disimpan lebih aman (server bisa melacaknya).

## 📐 Yang Dibangun

```
server/src/auth/jwt.ts:
  - signToken(payload, ttlSeconds) → JWT string (HMAC-SHA256)
  - verifyToken(jwt) → payload | null
  - SECRET dari env (JWT_SECRET) — HARUS diganti di produksi!

server/src/auth/tokens.ts (per project DB):
  - _auth_tokens table (refresh tokens persisten)
  - issueTokens(db, user) → { accessToken, refreshToken }
  - refreshAccessToken(db, refreshToken) → access baru
  - revokeRefreshToken(db, token) → logout
  - cleanupExpiredTokens(db)

Integrasi M00: token admin tetap in-memory (admin = platform level),
JWT untuk END USERS (per project).
```

## ✅ Definisi Selesai

- [ ] signToken menghasilkan JWT 3 bagian dengan signature valid
- [ ] verifyToken menerima token sah, menolak yang dimodifikasi
- [ ] Token expired → ditolak
- [ ] Refresh token persisten (selamat restart) + hashed di DB
- [ ] refreshAccessToken memberi access baru tanpa login ulang
- [ ] revokeRefreshToken → logout bekerja
- [ ] Token salah format/tamper → ditolak
- [ ] Test lulus + jurnal

## 📝 Aha! Moments

### Aha! #1 — JWT bukan enkripsi, dan itu membingungkan banyak orang
Payload JWT bisa dibaca SIAPA SAJA (cukup decode base64). Yang membuatnya
aman adalah SIGNATURE: mengubah satu huruf payload pun membuat signature
tidak cocok → ditolak. Test tampering membuktikannya: role diubah jadi
admin → DITOLAK. Prinsip: JWT = integritas, bukan kerahasiaan. Data
rahasia tidak pernah masuk payload.

### Aha! #2 — Stateless vs Stateful: trade-off yang nyata
M00 (stateful): token hilang saat restart, tapi mudah di-revoke.
M09 (stateless JWT): selamat restart & scale, tapi token curian tetap
valid sampai expired. Industri menyelesaikannya dengan KOMBINASI:
access JWT pendek (15 menit — risiko curi minim) + refresh token
persisten di DB (bisa di-revoke). Dua dunia terbaik.

### Aha! #3 — JWT dalam detik yang sama bisa identik — itu normal
Test awal gagal karena mengharapkan access baru "beda string" dari yang
lama. Ternyata JWT deterministik: payload sama + waktu sama (detik sama)
= token sama. Yang penting bukan keunikannya, melainkan KEVALIDANNYA.
Sama seperti M01-M04: test yang "gagal" mengajarkan lebih dalam daripada
yang lulus langsung.

### Aha! #4 — Refresh token di-hash di DB (alasan sama dengan password)
Kalau DB bocor dan refresh token tersimpan plaintext, attacker bisa
membuat access token kapan pun. Dengan sha256 hash: bocor = hanya hash,
tidak berguna. Pola "simpan hash, bukan plaintext" berlaku untuk SEMUA
kredensial — password, token, API key.

### Aha! #5 — initAuthUsersTable lupa dipanggil = error runtime jelas
Bug test: lupa init tabel users di test persistence. Error-nya jelas
("no such table") dan cepat ketemu. Pelajaran DX: error database yang
jujur tentang masalahnya lebih berharga daripada error samar.

## ✅ Status: SELESAI (13/13 test M09, 153/153 total) — 2026-09-12
