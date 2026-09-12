# M08 — Password Hashing: Melindungi Kredensial

> **Konsep:** kenapa password tidak boleh disimpan apa adanya, hashing vs enkripsi, salt, scrypt, dan timing attack.

## 🎯 Masalah yang Dipecahkan

Sampai M00, password admin disimpan **plaintext di env var** — kita sengaja begitu untuk belajar. Sekarang saatnya membangun auth yang BENAR.

**Pertanyaan mendasar: kenapa tidak simpan password lalu bandingkan?**

```
Jika database bocor (SQL injection, server dibobol, backup hilang):
  ✗ Plaintext  → SEMUA password user langsung terbaca 💀
  ✗ MD5/SHA256 → bisa di-crack dengan rainbow table (miliaran hash siap pakai)
  ✗ Enkripsi   → kunci enkripsi juga di server → ikut bocor
  
  ✓ Hash lambat + salt (bcrypt/scrypt/argon2) → satu password butuh
    BERHARI-BERHARI untuk di-crack, dan tiap password hash-nya beda
```

## 🧠 Konsep Kunci

### 1. Hash vs Enkripsi
```
Enkripsi : dua arah (bisa didekripsi dengan kunci)  → untuk DATA
Hash     : satu arah (tidak bisa dibalik)           → untuk PASSWORD

"hello" → scrypt → "a1b2c3..." (tidak bisa kembali ke "hello")
Verifikasi: hash input user → bandingkan dengan hash tersimpan
```

### 2. Kenapa salt? (agar dua password sama → hash beda)
```
Tanpa salt: "password123" → SELALU hash sama
  → attacker bisa pakai rainbow table untuk jutaian password sekaligus!

Dengan salt (random per user):
  "password123" + saltA → hashA
  "password123" + saltB → hashB   ← berbeda!
  Rainbow table jadi TIDAK berguna.
```

### 3. Kenapa hash harus LAMBAH?
```
Attacker bisa mencoba miliaran password per detik dengan hash cepat (MD5).
Hash auth sengaja LAMBAH (~100ms per verifikasi):
  → user tidak merasakan (login 1x)
  → attacker menderita (mencoba 1 miliar = berhari-hari per user!)

scrypt juga butuh MEMORI besar → GPU farm tidak efektif.
```

### 4. Kenapa node:crypto scrypt (bukan argon2/bcrypt)?
```
Rencana awal: pakai library argon2 (pemenang password hashing competition)
MASALAH      : native module → gagal compile di Windows (seperti better-sqlite3!)
SOLUSI       : node:crypto punya scrypt BAWAAN — juga Password Hashing
               Competition finalist, battle-tested, zero dependency.

scrypt parameter (standar OWASP):
  N=16384 (2^14), r=8, p=1, keylen=64 → ~50-100ms per hash
```

### 5. Format hash tersimpan (standar industri)
```
scrypt:N:r:p:<salt-hex>:<hash-hex>

Semua parameter tersimpan DI DALAM hash → upgrade parameter di masa depan
tidak merusak password lama (verifikasi membaca parameter dari hash itu sendiri)
```

### 6. Timing attack — sudah kita lihat di M00!
`===` berhenti di karakter pertama beda → bocorkan progres menebak.
`crypto.timingSafeEqual` membandingkan dengan waktu konstan. (Sekarang
kita pakai untuk password, bukan hanya token!)

## 📐 Yang Dibangun

```
server/src/auth/password.ts:
  - hashPassword(password) → "scrypt:N:r:p:salt:hash"
  - verifyPassword(password, storedHash) → true/false
  - konstanta parameter + validasi kekuatan password

server/src/auth/users.ts (per project DB!):
  - createAuthUser(db, {email, password, name})
  - findAuthUserByEmail(db, email)
  - Email unique (pakai D1!)
  - Password disimpan sebagai HASH

server/tests/m08-password.test.ts:
  - hash selalu beda untuk password sama (salt)
  - verifikasi benar/salah
  - timing ~50-150ms (bukan instan!)
  - format hash valid
```

## ✅ Definisi Selesai

- [ ] hashPassword menghasilkan format scrypt lengkap
- [ ] Password sama + salt beda → hash beda
- [ ] verifyPassword benar → true, salah → false
- [ ] Verifikasi memakai timingSafeEqual
- [ ] Waktu hash 30-500ms (lambat, bukan instan)
- [ ] Kekuatan password divalidasi (min 8 karakter)
- [ ] Test lulus + jurnal

## 📝 Aha! Moments

### Hasil benchmark (angka nyata)

```
Waktu hash: 41ms    → user login 1x tidak merasakan
Waktu verify: 79ms
Attacker brute force 1 miliar password: ~1.3 TAHUN per user!
```

### Aha! #1 — Hash lambat itu FITUR, bukan kelemahan
Intuisi awal: "program sebaiknya secepat mungkin". Password hashing
MEMBALIKKAN logika itu — scrypt sengaja butuh 40-100ms + memori besar.
Kenapa? Karena user login 1x sehari (tidak merasakan 100ms), tapi
attacker harus mencoba JUTAAN kombinasi — 100ms per percobaan berarti
brute force butuh TAHUN. Kecepatan yang "buruk" untuk satu pihak adalah
tembok untuk pihak lain.

### Aha! #2 — D1 (unique constraint) menjadi fondasi auth
Saat M01 dikerjakan, unique constraint terlihat seperti "fitur kecil".
Sekarang terlihat: email unik di level database mencegah dua akun dengan
email sama — race condition yang tidak bisa dicegah oleh validasi kode.
Fondasi yang dibangun duluan ternyata menopang fitur yang jauh lebih besar.

### Aha! #3 — Pesan error seragam mencegah user enumeration
"Email tidak terdaftar" vs "password salah" — pesan berbeda = gratis
info untuk attacker (mereka tahu email mana yang terdaftar, lalu fokus
crack passwordnya). verifyAuthCredentials mengembalikan null untuk KEDUA
kasus. Serangan jadi buta.

### Aha! #4 — Keamanan juga soal APA YANG TIDAK dikirim
listAuthUsers test membuktikan: JSON.stringify dari seluruh hasil TIDAK
mengandung "scrypt:". Password hash tidak pernah keluar dari lapisan
data. Prinsip: data sensitif tidak boleh ikut dalam response "kalau
kebetulan ada di object" — harus di-filter eksplisit.

### Aha! #5 — scrypt bawaan Node > library native
Argon2 (pemenang kompetisi) ternyata native module → gagal compile di
Windows (pelajaran M01 berulang!). scrypt bawaan node:crypto: finalis
kompetisi yang sama, battle-tested, zero dependency. "Cukup baik" yang
bekerja > "terbaik" yang tidak bisa diinstall.

## ✅ Status: SELESAI (15/15 test M08, 140/140 total) — 2026-09-12
