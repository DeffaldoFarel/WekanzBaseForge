# M10 — OAuth2 Login (Google & GitHub)

## Apa yang kupikirkan sebelumnya

OAuth2 kusebut "tunda terus" karena terbayang rumit: redirect antar domain,
token exchange, CSRF, account linking. Bayanganku: butuh library besar
(passport, oauth2-server) dan konfigurasi panjang. Kupikir email+password
sudah cukup dulu.

## Apa yang ternyata benar

Authorization Code Flow untuk *confidential client* (server-side) ternyata
cuma **4 langkah** yang semuanya sudah punya pondasinya di BaseForge:

1. `/authorize` → generate `state`, 302 ke consent screen provider
2. `/callback?code&state` → POST ke token endpoint provider (native `fetch`,
   **zero dependency baru** — Node 22.5)
3. Fetch profil dengan access_token provider
4. Find-or-create user → `issueTokens()` M09 selesai — JWT, refresh token,
   rate limit, semuanya reuse.

Yang benar-benar baru cuma: tabel `_auth_identities` (mapping provider →
user), migrasi `_auth_users.password_hash` jadi nullable (user OAuth tidak
punya password), dan enkripsi client secret.

## Aha! moment

**1. Anti account-takeover via email unverified.**
Ini pelajaran keamanan terbesar M10. GitHub bisa memberi email yang TIDAK
diverifikasi ke akun siapa pun. Kalau auto-link berdasarkan email saja:
attacker mendaftarkan email korban di GitHub → login via OAuth → **langsung
mendapat akun korban**. Solusinya: hanya link kalau provider mengonfirmasi
`email_verified` (Google selalu; GitHub harus cek flag `verified` di
`/user/emails`). Test khusus `409 EMAIL_UNVERIFIED_CONFLICT` menutup celah ini.

**2. State = "password sekali pakai", bukan sekadar CSRF token.**
State kubuat random 64-hex, disimpan di DB dengan TTL 10 menit, dan
**dihapus saat dibaca — valid maupun tidak**. Konsekuensinya: replay attempt
(state dipakai kedua kali) otomatis gagal, tanpa perlu log replay. "Selalu
DELETE entah valid atau tidak" adalah pola yang kupelajari dari magic-link
login: tindakan konsumsi harus idempotent-unsafe.

**3. Token lewat URL fragment, bukan query string.**
`#access_token=...` tidak pernah dikirim ke server mana pun (browser saja
yang membacanya) — tidak bocor di access log proxy/server, tidak masuk
Referer header. Pola yang sama dipakai PocketBase & implicit flow OAuth2.
Kelemahannya: jejak di history browser — SDK merespons dengan
`history.replaceState` membersihkan fragment setelah parsing.

**4. ESM live binding membuat test tanpa internet jadi trivial.**
`OAUTH_PROVIDER_DEFS` kubuat objek mutable — test mengarahkan `authorizeUrl`/
`tokenUrl`/`profileUrl` ke mock server HTTP lokal yang menyamar sebagai
Google & GitHub. Alur penuh (302 → token → userinfo → user dibuat) teruji
tanpa satu pun request internet. Mutation objek export = 0 mocking library.

**5. SQLite migrasi sistem tetap satu transaksi.**
Tabel `_auth_users` (tabel sistem, bukan collection) butuh kolom berubah
dari NOT NULL → nullable. SQLite tak punya `ALTER COLUMN` → rebuild ala D4:
`BEGIN` → CREATE tabel baru → INSERT SELECT → DROP → RENAME → `COMMIT`.
Polanya identik dengan Table Rebuild untuk collection user — fondasi lama
membayar dividen lagi.

## Keputusan desain yang kupertahankan

- **redirect_to + allow-list origins**: admin bisa membatasi origin tujuan
  token (anti token phishing ke domain asing). Kosong = semua URL http(s)
  valid diizinkan (ergonomis untuk dev).
- **PUT tanpa secret = keep existing secret**: dashboard bisa update clientId
  tanpa mengetik ulang secret. Secret tersimpan encrypted AES-256-GCM
  (key dari `OAUTH_SECRET` env, fallback JWT_SECRET).
- **User OAuth-only tidak bisa login password** (`password_hash NULL` →
  selalu gagal di `verifyAuthCredentials`) — bukan error crash, cuma null.

## Pertanyaan yang masih tersisa

- PKCE (`code_verifier`/`code_challenge`)? Untuk confidential client dengan
  state yang kuat, risikonya rendah — tapi bagus ditambahkan kalau nanti
  ada flow SPA murni (public client) tanpa server perantara.
- Identity unlink dari sisi end-user (self-service "disconnect Google")?
  API-nya sudah ada (`unlinkIdentity`), belum ada endpoint publiknya.
- Provider lain (Facebook, Apple)? Tinggal tambah entry di
  `OAUTH_PROVIDER_DEFS` — pola adapter-nya sudah terbukti dengan 2 provider.
