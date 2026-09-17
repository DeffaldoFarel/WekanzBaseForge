# M28 — Webhooks + CLI: Developer Tooling & Integration

## Apa yang kupikirkan sebelumnya

Webhook = "HTTP POST keluar saat data berubah" — kelihatan sepele. CLI juga
kelihatan seperti tugas mekanis. Dua fitur "boring" yang kubayangkan
menghabiskan waktu di string formatting dan tabel terminal.

## Apa yang ternyata benar

Keduanya justru adalah **konsumsi arsitektur yang sudah ada**:
- Webhook = trigger executor M15b, tapi "function"-nya adalah HTTP POST ke URL
  eksternal. Sistem event matching, fire-and-forget, fail-safe — semua pola
  yang sudah teruji.
- CLI = HTTP client tipis ke Admin API. Nol logika bisnis — hanya arg parser
  + fetch + pretty-printer. Prinsip "semua bisa via API" (dari M00) membayar
  dividen: CLI 400 baris mencakup seluruh platform.

## Aha! moment

**1. HMAC signature = trust tanpa mTLS.**
Webhook ke internet tidak bisa di-auth dengan password di URL (terlihat di log).
Pola Stripe/GitHub: `X-Signature: sha256=<HMAC-SHA256(body, secret)>`. Penerima
menghitung HMAC dari raw body dengan secret yang sama — verifikasi tanpa
mengirim kredensial. Body HARUS dibaca raw (bukan re-serialize) — JSON.stringify
ulang menghasilkan string berbeda → signature mismatch. Ini mengajari sesuatu
yang dalam tentang serialization: **byte-level fidelity adalah kontrak**.

**2. Retry dengan exponential backoff bukan polling.**
3 attempt dengan backoff 1s → 4s (×4): endpoint yang down sementara pulih
sendiri tanpa menara retry. Test "flaky" (500, 500, 200) membuktikan: attempt
3 sukses, log delivery menunjukkan ok=true di baris terakhir. Kalau backoff
fixed 1s, server yang restart (biasanya 5-10s) akan selalu kalah 3 attempt.

**3. CLI state = file sederhana, bukan config system.**
`~/.baseforge/cli.json` — 30 byte JSON (token, pid, url). Tidak perlu
TOML/YAML/config layer. Git, kubectl, gcloud semua mulai dari file JSON di
home dir; kompleksitas config datang BELAKANG (profiles, contexts) saat
dibutuhkan, bukan di depan.

**4. `execFile` di Windows adalah medan ranjau.**
`execFile('npx')` → ENOENT (npx adalah .cmd, bukan .exe). Fix attempt 1:
`npx.cmd` → `EINVAL` (Windows + .cmd + execFile tanpa shell). Fix final:
**`process.execPath` (node.exe) + `--import tsx`** — bypass seluruh masalah
.cmd dengan menjalankan node langsung. Pelajaran: test child process di
Windows, gunakan `process.execPath` dari awal.

**5. Webhook untuk DEVELOPER vs trigger untuk PLATFORM.**
Function trigger M15b = kode berjalan DI server BaseForge (developer
meng-upload kode). Webhook M28 = BaseForge MEMANGGIL keluar (developer
menyediakan server). Dua arah integrasi yang berbeda — komplementer, bukan
bersaing. PocketBase punya hook, Stripe punya webhook, BaseForge kini punya
keduanya.

## Pertanyaan yang masih tersisa

- Webhook batching: 100 record creates = 100 POST calls? (PocketBase tidak
  batching juga — tapi rate limit penerima bisa jadi masalah)
- Dead letter queue: webhook gagal 3x → masuk tabel dead-letter untuk
  inspeksi manual (saat ini hanya delivery log)
- CLI: `baseforge migrate` (schema diff → table rebuild), `baseforge backup`
- CLI: output JSON mode (`--json`) untuk piping ke jq

## Fix test yang menarik

Test webhooks "update record" gagal 403 — collection hanya punya
`listRule`/`createRule` publik, tidak `updateRule`/`deleteRule`. **Fitur
keamanan bekerja dengan benar — test yang salah.** Fix: semua rules diset
publik di setup. Ini bukan bug; ini konfirmasi bahwa rules M11 benar-benar
menutup celah.
