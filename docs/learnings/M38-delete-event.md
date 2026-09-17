# M38 — Delete Event Payload: {id} ternyata kurang

## Apa yang kupikirkan sebelumnya
Delete = data udah gak ada. Kirim `{ id }` ke subscriber cukup — klien
tinggal filter array by id. Simple, minimal, hemat bandwidth.

## Apa yang ternyata benar
Klien cukup, tapi **klien bukan satu-satunya konsumen event**:

1. **Webhooks (M28) butuh full snapshot** — sistem eksternal yang menerima
   `record.deleted` mau tahu APA yang dihapus (audit, cache invalidation,
   sync downstream). `{id}` tanpa data = webhook receiver harus fetch
   balik... tapi record-nya udah gak ada. Dead end.
2. **Triggers/functions (M15b) yang reactive** — function yang perlu
   recompute agregat butuh konten record yang dihapus (mis. update summary
   setelah item dihapus).
3. **Rule evaluation pasca-delete** — beberapa pola mau cek `userId`
   record yang dihapus (filtering per-user di listener).

Solusi: snapshot record diambil SEBELUM delete, dikirim sebagai payload.
`deletePayload = snapshot ?? { id }` — fallback kalau snapshot gak
tersedia (edge case), backward compatible.

## Aha! moment

**1. Event delete = "last chance" melihat data.** Setelah DELETE SQL
sukses, data itu hilang selamanya — kapanpun sesudahnya, gak ada cara
reconstruct. Jadi snapshot HARUS ditangkap sebelum DB call, bukan setelah.
Urutan: fetch snapshot → DELETE → publish(snapshot).

**2. Snapshot gratis — gak ada biaya.** Delete route udah fetch record
untuk validasi exists (404 check). Snapshot = object yang sama, tinggal
dipakai ulang. Tambah fitur dengan nol query ekstra.

**3. Konsistensi 3 konsumen: realtime + webhook + trigger.** Payload yang
sama dikirim ke ketiganya — satu definisi "what happened", tiga saluran.
Kalau webhook kirim full record tapi realtime cuma {id}, dua konsumen
punya bayangan event yang berbeda = debugging mimpi buruk.

## Keputusan yang dipertahankan

- Full snapshot di ketiga saluran (realtime/webhook/trigger)
- Fallback `{id}` kalau snapshot null (defensive)
- Capture sebelum DELETE SQL, publish setelah DELETE sukses

## Pertanyaan yang masih tersisa

- Payload size limit untuk delete event besar (record dengan field file
  banyak — 1MB JSON di webhook?)
- Event versioning: kalau shape berubah, subscriber lama gak rusak?
- `before`/`after` di update event juga? (update udah kirim record baru —
  tapi `previous` untuk trigger udah ada dari M15b triggerExecutor)
