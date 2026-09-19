# Ops-8: Dynamic Project Resolution in Scheduler (fix snapshot saat boot)

**Tanggal:** 2026-09-19
**Pemicu:** Ditemukan saat real-test Fase 6 migrasi WekanzDashboard — cron `daily_rollover` di project uji tidak pernah ter-tick oleh scheduler karena project dibuat setelah server start.

## Ekspektasi (sebelum investigasi)

Function dengan `schedule` valid (mis. `0 0 * * *` atau `* * * * *`) di project manapun yang aktif harus dieksekusi secara periodik oleh scheduler singleton setiap 30 detik, tanpa mensyaratkan restart server.

## Temuan (akar masalah di kode)

Di `server/src/index.ts` (implementasi M15c awal):

```ts
server.listen(PORT, () => {
  ...
  scheduler.start(getProjectDbProviders());
  ...
});

function getProjectDbProviders(): (() => DatabaseSync)[] {
  const projects = listProjects();
  return projects.map((p) => () => getProjectDb(p.id));
}
```

Dan di `server/src/core/scheduler.ts`:

```ts
start(dbProviders: (() => DatabaseSync)[]): void {
  this.dbProviders = dbProviders;
  ...
}

private tick(): void {
  for (const provider of this.dbProviders) { ... }
}
```

1. **Snapshot statis saat boot**: `listProjects()` hanya dipanggil SATU KALI saat server boot. Setiap project yang dibuat setelahnya via `POST /api/admin/projects` (atau automation/smoke test/multi-tenant provisioning) tidak pernah masuk ke `this.dbProviders`. Akibatnya, seluruh scheduled functions di project baru **mati diam-diam** (silent failure) sampai ada restart server.
2. **Project terhapus tetap di-tick**: Project yang dihapus via `DELETE /api/admin/projects/:id` tetap ada di `this.dbProviders` dan dipanggil terus setiap 30 detik (menghasilkan error tangkapan di log).
3. **Inkonsistensi arsitektur internal**: Berbeda dari scheduler M15c, komponen terjadwal lain yang dibuat kemudian (M32 `backupScheduler` dan M33 `monitorScheduler`) sudah menggunakan pola yang benar: memanggil `listProjects()` secara dinamis di setiap siklus tick.

## Desain & Perbaikan

1. **Resolusi dinamis di setiap tick**:
   - `scheduler.start()` kini tidak mewajibkan parameter array provider (default: tanpa argumen).
   - Di dalam `tick()`, jika tidak ada `customProviders`, scheduler membaca `listProjects()` langsung dari `platform.db` dan mengambil koneksi DB project via `getProjectDb(project.id)`.
   - SQLite query `SELECT * FROM projects` pada `platform.db` berbiaya < 0.1ms per 30 detik dan koneksi project DB sudah di-cache oleh `projectDbManager` (connection pooling).
2. **Project lifecycle otomatis**:
   - Project baru: langsung ikut dievaluasi pada tick berikutnya (maks 30 detik).
   - Project terhapus: langsung hilang dari `listProjects()`, tidak lagi di-tick.
3. **Backward compatibility**:
   - `scheduler.start(customProviders)` tetap didukung penuh untuk isolasi unit test yang tidak menggunakan `platform.db` (mis. `m15c-scheduler.test.ts`).
   - `scheduler.stop()` membersihkan `customProviders`.
4. **Cleanup `index.ts`**:
   - Menghapus helper `getProjectDbProviders()` dari `index.ts` dan memanggil `scheduler.start()` secara konsisten seperti `backupScheduler.start()` dan `monitorScheduler.start()`.

## File yang berubah

- `server/src/core/scheduler.ts` — import `listProjects` & `getProjectDb`; resolusi dinamis jika `customProviders` null; `stop()` cleanup.
- `server/src/index.ts` — panggil `scheduler.start()` tanpa argumen statis; buang `getProjectDbProviders()`.
- `server/tests/ops8-scheduler-dynamic-projects.test.ts` — BARU: 4 unit/integration test (project awal, project dinamis baru, disabled function, dan backward-compat customProviders).

## Hasil Pengujian

1. `tests/ops8-scheduler-dynamic-projects.test.ts`: **4/4 PASS**
2. `tests/m15c-scheduler.test.ts`: **13/13 PASS**
3. `tests/m39-cron-timezone.test.ts`: **8/8 PASS**
4. Full regression `npm test`: **609/609 PASS** (+4 test baru dari 605)
