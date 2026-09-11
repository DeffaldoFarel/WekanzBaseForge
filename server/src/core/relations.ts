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
// D6: expand bertingkat ('a.b.c') diproses rekursif — setiap LEVEL tetap
// batch loading sendiri, jadi tidak ada N+1 berlapis.
//
// @param db        — koneksi database
// @param records   — daftar record yang mau di-expand
// @param meta      — skema collection dari record-record ini
// @param expandSpec— string seperti 'user' atau 'author.profile'
// @param counter   — opsional, untuk menghitung query (test)
// @param depth     — internal: kedalaman rekursi saat ini

// D6: batasi kedalaman expand untuk mencegah rekursi tak terkendali
// (misal 'a.b.c.d.e.f...' tanpa henti — bisa dari relasi sirkular).
const MAX_EXPAND_DEPTH = 5;

export function expandRecords(
  db: DatabaseSync,
  records: ForgeRecord[],
  meta: CollectionMeta,
  expandSpec: string,
  counter?: QueryCounter,
  depth: number = 0
): ForgeRecord[] {
  if (!expandSpec || records.length === 0) return records;

  // D6: batasi kedalaman
  if (depth >= MAX_EXPAND_DEPTH) {
    return records;
  }

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

  // 3. Petakan kembali — pasangkan setiap record dengan relasinya.
  //
  // D6 PENTING: untuk nested expand, kita harus mengumpulkan SEMUA target
  // level ini DULU, lalu expand sekali untuk semuanya (batch), BUKAN
  // expand per target (yang akan jadi N+1 di level berikutnya!).

  // Kumpulkan semua target level ini (dengan referensi pemiliknya)
  const allTargets: ForgeRecord[] = [];
  for (const rec of records) {
    const refValue = rec[head];
    if (isMulti) {
      for (const item of toIdArray(refValue)) {
        const t = targetById.get(item);
        if (t) allTargets.push(t as ForgeRecord);
      }
    } else {
      const t = typeof refValue === 'string' ? targetById.get(refValue) : undefined;
      if (t) allTargets.push(t as ForgeRecord);
    }
  }

  // Expand SEMUA target level ini SEKALIGUS (satu batch) untuk level berikutnya
  let nestedById = new Map<string, ForgeRecord>();
  if (restSpec && allTargets.length > 0) {
    const nestedExpanded = expandRecords(db, allTargets, targetMeta, restSpec, counter, depth + 1);
    for (const n of nestedExpanded) {
      nestedById.set(n.id, n);
    }
  }

  // Fungsi untuk mengambil target (dengan nested expand kalau ada)
  function resolveTarget(id: string): ForgeRecord | undefined {
    const base = targetById.get(id);
    if (!base) return undefined;
    if (restSpec) {
      return nestedById.get(id) ?? (base as ForgeRecord);
    }
    return base as ForgeRecord;
  }

  const expanded = records.map((rec) => {
    const refValue = rec[head];
    const existingExpand = (rec.expand as Record<string, unknown>) ?? {};
    const newExpand: Record<string, unknown> = { ...existingExpand };

    if (isMulti) {
      // Multi: hasilkan ARRAY of objects
      const ids = toIdArray(refValue);
      newExpand[head] = ids
        .map((item) => resolveTarget(item))
        .filter((t): t is ForgeRecord => t !== undefined);
    } else {
      // Single: hasilkan satu object
      if (typeof refValue === 'string') {
        const target = resolveTarget(refValue);
        if (target) {
          newExpand[head] = target;
        }
      }
    }

    return { ...rec, expand: newExpand } as ForgeRecord;
  });

  return expanded;
}
