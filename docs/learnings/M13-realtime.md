# M13 — Realtime: Server-Sent Events (SSE) ala PocketBase

> **Konsep:** langganan perubahan collection secara realtime — client menerima event create/update/delete SEBELUM long-polling diciptakan (ok, setelahnya — tapi jauh lebih elegan!).

## 🎯 Masalah yang Dipecahkan

Sampai M13, client harus POLLING untuk tahu data baru: "apakah ada
record baru? sekarang? sekarang?" — boros request & delay. Realtime
memutar arah: server MENGIRIM ke client saat data berubah.

## 🧠 Kenapa SSE, bukan WebSocket?

| Aspek | SSE | WebSocket |
|---|---|---|
| Arah | server → client (one-way) | dua arah |
| Protocol | HTTP biasa | upgrade ke ws:// |
| Auth | Bearer header biasa ✅ | butuh token di query/cookie |
| Reconnect | otomatis by browser | manual |
| Format | text stream (event: + data:) | frame binary/text |

PocketBase memilih SSE: auth pakai header yang sama, reconnect gratis,
dan cukup untuk kasus "data berubah → UI update". MQTT/WebSocket cuma
perlu kalau client juga kirim data realtime (chat, game) — itu tugas
server functions nanti.

## 🎫 PB_CONNECT + model token (keamanan realtime)

SSE TIDAK bisa set header setelah connect (EventSource API terbatas).
Pola PocketBase:
1. POST /api/realtime → connect dulu → server buat PB_CONNECT id
2. Client kirim Auth header SAAT connect — server validasi → simpan
   auth di koneksi
3. Subscribe: client kirim PB_CONNECT id + collection — server cek
   rules SEBELUM kirim event apapun

Model token: setiap subscribe → server kirim PB_SUBSCRIBE dengan
token unik per (koneksi, collection, filter). Event hanya dikirim ke
subscriber dengan rule yang lolos.

## 📡 Format wire (SSE)

```
event: PB_CONNECT
data: {"clientId":"abc123"}

event: PB_SUBSCRIBE
data: {"tokenId":"xyz","collection":"posts"}

event: PB_CREATE
data: {"collection":"posts","record":{...}}

event: PB_UPDATE / PB_DELETE — sama bentuknya
```

## 🏗️ Arsitektur: pub/sub di memory, broadcast saat CRUD

```
RealtimeHub (singleton per proses)
  clients: Map<clientId, ClientConnection>
    .auth      → RequestContext (diisi saat connect)
    .subs: Map<subId, { collection, filter?, token }>
  publish(collection, action, record)
    → untuk tiap koneksi yang subscribe collection itu:
      cek rules (listRule) terhadap auth koneksi
      cek filter (jika ada) terhadap record
      → kirim SSE event
```

records.ts tambah hook: setelah INSERT/UPDATE/DELETE sukses →
hub.publish(...). Karena Core tidak tahu projectId (multi-tenant),
projectId di-pass dari API layer (sudah ada — publicRoutes).

## ✅ Definisi Selesai

- [ ] RealtimeHub: connect/subscribe/unsubscribe/publish
- [ ] GET /api/realtime (SSE) + POST /api/realtime (connect)
- [ ] Auth: Bearer saat connect → reqCtx koneksi
- [ ] Rules dicek saat publish (bukan saat subscribe) — karena rules
      bisa berubah kapan pun (M11)
- [ ] PB_CREATE / PB_UPDATE / PB_DELETE terkirim ke subscriber yang berhak
- [ ] Subscriber TANPA hak tidak menerima apapun (bukan error!)
- [ ] Integration test dengan HTTP client nyata
- [ ] Jurnal + commit

## 📝 Aha! Moments

### Aha! #1 — SSE = HTTP biasa, auth gratis
Tidak ada upgrade protocol, tidak ada library ws. Koneksi SSE hanyalah
GET response yang tidak pernah di-end + header text/event-stream. Auth
BISA pakai Bearer header biasa (karena masih HTTP!) — WebSocket tidak
bisa tanpa trik query param/cookie. Reconnect otomatis oleh browser.
Ini kenapa PocketBase memilih SSE untuk fitur realtime-nya.

### Aha! #2 — Rules dicek SAAT PUBLISH, bukan saat subscribe
Kalau dicek saat subscribe: admin mengubah rule setelah client
subscribe → client lama masih menerima event dengan izin lama. Dengan
cek saat publish: setiap event dievaluasi terhadap rule TERKINI +
auth koneksi. Keamanan realtime = keamanan komposisional (reuses M11
decideRule + query engine M04 — bukan evaluator baru!).

### Aha! #3 — Delete event punya dilema keamanan unik
Saat delete, record SUDAH terhapus → SELECT rule-check pasti kosong →
semua subscriber terblokir. Solusi fail-safe: delete event hanya
dikirim jika rule publik, admin, atau rule own-data (@request.auth.id).
Record tanpa kepemilikan jelas → tidak di-broadcast. Fail-safe > fail-open.

### Aha! #4 — Shorthand property bug yang nyaris tak terlihat
`{ clientIdA, collection }` mengirim key `clientIdA` — handler membaca
`clientId` → undefined → 400 diam-diam. Test gagal dengan "0 events"
yang SANGAT jauh dari akar masalah. Debug cepat: console.log status
response subscribe (400) langsung menunjuk masalahnya. Lesson: selalu
assert status response HTTP di test — jangan hanya efek akhirnya.

### Aha! #5 — Satu process, banyak project: hub global, db per-request
RealtimeHub singleton menyimpan koneksi lintas project. Publish butuh
db+meta project — di-pass dari API layer (yang tahu projectId). Core
tetap ignorant terhadap multi-tenancy — arsitektur M00 tetap utuh.

## ✅ Status: SELESAI — 7/7 test realtime (HTTP+SSE nyata), 207/207 total — 2026-09-12
