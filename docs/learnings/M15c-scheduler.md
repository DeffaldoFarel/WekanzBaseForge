# M15c — Scheduler: Cron untuk Functions

> **Konsep:** function dengan `schedule` (cron expression) berjalan otomatis sesuai jadwal — `dailyHabitStreakDecay` ala Firebase `functions.pubsub.schedule('0 1 * * *')`, data-driven.

## 🧠 Cara Kerja

```
setInterval pengecek (tiap 30 detik):
  sekarang = minute precision timestamp
  untuk tiap function dengan schedule:
    apakah menit ini cocok dengan cron expression?
    apakah sudah pernah jalan di menit ini? (anti double-fire)
    → ya: jalankan di sandbox (req = { scheduled: true, ... })
```

## ⏰ Cron Expression (5 field, standar Unix)

```
┌───────────── minute      (0-59)
│ ┌───────────── hour       (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month    (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Minggu=0)
│ │ │ │ │
* * * * *

"0 1 * * *"     → setiap hari jam 01:00
"*/15 * * * *"  → setiap 15 menit
"30 8 * * 1-5"  → hari kerja jam 08:30
"0 0 1 * *"     → tanggal 1 setiap bulan
```

Parser cron ditulis sendiri (zero dependency): field → daftar nilai
(`*` = semua, `*/N` = step, `A-B` = range, `A,B` = list).

## 🛡️ Anti Double-Fire + Anti Miss

- **Anti double-fire**: catat `lastRunMinute` per function — satu menit
  hanya sekali, walau ceker jalan 2x.
- **Server restart**: function yang jadwalnya lewat saat server mati
  TIDAK dijalankan ulang (miss = miss; at-most-once semantics). Untuk
  at-least-once + catch-up: milestone lanjutan.
- **Zona waktu**: cron dievaluasi di waktu server (WIB untuk VPS kita).
  Per project timezone: milestone lanjutan.

## ⚙️ Konteks & Keamanan (mewarisi M15a)

```js
// req di sandbox:
{ scheduled: true, time: '2026-09-12T01:00:00.000Z' }
// Tanpa req.body/query/auth — scheduled run TIDAK terkait request user
```

Sandbox yang sama: tanpa host access, timeout berlaku, console
tertangkap → server log.

## 📁 Perubahan

```
core/cronParser.ts    → parse & match cron 5-field (zero dependency)
core/functionsStore.ts→ kolom schedule (TEXT nullable)
core/scheduler.ts     → singleton loop 30s + anti double-fire + fire
api/functionRoutes.ts → CRUD menerima schedule + validasi
tests/m15c-scheduler.test.ts
```

## ✅ Definisi Selesai

- [ ] Parser cron: `*`, angka, `*/N`, `A-B`, `A,B`, kombinasi
- [ ] Match menit-dprecision
- [ ] Scheduler loop + anti double-fire (1 menit = 1 run)
- [ ] create/patch function dengan schedule (validasi format)
- [ ] Integration test: schedule `* * * * *` → jalan dalam ≤60s (atau unit test parser + match langsung)
- [ ] Jurnal + commit

## 📝 Aha! Moments

### Aha! #1 — Cron parser ternyata kecil (dan menakutkan kalau salah)
5 field, 4 syntax (*, N, A-B, A,B, step) — parser-nya hanya ~70 baris.
TAPI semantiknya harus presisi: `*/15` di jam = 0,15,30,45 (dari NOL),
bukan offset. Range terbalik (5-1) harus ditolak, step 0 ditolak.
Unit test menit-precision dengan tanggal palsu (2026-09-12 = Sabtu)
membuktikan tiap field bekerja. Lesson: date/time logic WAJIB test
dengan tanggal yang dikontrol penuh.

### Aha! #2 — Anti double-fire: tandai SEBELUM run
Kalau menunggu run selesai baru menandai: run yang crash → dicoba
lagi → crash lagi (loop log error tiap 30 detik). Dengan menandai
SEBELUM: crash = miss menit itu, jalan lagi menit depan sesuai jadwal.
At-most-once semantics yang jujur — dan diakui di jurnal: restart
server tidak me-run ulang jadwal yang terlewat (catch-up = lanjutan).

### Aha! #3 — Interval 30s = menit tak pernah terlewat
Intuisi bilang "cron harus cek tiap menit". Kenyataannya: interval 30s
menjamin SETIAP menit ter-lihat 2x — lebih tahan terhadap timing jitter
interval Node.js. plus anti double-fire membuat cek ganda jadi aman.

### Aha! #4 — unref(): server yang sopan
timer.unref() membuat interval tidak menahan proses — server bisa
mati dengan rapi tanpa "hanging on open handle". Detail kecil yang
membedakan library produksi dari script.

### Aha! #5 — scheduledContext vs triggerContext vs callable
Tiga bentuk req, satu runner: prioritas scheduled > trigger > callable
ditentukan di SATU titik (functionRunner). Tidak ada if/else tersebar —
kontrak function terdokumentasi rapi di docs/learnings.

## ✅ Status: SELESAI — 13/13 test M15c, 242/242 total — 2026-09-12
