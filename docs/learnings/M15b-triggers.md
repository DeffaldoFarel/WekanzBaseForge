# M15b — Database Triggers: Functions yang Berjalan Saat Data Berubah

> **Konsep:** function dengan `triggers: [{ collection, actions }]` berjalan otomatis saat create/update/delete terjadi — `onRecordCreate` ala Firebase, data-driven.

## 🧠 Kontrak Konteks Trigger

```js
// di dalam sandbox, req berisi:
{
  action:     'create' | 'update' | 'delete',
  collection: 'orders',
  record:     { id, item, qty, ... },  // utk delete: hanya { id }
  previous:   { ... } | null,          // snapshot SEBELUM update
}
// return value diabaikan; console.log → server log
```

## 🛡️ Keputusan Desain Penting

1. **Trigger error ≠ gagal CRUD.** Data sudah tersimpan; error trigger
   dicatat di log server. Operasi user tidak jadi sandera kode user.
2. **Anti infinite loop by construction:** konteks trigger TIDAK punya
   akses DB → function ter-trigger tidak bisa menulis → tidak bisa
   memicu dirinya sendiri. (Kalau nanti butuh write-from-trigger:
   WAJIB re-entry guard.)
3. **Admin route sengaja TIDAK memicu trigger** — operasi maintenance
   (backfill/fix) tidak boleh memicu side effects. Trigger hanya di
   public route (path end user).
4. **Timeout tetap berlaku** (M15a) — trigger infinite loop ditahan,
   CRUD tetap selesai.
5. **Urutan reaksi:** DB commit → realtime publish → triggers → file
   cleanup. Data konsisten dulu, reaksi kemudian.

## 📁 Perubahan

```
core/functionsStore.ts  → kolom triggers (JSON), validasi collection+action
core/functionRunner.ts  → triggerContext: req = { action, collection, record, previous }
core/triggerExecutor.ts → fireTriggers(Safe): cari function cocok, jalankan, log
api/functionRoutes.ts   → CRUD menerima + validasi triggers (collection harus ada)
api/publicRoutes.ts     → fireTriggersSafe setelah create/update/delete
```

## 📝 Aha! Moments

### Aha! #1 — Trigger = CRUD + sandbox, bukan sistem baru
Engine eksekusi yang sama (runFunctionCode) — timeout, console capture,
sandbox gratis. Yang baru hanya kolom triggers + 3 titik panggil.
Rekomposisi lagi: M15a + M05 = M15b.

### Aha! #2 — Fail-open vs fail-close yang tepat
Trigger error → operasi asli tetap sukses (fail-open untuk UX), tapi
error TERLIHAT di log server (fail-loud untuk operator). Kombinasi
keduanya yang benar, bukan salah satu.

### Aha! #3 — previous gratis dari M14
Snapshot `oldRecord` di PATCH handler dibuat untuk cleanup file lama
(M14). Trigger update tinggal memakainya — `req.previous.status + ' → '
+ req.record.status`. Kerja kemarin membayar hari ini.

## ✅ Status: SELESAI — 9/9 test trigger, 229/229 total — 2026-09-12
