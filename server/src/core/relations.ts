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

  // ── BATCH LOADING dimulai ──

  // 1. Kumpulkan semua id target yang dirujuk (unik)
  const referencedIds = new Set<string>();
  for (const rec of records) {
    const refId = rec[head];
    if (typeof refId === 'string' && refId.length > 0) {
      referencedIds.add(refId);
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
    const refId = rec[head];
    const target = typeof refId === 'string' ? targetById.get(refId) : undefined;

    // Bangun properti expand
    const existingExpand = (rec.expand as Record<string, unknown>) ?? {};
    const newExpand: Record<string, unknown> = { ...existingExpand };

    if (target) {
      // Kalau ada expand bertingkat (restSpec), proses rekursif
      if (restSpec) {
        const nested = expandRecords(
          db,
          [target as ForgeRecord],
          targetMeta,
          restSpec,
          counter
        );
        newExpand[head] = nested[0];
      } else {
        newExpand[head] = target;
      }
    }

    return { ...rec, expand: newExpand } as ForgeRecord;
  });

  return expanded;
}
