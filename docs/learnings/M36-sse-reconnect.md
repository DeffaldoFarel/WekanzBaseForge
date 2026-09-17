# M36 — SSE Auto-Reconnect: bug yang paling licik sejauh ini

## Apa yang kupikirkan sebelumnya
Koneksi drop itu kelihatan: error event, console merah, user komplain.
Klien reconnect tinggal delegate ke retry native browser.

## Apa yang ternyata benar
Koneksi SSE yang mati SETELAH connect itu **diam-diam** — dan itu bahaya
terbesarnya:

1. `EventSource` browser auto-retry sendiri → koneksi "tampak hidup"
2. Tapi `clientId`-nya baru, dan subscription tersimpan server-side per
   `clientId` LAMA → listener client gak pernah daftar ulang
3. `onerror` lama hanya reject initial connect; post-connect = no-op
4. Hasil: UI stale berjam-jam tanpa satu pun error — user percaya datanya
   fresh padahal berhenti update sejak network glitch tadi

Yang bikin licik: semua indikator kesehatan (console, network tab) hijau.
Stale data gak meninggalkan jejak.

## Aha! moment

**1. Reconnect = re-connect + re-SUBSCRIBE.** Dua langkah wajib, bukan satu.
Koneksi baru dapat clientId baru — tanpa `syncSubscriptions(newClientId)`
listener lama menggantung tanpa subscription server-side. Reconnect yang
hanya buka socket lagi = bug yang sama persis, cuma lebih sulit direproduksi.

**2. `onReconnect` hook — biar adapter yang handle data gap.** Antara drop
dan reconnect, event HILANG (SSE gak replay). Dua pilihan: replay via
`Last-Event-ID` (server harus buffer) atau **re-fetch initial data**
(klien yang udah punya `listAll` cukup fetch ulang). Pilih re-fetch:
sederhana, dan initial fetch-nya memang sudah ada di adapter pattern.

**3. `manuallyClosed` guard — unsubscribe ≠ disconnect.** `close()` dipanggil
saat unsubscribe terakhir juga memicu `onerror` di beberapa browser.
Tanpa flag, unsubscribe memicu reconnect loop yang gak pernah berhenti —
ngeyel connect padahal user sudah tutup tab subscription.

**4. Exponential backoff + reset saat sukses.** 1s → 2s → 4s → 8s → 16s →
cap 30s. Server down 10 menit tidak dihujani reconnect tiap detik. Sukses
→ `retryCount = 0` (server hidup lagi = percaya lagi cepat).

## Keputusan yang dipertahankan

- Backoff 1s awal, ×2, cap 30s
- Gap coverage via re-fetch initial data (bukan event replay)
- Reconnect diekspos sebagai event, bukan di-silent-kan — adapter perlu tahu
- DevDependency `eventsource` untuk test Node (Node gak punya EventSource global)

## Pertanyaan yang masih tersisa

- `Last-Event-ID` replay: server buffer ring N event terakhir — worth it?
- Heartbeat/ping periodik untuk deteksi "connected tapi zombie" (proxy yang
  keep-alive socket mati)
- Multiple tab share satu EventSource? (sekarang: satu per RealtimeService)
