// ============================================================================
// M17b: FULL-TEXT SEARCH — FTS5 (built-in SQLite, zero dependency!)
//
// Konsep:
// - Field dengan options.fulltext = true → dibuat tabel virtual FTS5:
//   _fts_<collection> (field-field itu + record_id UNINDEXED)
// - Sinkronisasi otomatis via SQLite TRIGGERS (AFTER INSERT/UPDATE/DELETE)
//   → search selalu up-to-date; sinkron DI DALAM transaksi write (atomik!)
// - Delete pakai DELETE FROM fts WHERE record_id = ? (FTS5 normal table
//   mendukung DELETE langsung — lebih sederhana dari special 'delete'
//   command yang butuh contentless table)
// - Endpoint: GET .../records?search=kopi → MATCH join
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { CollectionMeta } from './schema.js';

export function ftsTableName(collection: string): string {
  return `_fts_${collection}`;
}

// ─── Field fulltext collection ───────────────────────────────────────────────

export function ftsFields(meta: CollectionMeta): string[] | null {
  const fields = meta.fields.filter((f) => f.options?.fulltext === true).map((f) => f.name);
  return fields.length > 0 ? fields : null;
}

// ─── Buat FTS table + triggers saat collection didefinisikan ────────────────

export function createFts(db: DatabaseSync, collection: string, fields: string[]): void {
  const table = ftsTableName(collection);
  const cols = fields.map((f) => `"${f}"`).join(', ');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS "${table}" USING fts5(
      ${cols},
      record_id UNINDEXED
    );
  `);

  // AFTER INSERT: sinkronkan index
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS "_fts_ai_${collection}"
    AFTER INSERT ON "${collection}" BEGIN
      INSERT INTO "${table}" (record_id, ${cols})
      VALUES (new."id", ${fields.map((f) => `new."${f}"`).join(', ')});
    END;
  `);

  // AFTER DELETE: hapus dari index (DELETE langsung — FTS5 normal table)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS "_fts_ad_${collection}"
    AFTER DELETE ON "${collection}" BEGIN
      DELETE FROM "${table}" WHERE record_id = old."id";
    END;
  `);

  // AFTER UPDATE: hapus lama + insert baru
  const newVals = fields.map((f) => `new."${f}"`).join(', ');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS "_fts_au_${collection}"
    AFTER UPDATE ON "${collection}" BEGIN
      DELETE FROM "${table}" WHERE record_id = old."id";
      INSERT INTO "${table}" (record_id, ${cols})
      VALUES (new."id", ${newVals});
    END;
  `);
}

export function dropFts(db: DatabaseSync, collection: string): void {
  db.exec(`DROP TABLE IF EXISTS "${ftsTableName(collection)}";`);
  db.exec(`DROP TRIGGER IF EXISTS "_fts_ai_${collection}";`);
  db.exec(`DROP TRIGGER IF EXISTS "_fts_ad_${collection}";`);
  db.exec(`DROP TRIGGER IF EXISTS "_fts_au_${collection}";`);
}

// ─── Query sanitasi untuk FTS5 MATCH ─────────────────────────────────────────
// - quote tiap token → phrase (aman dari operator FTS asing)
// - prefix * di token terakhir → UX pencarian lebih baik
// - M18e hardening: buang token non-word murni (`***`, `***`, `---`), dan
//   operator FTS5 yang lolos dalam phrase (OR/AND/NOT/NEAR di luar quote)
//   tetap TIDAK aktif karena tiap token dibungkus `"..."`.
//   Token yang mengandung `"` dihapus dari karakter itu — sisa huruf aman.
// "kopi gayo" → '"kopi" "gayo"*'

export function sanitizeFtsQuery(search: string): string {
  const tokens = search
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    // M18e: buang token yang setelah pembersihan tidak punya karakter
    // alphanumeric sama sekali (`***`, `---`, `*`, punct-only) — token begitu
    // di dalam `"..."` diabaikan FTS5, tapi lebih bersih dibuang di sini.
    .filter((t) => /[\p{L}\p{N}]/u.test(t));

  if (tokens.length === 0) return '';

  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? '*' : ''}`).join(' ');
}
