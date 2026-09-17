# M23 — Email Service, Verifikasi Email & Reset Password

## Apa yang kupikirkan sebelumnya

Email itu "fitur membosankan": cuma kirim HTML, tinggal pasang library.
Yang kukhawatirkan cuma setup SMTP yang rewel. Kupikir verifikasi email dan
reset password adalah dua fitur berbeda yang masing-masing butuh alur sendiri.

## Apa yang ternyata benar

**1. Keduanya adalah SATU primitif yang sama: action token.**
Verifikasi email dan reset password sama-sama "link bermagic-token sekali
pakai yang dikirim ke email". Modulnya satu: `emailTokens.ts` — token 64-hex,
disimpan hash SHA-256, TTL per purpose (`verify` 24 jam, `reset` 1 jam),
konsumsi = DELETE. Persis pola state OAuth M10. Bedanya cuma efek samping
saat token dikonsumsi (set `verified=1` vs ganti password + revoke sesi).

**2. Nodemailer + DEV OUTBOX = fitur email yang bisa dites tanpa email.**
SMTP sungguhan tak bisa hidup di CI/tes. Solusinya: `sendMail()` jadi
single-gate dengan dua moda — SMTP (nodemailer) saat config aktif, dan
**outbox** (tabel `_outbox` di platform.db + console.log) saat tidak.
Test suite membaca link dari outbox lewat Admin API. Alur penuh
(register → email → klik link → verified) teruji 100% tanpa SMTP.
Bonus DX: dashboard Settings menampilkan outbox — dev tanpa SMTP tetap
bisa "klik" link verifikasi manual.

**3. Anti-enumeration menyusun bentuk respons.**
"Email tidak terdaftar" dan "email terdaftar" HARUS merespons identik
(200 + pesan sama), dan kegagalan SMTP pun dibungkam (console.error saja).
Kalau SMTP error di-lempar ke 500, penyerang bisa membedakan email yang
ada (500 karena kirim) vs tidak ada (200 cepat) — enumeration melalui
side-channel error. Konsekuensi ops: email gagal kirim tidak kelihatan
di respons — harus dipantau dari log/outbox.

## Aha! moment

**1. Reset password = kejadian keamanan, bukan cuma ganti string.**
Momen "aha"-nya: begitu password diganti, SEMUA refresh token user wajib
di-revoke (`revokeAllUserTokens` — sudah ada sejak M09, "logout semua
device"). Kalau tidak: pencuri yang punya akses akun bisa membiarkan
sesi curian tetap hidup bahkan setelah korban "mereset" password.
PocketBase dan Supabase melakukan hal yang sama — sekarang aku paham
KENAPA: reset adalah assertion "sesi lama tidak dipercaya lagi".

**2. Peek vs Consume — validasi dua fase untuk form reset.**
Link reset di email menunjuk ke GET endpoint, tapi password baru dikirim
via POST. Kalau GET langsung mengonsumsi token, user yang buka link lalu
refresh halaman kehabisan token. Solusi: GET melakukan **peek** (validasi
tanpa hapus — cukup SELECT hash + cek TTL), konsumsi baru terjadi di POST
bersamaan dengan password baru. Pattern berbeda dari OAuth callback —
di sana GET langsung konsumsi karena efeknya selesai di GET.

**3. HTML form self-contained = SPA-less recovery flow.**
Tanpa aplikasi frontend pun, user harus bisa reset password. GET tanpa
`redirect_to` menyajikan form HTML mini (dark, on-brand) dengan fetch
POST JSON — form-nya POST balik ke endpoint yang sama. Aplikasi yang
punya halaman sendiri tinggal pakai `redirect_to` → `302 #reset_token=...`
(lagi-lagi pola fragment M10).

**4. Config email = platform-level, bukan per-project.**
SMTP credentials milik operator server, bukan tiap project. Disimpan di
platform.db (`_platform_settings`), di-encrypt at-rest (AES-256-GCM —
reuse pattern M10), resolvable dari env juga. Password field kosong saat
update = keep-existing (form dashboard tidak memaksa re-type secret).

## Pertanyaan yang masih tersisa

- Email template per-project (custom branding)? Sekarang nama project
  disisipkan ke template global.
- Queue & retry: pengiriman email sekarang langsung await (atau
  fire-and-forget untuk register). Beban tinggi → job queue + backoff.
- `verified` sebagai syarat login? Sekarang opsional (rules bisa cek
  `verified = true` di filter). PocketBase juga begini — sadar desain.
