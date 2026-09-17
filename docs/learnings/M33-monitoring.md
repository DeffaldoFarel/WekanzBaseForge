# M33 — Monitoring/Alerting: Threshold Rules + Webhook Notification

## Apa yang kupikirkan sebelumnya

Monitoring = Prometheus + Grafana + AlertManager. Stack terpisah, YAML config,
Docker containers. Kompleks untuk $3 VPS dengan 512MB RAM.

## Apa yang ternyata benar

Monitoring yang BaseForge butuh bukan Grafana — cuma:
1. **Threshold check** (value > limit?) — 1 baris if-statement
2. **Alert state** (firing/resolved) — tabel SQLite + 2 kolom status
3. **Notification** (webhook POST) — fetch + JSON (M28 pattern reuse)
4. **Scheduler** (cek tiap 30s) — M15c pattern reuse

Total: ~250 baris. Zero dependency. Berjalan di process yang sama.

## Aha! moment

**1. Alert lifecycle = state machine 2-state.**
```
   value > threshold        value <= threshold
   ┌──────────┐    trigger    ┌──────────┐
   │  normal  │ ──────────→ │  firing  │
   │          │ ←────────── │          │
   └──────────┘   resolve   └──────────┘
```
Hanya 2 state. Transisi = 2 if-statement. Tidak perlu state machine library.

**2. Cooldown bukan kompleks — cuma time diff.**
Alert "firing" yang sudah 15 menit → log warning (re-notify opsional).
Alert yang baru 2 menit → skip. `now - triggeredAt >= cooldownMinutes`.
Satu perbandingan timestamp.

**3. Webhook payload = Slack/Discord/Telegram compatible.**
Slack: `{ text: "...", attachments: [{ color, fields }] }`
Discord: sama format (Slack-compatible webhook URL)
Telegram: `{ text: "..." }` juga diterima
Satu payload JSON untuk ketiganya.

**4. Platform DB persistence + module-level DATA_DIR = test debugging.**
Test m33 gagal 2/8 di full suite tapi pass 8/8 individual. Penyebab:
`DATA_DIR` di platformDb.ts di-resolve SAAT IMPORT (module load), bukan saat
`before()` dipanggil. Jadi `process.env.DATA_DIR = TEST_DATA_DIR` di test
TIDAK mempengaruhi platform DB — semuanya jalan di real `../data`. Config
dari run sebelumnya persist → "default off" test gagal (enabled=true dari
run sebelumnya). Fix: reset config + clear alerts di `before()` hook.

Ini adalah bug LATEN yang mempengaruhi SEMUA test yang pakai platform.db
settings (M23 mailer, M26 API keys, M30 storage config, M33 monitoring).
Test masing-masing pass individual karena config di-reset — tapi full suite
run semua test secara sequential dalam process yang sama, dan platform DB
yang sama men-share state.

**5. Force check = manual trigger untuk debugging.**
`POST /monitoring/check` → evaluasi semua rules SEKARANG, tanpa menunggu
30 detik scheduler. Untuk admin yang ingin verifikasi "apakah monitoring
bekerja?" tanpa harus menunggu interval.

## Keputusan yang dipertahankan

- **4 rules default** (request rate, bandwidth, error rate, disk usage) —
  mencakup 95% kebutuhan self-hoster
- **OFF by default** — monitoring adalah opt-in feature (tidak mengganggu yang tidak butuh)
- **Webhook Slack-format** — kompatibel dengan 3 platform chat terbesar
- **Tabel `_alerts` di platform.db** — alert adalah platform-level, bukan
  per-project (request rate agregat lintas project)

## Pertanyaan yang masih tersisa

- Error rate tracking (butuh per-request status logging — extend M24 metrics)
- Disk usage (butuh statfs — node:fs tidak punya; alternative: `df -h` exec)
- Email notification via M23 SMTP (tambah channel)
- Alert routing (rule → project → channel yang berbeda)
- Downtime detection (heartbeat ping ke endpoint)
