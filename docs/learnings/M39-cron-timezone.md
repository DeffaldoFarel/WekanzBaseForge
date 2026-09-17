# M39 — Cron Timezone: Intl.DateTimeFormat > hard-coded offset

## Apa yang kupikirkan sebelumnya
Timezone cuma offset angka. Asia/Jakarta = UTC+7, tinggal `getHours() + 7`.
Kalau butuh DST, tambah tabel exception.

## Apa yang ternyata benar
Offset hard-coded adalah jebakan klasis:

- "America/New_York" = **UTC-5 di winter, UTC-4 di summer** — nama zona
  IANA itu REGION + aturan DST, bukan satu angka
- Aturan DST berubah (pemerintah revisi) — tabel hard-coded kadaluarsa
- Tidak ada cara bersih menulis `getUTCHours() + offset` yang benar untuk
  semua zona tanpa re-implementasi database tzdata

Node punya jawabannya bawaan: `Intl.DateTimeFormat('en-US', { timeZone:
'America/New_York' })` — mesin ICU yang selalu ter-update, handle DST,
handle aturan historis. Tidak ada dependency, tidak ada tabel buatan.

## Aha! moment

**1. Konversi = format, bukan aritmetika.** Cara benar mengubah "17:00 UTC"
menjadi waktu Jakarta bukan `+7 jam`, tapi: format timestamp dalam zona
tersebut, lalu baca komponennya:
```ts
new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false,
  hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
  weekday: 'short' }).format(ts)
```
Hasil: "00 00 Wed 17" (jam, menit, hari, tanggal bulan) → cocokkan dengan
field cron. Format string jadi "decomposer" waktu lokal — kita bahkan tidak
perlu tahu offset-nya.

**2. Validasi zona = Intl sendiri.** `Intl.DateTimeFormat` throw untuk
zona tidak dikenal — jadi validator cukup try/catch konstruktor. Tapi
validasi format dulu dengan regex (`Area/City`), biar error message-nya
pesan yang jelas bukan exception mentah ICU.

**3. Default UTC, bukan server local.** Scheduler default `UTC` —
deterministik lintas mesin. Deploy di VPS apa pun, cron "0 0 * * *" =
tengah malam UTC, BUKAN tengah malam waktu mesin (yang bisa berubah kalau
admin iseng ganti `TZ`). Per-schedule timezone = kontrak eksplisit, seperti
cara Appwrite mendefinisikan function schedule.

**4. Test DST = test di bulan Januari.** January = winter di belahan utara
(NY = EST/UTC-5). Case "17:00 UTC = 12:00 EST" hanya benar di musim dingin.
Kalau test-nya pakai tanggal saat ini (September), DST aktif dan asersi
meleset — test timezone HARUS pakai tanggal fix (Jan vs Jul) untuk
menangkap kedua musim.

## Keputusan yang dipertahankan

- `Intl.DateTimeFormat` (ICU bawaan Node) — zero dependency, DST-aware
- Validasi 2 lapis: regex format → Intl existence check
- Default UTC; timezone opsional per-function, tersimpan di functionsStore
- At-most-once per menit tetap jadi kontrak scheduler (M15c reuse)

## Pertanyaan yang masih tersisa

- `Last-Event-ID` style catchup: kalau server mati melewati window cron,
  jalankan saat bangun? (sekarang: window terlewat = skip)
- Cron dengan second-resolution (`* * * * * *` ala Quartz)? — user "melee"
  test suite pakai `* * * * *` (per-menit) sudah cukup
- Timezone di backup scheduler (M32) — sekarang interval-based, gak cron;
  konflik desain kalau mau disatukan?
