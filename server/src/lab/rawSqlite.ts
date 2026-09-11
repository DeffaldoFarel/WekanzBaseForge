// ============================================================================
// M02: RAW SQLITE — menyentuh mesin database secara langsung
//
// Tidak ada ORM, tidak ada query builder — hanya SQL mentah yang kita tulis
// dengan tangan. Tujuannya: merasakan apa yang sebenarnya terjadi di balik
// semua abstraksi database yang pernah kita pakai.
//
// Bandingkan dengan kvStore.ts (M01): fungsinya sama (simpan/ambil/hapus),
// tapi perhatikan perbedaan cara berpikirnya:
//   M01: "key → value bebas"  vs  M02: "baris dengan kolom bertipe"
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// ─── Tipe record habits ──────────────────────────────────────────────────────
// Perhatikan: di M01 tidak ada yang namanya "tipe record" — semua value bebas.
// Di sini kita MENDEFINISIKAN bentuk data, dan SQLite akan menegakkannya.
export interface HabitRow {
  id: string;
  title: string;
  streak: number;
  created: string;
}

export class RawSqlite {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.createTables();
  }

  // ─── CREATE TABLE — SQL mentah, ditulis tangan ───────────────────────────
  // Di M03 kita akan meng-generate string seperti ini secara OTOMATIS dari
  // definisi collection. Untuk sekarang, rasakan dulu menulisnya manual.
  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS habits (
        id      TEXT PRIMARY KEY,
        title   TEXT NOT NULL,
        streak  INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    // Perhatikan CONSTRAINTS:
    //   PRIMARY KEY → id unik + otomatis ter-index
    //   NOT NULL    → title wajib diisi, SQLite menolak NULL
    //   INTEGER     → streak harus angka bulat
    //   DEFAULT 0   → kalau tidak diisi, otomatis 0
    // Di M01, TIDAK ADA satupun perlindungan seperti ini!
  }

  // ─── CREATE (INSERT) ─────────────────────────────────────────────────────
  // Prepared statement: SQL di-compile SEKALI oleh SQLite, lalu bisa
  // dipakai berulang kali dengan nilai berbeda. '?' adalah placeholder —
  // nilai yang mengisinya diperlakukan sebagai DATA murni, bukan SQL.
  insertHabit(id: string, title: string, streak: number): void {
    const stmt = this.db.prepare(
      'INSERT INTO habits (id, title, streak) VALUES (?, ?, ?)'
    );
    stmt.run(id, title, streak);
  }

  // ─── READ (SELECT) ───────────────────────────────────────────────────────
  getHabit(id: string): HabitRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM habits WHERE id = ?');
    return stmt.get(id) as unknown as HabitRow | undefined;
  }

  // ─── UPDATE ──────────────────────────────────────────────────────────────
  updateStreak(id: string, streak: number): boolean {
    const stmt = this.db.prepare('UPDATE habits SET streak = ? WHERE id = ?');
    const result = stmt.run(streak, id);
    return result.changes > 0; // berapa baris yang berubah?
  }

  // ─── DELETE ──────────────────────────────────────────────────────────────
  deleteHabit(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM habits WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ─── COUNT ───────────────────────────────────────────────────────────────
  countHabits(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) AS n FROM habits');
    const row = stmt.get() as unknown as { n: number };
    return row.n;
  }

  // ─── QUERY DENGAN KONDISI — di sinilah SQL mulai bersinar ────────────────
  // Di M01, untuk mencari "streak > 5" kita harus membaca SEMUA record.
  // Di sini, kita menyatakan MAUNYA (WHERE streak > 5) dan SQLite yang
  // mencari caranya — bahkan tanpa index, engine-nya jauh lebih efisien
  // daripada loop JavaScript kita.
  findHabitsByMinStreak(minStreak: number): HabitRow[] {
    const stmt = this.db.prepare(
      'SELECT * FROM habits WHERE streak > ? ORDER BY streak DESC'
    );
    return stmt.all(minStreak) as unknown as HabitRow[];
  }

  // ─── TRANSAKSI — pengubah permainan untuk bulk operations ────────────────
  // BEGIN ... COMMIT membungkus banyak operasi menjadi SATU unit atomik:
  //   1. Semua berhasil, atau tidak sama sekali (atomicity)
  //   2. Disk ditulis SEKALI di COMMIT, bukan setiap operasi (kecepatan!)
  //
  // Kita siapkan dua cara mengisi banyak data untuk dibuktikan bedanya.
  bulkInsertNoTransaction(rows: Array<{ id: string; title: string; streak: number }>): void {
    const stmt = this.db.prepare(
      'INSERT INTO habits (id, title, streak) VALUES (?, ?, ?)'
    );
    for (const row of rows) {
      stmt.run(row.id, row.title, row.streak);
      // Setiap run() = auto-commit terpisah = setidaknya satu kali
      // sinkronisasi disk. Inilah yang membuat M01 lambat!
    }
  }

  bulkInsertWithTransaction(rows: Array<{ id: string; title: string; streak: number }>): void {
    const stmt = this.db.prepare(
      'INSERT INTO habits (id, title, streak) VALUES (?, ?, ?)'
    );
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        stmt.run(row.id, row.title, row.streak);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      // Kalau ada yang gagal di tengah → SEMUA dibatalkan.
      // Tidak akan ada "setengah jadi" di database.
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Untuk keperluan test/reset
  clearHabits(): void {
    this.db.exec('DELETE FROM habits');
  }

  close(): void {
    this.db.close();
  }
}
