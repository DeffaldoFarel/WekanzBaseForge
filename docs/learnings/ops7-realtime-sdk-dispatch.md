# Ops-7: Realtime SDK dispatch fix — envelope {collection, action, record}

**Tanggal:** 2026-09-19
**Pemicu:** ditemukan saat menjawab audit "apakah BaseForge sudah standar BaaS" — setelah Ops-6 (server) live, jalur event dashboard masih mati: **SDK menganggap seluruh envelope SSE sebagai `record`**.

## Ekspektasi (sebelum investigasi)

Setelah Ops-6 (route bulk sync + auth upgrade + fail-safe delete), SDK vendored WekanzDashboard seharusnya mulai menerima delta realtime tanpa perubahan client. Kenyataannya listener dashboard tetap tidak pernah menerima event.

## Temuan (dibaca dari kode, baris ke baris)

`packages/client/src/services/realtimeService.ts` — handler event CRUD:

```ts
const data = JSON.parse(e.data);                       // data = ENVELOPE {collection, action, record}
const record = (action === 'delete' ? data : data);    // ← BUG: envelope DIPAKAI sebagai record
const collection = (e as ...).originCollection;        // ← BUG: properti tidak pernah ada di MessageEvent (dead code)
this.dispatch(action, record, collection);
```

Server (`core/realtime.ts` publish) SELALU mengirim envelope: `JSON.stringify({ collection: meta.name, action, record })` — sejak M13. Akibat dua bug itu:

1. `collection` selalu `undefined` → `dispatch()` mencocokkan event ke **semua** topik (`matchesCol = !collection || …`).
2. `record` = envelope, bukan record asli → listener menerima `e.record.userId === undefined` → guard consumer (mis. wrapper dashboard `rec.userId !== userId`) **menjatuhkan SEMUA event** → realtime mati total untuk setiap konsumen SDK yang memfilter per-field, dan listener tanpa filter menerima bentuk data yang salah.

`originCollection` tidak pernah di-set oleh siapa pun — dead code sejak file ini ditulis; tidak ada test yang membuktikan bentuk event yang diterima listener.

## Desain

`handleEvent` mem-parse envelope server dan fallback ke record telanjang (kompatibilitas payload non-envelope):

- `record = data.record` (envelope) — fallback `data` (record telanjang)
- `collection = data.collection` — `undefined` jika tidak ada
- `dispatch(action, record, collection)` tidak berubah — topik `col/*` dan `col/<id>` kini benar-benar match per-collection; `originCollection` dead code dihapus
- Kontrak publik listener TIDAK berubah: `RealtimeEvent = { action, record }`

## File yang berubah

- `packages/client/src/services/realtimeService.ts` — fix handleEvent
- `packages/client/tests/realtime.test.ts` — BARU: (A) unit dispatch via FakeEventSource + stub HTTP (tanpa server BaseForge), (B) integration end-to-end: MiniEventSource polyfill → server nyata → subscribe → create → listener menerima delta
- `packages/client/package.json` — version bump 0.2.0 → 0.2.1
- Dashboard (repo terpisah, LOKAL saja tanpa commit): re-vendor `dist/*` per VENDORED.md

## Checklist

- [x] Concept doc (file ini)
- [x] Fix handleEvent + hapus dead code `originCollection`
- [x] `tsc` packages/client 0 error (build sukses, dist ter-regenerate)
- [x] Test baru (A unit + B integration) hijau — realtime.test.ts
- [x] `npm run test:client` penuh — **13/13** (client.test.ts 6 lama + 7 baru)
- [x] `npm test` server suite — **605/605** (no-regresi)
- [x] Jurnal + Aha
- [x] Commit + push
- [x] Re-vendor ke dashboard + `tsc -p tsconfig.json` + bukti file vendored berisi fix

## Aha Moments

1. **Bug yang bertahan paling lama adalah bug yang menghasilkan *bentuk data salah*, bukan *error*.** Seluruh rantai realtime (connect → bulk sync → publish → rules) benar pasca-Ops-6 — event SAMPAI ke listener, tapi listener menerima envelope `{collection, action, record}` sebagai `record`. Tidak ada exception, tidak ada test merah, widget tetap "menampilkan data awal". Gejalanya persis feature yang belum jalan, padahal jalurnya sudah hidup 95%. Pelajaran: kontrak payload harus diuji SAMPAI bentuk field terakhir yang dikonsumsi (`e.record.userId`), bukan berhenti di "listener terpanggil".

2. **Dead code bisa jadi "kontrol palsu" yang menutupi bug selama audit kode biasa.** Baris `(e as …).originCollection` terlihat seperti mekanisme pengambil collection yang sah — dan karena `matchesCol = !collection || …` di dispatch-nya toleran `undefined`, sistem "tetap bekerja" untuk semua event (`col/*` match semua). Filter collection yang diiklankan SDK (`col/*` vs `col/id`) sebenarnya TIDAK PERNAH memfilter apa pun selama bertahun-tahun. Pelajaran: parameter filter yang selalu-`undefined` seharusnya dianggap alarm, bukan normal — test wajib membuktikan jalur filter AKTIF (test Ops-7: `notes/*` tidak menerima event `other`).

3. **`node:test` + polyfill 40-baris menggantikan browser penuh untuk integration SDK.** Node 24 tidak punya `EventSource` global — dan justru itu peluang: `MiniEventSource` (fetch-stream + parser frame SSE) dipasang di `globalThis.EventSource` sebelum construct SDK, menguji jalur yang PERSIS dipakai dashboard (EventSource → PB_CONNECT → subscribe → delta) tanpa Puppeteer. Test integration kini bisa masuk suite reguler `npm run test:client` (auto-skip bila server 5100 tidak jalan).

