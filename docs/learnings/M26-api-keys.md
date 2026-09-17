# M26 — Per-Project API Keys

## Apa yang kupikirkan sebelumnya

API keys kubayangkan sebagai fitur "accounting": tabel token, middleware, dan
banyak plumbing. Scaffold-nya sudah menunggu sejak M00 (`apiKey?` di interface
Project — TODO yang tidak pernah dikerjakan).

## Apa yang ternyata benar

Karena arsitektur request-context sudah matang (M11: `reqCtx` undefined =
admin bypass), API key hanyalah **cara keempat menjadi "undefined"**:
JWT admin → undefined; sekarang `Bearer bf_...` → undefined (setelah scope
check). Seluruh mesin rules, records, agregasi, files — nol perubahan.

## Aha! moment

**1. Bearer vs JWT dibedakan dengan prefix — bukan dengan try-decode.**
Key selalu `bf_<40hex>`; JWT selalu `eyJ...`. Diskriminasi O(1) tanpa
mem-panggil jose. `X-API-Key` header sebagai alias (gaya Supabase apikey).

**2. "Scope" dicek di ROUTE, "izin data" tetap di rules-engine.**
Hadirnya dua konsep izin yang bersih: METODE (read/write) = milik key;
BARIS data (rules) = milik koleksi. Key write bypass rules TAPI read key
tidak bisa POST — 403 INSUFFICIENT_SCOPE sebelum rules tersentuh.

**3. Bug rate limiter async yang lolos dari 2 milestone.**
`checkRateLimit` M18d adalah async (Redis). Dipanggil sync: `if (!checkRateLimit(...))`
— Promise selalu truthy → `!truthy` = false → rate limit TIDAK PERNAH aktif!
Test M26 pertama yang menemukannya (301 request tanpa 429). Pelajaran:
helper async yang dipakai di kondisi sync = silent no-op. `await` bukan
dekorasi.

**4. Hint, bukan key: identifikasi tanpa membocorkan.**
UI menampilkan `bf_ab12cd34ef…wxyz` (8 kepala + 4 ekor) — cukup untuk admin
mengenali key di log, mustahil untuk brute force (tengah disembunyikan,
entropi tersisa jauh di atas 100 bit).

**5. Usage tracking = M24 replay.**
Buffer in-memory + flush 30 detik + merge real-time saat list — pola yang
sudah terbukti, tinggal digandakan (bug pertama versi M26: mismatch key
buffer `pid|id` vs lookup `id` — merge selalu miss. Konsistensi key map
adalah kontrak, bukan detail).

## Keputusan yang dipertahankan

- **Key tidak berlaku untuk `/auth/*`** — auth-refresh sengaja TIDAK meneruskan
  db ke resolver → key jatuh ke jalur JWT → 401. Flow end-user murni.
- **Key bypass rules** (service-level, seperti Supabase service_role) —
  didokumentasikan besar-besaran, bukan disembunyikan.
- **Hash at-rest** (SHA-256) + full key sekali saja — DB bocor ≠ akses bocor.

## Pertanyaan yang masih tersisa

- Key rotation otomatis (expire + re-issue)?
- Audit log per key (yang mana melakukan write — M-roadmap audit log)?
- IP allowlist per key untuk defense-in-depth?
