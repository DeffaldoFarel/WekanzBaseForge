// ============================================================================
// M12: RELATIONS & EXPAND — menghubungkan record antar collection
//
// Inti dari file ini: menghindari N+1 problem dengan BATCH LOADING.
// Alih-alih mengambil relasi satu per satu (N query), kita mengumpulkan
// semua id dulu lalu mengambilnya SEKALIGUS dalam satu query IN (...).
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { getCollectionByName, CollectionMeta } from './schema.js';
import { FieldDefinition } from './fieldTypes.js';
import { ForgeRecord } from './records.js';

// ─── Query counter (untuk MEMBUKTIKAN N+1 vs batch di test) ─────────────────
// Kita membungkus penghitungan query supaya test bisa membuktikan bahwa
// batch loading benar-benar mengurangi jumlah query.

export class QueryCounter {
  count = 0;
  hit(): void {
    this.count++;
  }
  reset(): void {
    this.count = 0;
  }
}

// ─── Cari field relation dalam sebuah collection ────────────────────────────

export function getRelationFields(meta: CollectionMeta): FieldDefinition[] {
  return meta.fields.filter((f) => f.type === 'relation');
}

// ─── EXPAND — inti M12 ───────────────────────────────────────────────────────
//
// Untuk setiap record, tambahkan properti `expand` berisi data record
// yang dirujuk oleh field relation-nya.
//
// PENTING: ini dilakukan dengan BATCH LOADING, bukan N+1:
//   1. Kumpulkan semua id yang dirujuk (dari semua record)
//   2. Satu query: SELECT * FROM users WHERE id IN (semua id tadi)
//   3. Petakan kembali ke record masing-masing
//
// @param db        — koneksi database
// @param records   — daftar record yang mau di-expand
// @param meta      — skema collection dari record-record ini
// @param expandSpec— string seperti 'user' atau 'author.profile'
// @param counter   — opsional, untuk menghitung query (test)
export function expandRecords(
  db: DatabaseSync,
  records: ForgeRecord[],
  meta: CollectionMeta,
  expandSpec: string,
  counter?: QueryCounter
): ForgeRecord[] {
  if (!expandSpec || records.length === 0) return records;

  // expandSpec bisa 'a.b.c' — kita proses level pertama dulu ('a'),
  // sisanya ('b.c') diproses rekursif pada record hasil expand.
  const [head, ...rest] = expandSpec.split('.');
  const restSpec = rest.join('.');

  // Cari field relation bernama `head` di skema
  const relationField = meta.fields.find((f) => f.name === head && f.type === 'relation');
  if (!relationField) {
    // Field bukan relation / tidak ada — abaikan (seperti PocketBase: expand
    // yang tidak valid tidak error, hanya diabaikan)
    return records;
  }

  const targetCollection = relationField.options?.collectionId;
  if (!targetCollection) return records;

  const targetMeta = getCollectionByName(db, targetCollection);
  if (!targetMeta) return records;

  // D2: apakah ini multi-relation (array of ids)?
  const isMulti = (relationField.options?.maxSelect ?? 1) > 1;

  // ── BATCH LOADING dimulai ──

  // 1. Kumpulkan semua id target yang dirujuk (unik)
  //    Untuk multi: id bisa tersebar di dalam ARRAY setiap record.
  //    Catatan: nilai bisa berupa array (sudah deserialize) ATAU string JSON
  //    (mentah dari SELECT langsung) — kita tangani keduanya.
  const referencedIds = new Set<string>();

  // Helper: normalisasi nilai multi menjadi array of strings
  function toIdArray(val: unknown): string[] {
    if (Array.isArray(val)) return val.filter((x): x is string => typeof x === 'string');
    if (typeof val === 'string' && val.startsWith('[')) {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
      } catch {
        return [];
      }
    }
    return [];
  }

  for (const rec of records) {
    const refValue = rec[head];
    if (isMulti) {
      for (const item of toIdArray(refValue)) {
        if (item.length > 0) referencedIds.add(item);
      }
    } else {
      if (typeof refValue === 'string' && refValue.length > 0) {
        referencedIds.add(refValue);
      }
    }
  }

  // 2. SATU query untuk mengambil SEMUA record target sekaligus
  const targetById = new Map<string, Record<string, unknown>>();
  if (referencedIds.size > 0) {
    const ids = [...referencedIds];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT * FROM "${targetCollection}" WHERE id IN (${placeholders})`)
      .all(...(ids as never[])) as Record<string, unknown>[];

    counter?.hit(); // hitung sebagai SATU query (bukan N!)

    for (const row of rows) {
      targetById.set(row.id as string, row);
    }
  }

  // 3. Petakan kembali — pasangkan setiap record dengan relasinya
  const expanded = records.map((rec) => {
    const refValue = rec[head];
    const existingExpand = (rec.expand as Record<string, unknown>) ?? {};
    const newExpand: Record<string, unknown> = { ...existingExpand };

    if (isMulti) {
      // Multi: hasilkan ARRAY of objects
      const ids = toIdArray(refValue);
      const targets = ids
        .map((item) => targetById.get(item))
        .filter((t): t is Record<string, unknown> => t !== undefined);

      newExpand[head] = targets.map((t) => {
        if (restSpec) {
          const nested = expandRecords(db, [t as ForgeRecord], targetMeta, restSpec, counter);
          return nested[0];
        }
        return t;
      });
    } else {
      // Single: hasilkan satu object (seperti M12)
      const target = typeof refValue === 'string' ? targetById.get(refValue) : undefined;
      if (target) {
        if (restSpec) {
          const nested = expandRecords(db, [target as ForgeRecord], targetMeta, restSpec, counter);
          newExpand[head] = nested[0];
        } else {
          newExpand[head] = target;
        }
      }
    }

    return { ...rec, expand: newExpand } as ForgeRecord;
  });

  return expanded;
}
