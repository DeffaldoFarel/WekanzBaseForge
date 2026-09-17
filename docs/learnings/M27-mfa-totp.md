# M27 — MFA/TOTP (RFC 6238)

## Apa yang kupikirkan sebelumnya

MFA = library territory. otplib, speakeasy — tosh. Kubayangkan HMAC, base32,
QR code, dan puluhan edge case yang mustahil ditulis benar sendiri.

## Apa yang ternyata benar

TOTP (RFC 6238) adalah **30 baris**: HMAC-SHA1(counter 8-byte BE) → dynamic
truncation → mod 10^6. Base32 (RFC 4648) 15 baris. Yang membuat library
"perlu" adalah QR rendering dan URI format — dan keduanya bisa
didelegasikan ke client (`otpauth://` URI cukup). Total core: ~80 baris
node:crypto, tervalidasi **vektor resmi Appendix B RFC** — bukan self-test
circular yang hanya membuktikan konsistensi dengan dirinya sendiri.

## Aha! moment

**1. Login jadi "setengah berhasil".**
Desain paling halus di MFA: password benar ≠ token terbit. Respons 200
berisi `{ mfaRequired, mfaToken }` — faktor-1 diakui (untuk UX), tapi
sesi tidak diberikan sampai faktor-2. mfaToken pendek umur (5 menit)
adalah "tiket sementara antar dua pintu".

**2. Peek vs consume — pembalikan keputusan M23.**
M23 (reset link): token dikonsumsi SAAT DICEK — karena klik link adalah
peristiwa final. M27 (challenge): token harus **bertahan dari kode salah** —
user salah ketik 2x tidak boleh dipaksa login ulang. Maka: peek saat
memvalidasi, consume saat kode BENAR. Prinsip yang sama (satu-kali-pakai),
titik konsumsi berbeda per UX flow. "Konsumsi" adalah keputusan desain,
bukan properti token.

**3. Rate limit challenge = pertahanan utama, bukan pelengkap.**
Kode 6-digit = 1 juta kombinasi. Tanpa limit, brute force online trivial.
5 percobaan/15 menit per mfaToken membuat ruang serangan ~5 dari 10^6.
Kunci: limit di-PER-TOKEN (bukan per-user/IP) — token adalah identitas
sesi login yang sedang berlangsung.

**4. Test suite menabrak rate limiter-nya sendiri.**
Test ke-7 gagal misterius (400, bukan 429/401). Penyebab: rate limiter
in-memory per-IP — test suite berbagi SATU IP (127.0.0.1), jadi test
enroll ke-6 kena limit enroll ke-1. Fix: rotasi `X-Forwarded-Per` unik
per kelompok panggilan. Pelajaran infra: **limiter per-IP + test dari
satu IP = test saling membunuh**; rotasi IP adalah konvensi wajib.
Bonus bug: helper 5-argumen menerima argumen ke-6 yang diam-diam dibuang
(javascript tidak error!) — patch rotasi "berhasil" tanpa efek.

**5. Re-enroll menurunkan enabled.**
`startEnrollment` dengan `ON CONFLICT ... enabled = 0`: user yang enroll
ulang otomatis kehilangan status aktif sampai konfirmasi kode baru.
Kebalikan dari yang diharapkan (enroll ulang = masih aman?) — tapi benar:
secret BARU belum terbukti dikalibrasi; mempertahankan enabled dengan
secret yang belum diverifikasi = gerbang dengan kunci tak dikenal.

## Keputusan yang dipertahankan

- **Recovery codes hash at-rest** (sha256) + sekali pakai — pola token M09.
- **Disable butuh bukti** (kode TOTP/recovery) — kecuali admin reset (tercatat,
  kebijakan "user terkunci" klasik).
- **Secret TOTP terenkripsi AES-256-GCM** di DB (pola M10/M23) — DB bocor
  ≠ MFA bisa dipalsukan.

## Pertanyaan yang masih tersisa

- OAuth login saat MFA aktif: v1 melewati gerbang (trust the IdP) —
  benar untuk Google (punya MFA sendiri), diperdebatkan untuk IdP lemah.
  Opsi: flag per-user "mfaOnOAuth".
- Email-OTP (kode via email M23 sebagai faktor-2) — variasi murah, nanti.
- Remember-device (skip MFA 30 hari) — cookie + trust table.
