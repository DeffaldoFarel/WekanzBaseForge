// ============================================================================
// AUD-6-04: SAFE ROLLBACK — penanganan kegagalan ROLLBACK transaksi
//
// Empat lokasi transaksi (createRecordsBatch, deleteRecord, rebuildCollection,
// dst.) dulu memanggil db.exec('ROLLBACK') polos di blok catch. Jika COMMIT
// gagal (disk penuh / IO) lalu ROLLBACK IKUT gagal, error ROLLBACK MENIMPA
// error asli DAN transaksi zombie tertinggal terbuka — operasi berikutnya
// diam-diam bergabung ke dalamnya dan hilang saat rollback berikutnya.
//
// safeRollback: coba ROLLBACK; kalau gagal, log + coba sekali lagi; error ASLI
// tetap yang naik ke pemanggil apa pun yang terjadi.
// ============================================================================

import type { DatabaseSync } from 'node:sqlite';

export function safeRollback(db: DatabaseSync, err: unknown): never {
  try {
    db.exec('ROLLBACK');
  } catch (firstErr) {
    console.error(
      '[engine] ROLLBACK gagal setelah error transaksi — mencoba sekali lagi:',
      firstErr instanceof Error ? firstErr.message : firstErr
    );
    try {
      db.exec('ROLLBACK');
      console.error('[engine] ROLLBACK retry berhasil — transaksi tertutup');
    } catch (secondErr) {
      console.error(
        '[engine] ROLLBACK retry juga gagal — koneksi DB patut dicurigai (transaksi mungkin masih terbuka):',
        secondErr instanceof Error ? secondErr.message : secondErr
      );
    }
  }
  throw err;
}
