// ============================================================================
// AUD-2-02/03: RECORD OUTPUT SERIALIZATION — deserialize untuk SEMUA jalur
//
// Sebelumnya deserializeRow hidup privat di records.ts. Expand (relations.ts)
// dan vector-search (vectorSearch.ts) memuat baris mentah `SELECT *` dan
// menempelnya ke response APA ADANYA — kolom password_hash (collection auth)
// dan hash scrypt field tipe password ikut bocor (probe audit FASE 2:
// expand.author.password_hash = scrypt:...).
//
// Modul terpisah memutus import-cycle records.ts ↔ relations.ts, sehingga
// ketiga jalur output kini berbagi SATU deserialize yang sama.
// ============================================================================

import type { CollectionMeta } from './schema.js';
import type { FieldDefinition } from './fieldTypes.js';
import type { ForgeRecord } from './records.js';

function fieldMap(meta: CollectionMeta): Map<string, FieldDefinition> {
  return new Map(meta.fields.map((f) => [f.name, f]));
}

/**
 * DESERIALIZE: baris mentah SQLite → bentuk yang diharapkan user.
 * 1/0 → true/false, string JSON → object, hash password TIDAK PERNAH keluar.
 */
export function deserializeRow(meta: CollectionMeta, row: Record<string, unknown>): ForgeRecord {
  const fmap = fieldMap(meta);
  const result: Record<string, unknown> = { ...row };

  for (const [key, value] of Object.entries(result)) {
    const field = fmap.get(key);
    if (!field || value === null) continue;

    if (field.type === 'bool') {
      result[key] = value === 1;
    } else if (field.type === 'json' && typeof value === 'string') {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value; // biarkan apa adanya kalau bukan JSON valid
      }
    } else if (field.type === 'relation' && typeof value === 'string') {
      // D2: multi-relation disimpan sebagai JSON array → parse kembali
      const isMulti = (field.options?.maxSelect ?? 1) > 1;
      if (isMulti) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          result[key] = [];
        }
      }
      // single relation: biarkan string apa adanya
    } else if (field.type === 'file' && typeof value === 'string') {
      // M14: multi-file disimpan sebagai JSON array → parse kembali
      const isMulti = (field.options?.maxSelect ?? 1) > 1;
      if (isMulti) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          result[key] = [];
        }
      }
    } else if (field.type === 'geoPoint' && typeof value === 'string') {
      // M16b: { lat, lng } TEXT JSON → object
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = null;
      }
    } else if (field.type === 'vector' && typeof value === 'string') {
      // M29: embedding TEXT JSON → array of numbers
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = null;
      }
    } else if (field.type === 'password') {
      // M16b: HASH TIDAK PERNAH DIKEMBALIKAN — field hilang dari response.
      // (Bagi client: field ini write-only. Tidak ada verify endpoint untuk
      // field-level password di M16b — kebutuhan verify = auth collection.)
      delete result[key];
    }
  }

  if (meta.type === 'auth') {
    delete result.password_hash;
  }

  return result as ForgeRecord;
}
