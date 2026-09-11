// ============================================================================
// M01: KV STORE — database paling primitif, dibangun dari nol
//
// ATURAN MAIN (disengaja):
//  ❌ Tanpa SQLite
//  ❌ Tanpa library database
//  ✅ Hanya Map (memori) + 1 file JSON (disk)
//
// Kode ini SENGAJA memiliki "cacat desain" — jangan diperbaiki dulu!
// Setiap cacat adalah pelajaran yang akan kita rasakan di eksperimen:
//   CACAT #1: Seluruh data dimuat ke memori → tidak bisa lebih besar dari RAM
//   CACAT #2: Setiap perubahan menulis ulang SELURUH file → O(total data)
//   CACAT #3: Penulisan file tidak atomik → crash di tengah = file corrupt
//   CACAT #4: Pencarian harus baca semua → tanpa index
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

export class KVStore {
  // Map = struktur data hash table bawaan JS.
  // Inilah "database di memori" kita — pencarian O(1), sangat cepat,
  // tapi HILANG saat proses berhenti (volatile).
  private data: Map<string, unknown> = new Map();

  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  // ─── LOAD: disk → memori ─────────────────────────────────────────────────
  // Saat server start, seluruh file dibaca dan dimasukkan ke Map.
  // Perhatikan: ini berarti WAKTU START sebanding dengan UKURAN data.
  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      // Belum ada file = database kosong. Normal untuk pertama kali.
      return;
    }

    try {
      const text = fs.readFileSync(this.filePath, 'utf-8');
      const obj = JSON.parse(text) as Record<string, unknown>;

      for (const [key, value] of Object.entries(obj)) {
        this.data.set(key, value);
      }
    } catch (err) {
      // ⬇️ EKSPERIMEN 3 akan memicu cabang ini!
      // Apa yang terjadi kalau file-nya setengah tertulis / bukan JSON valid?
      throw new Error(
        `KVStore: file database CORRUPT di ${this.filePath} — ` +
          `tidak bisa di-parse sebagai JSON. ` +
          `Inilah kenapa database sungguhan tidak menyimpan data sebagai JSON polos! ` +
          `Detail: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // ─── PERSIST: memori → disk ──────────────────────────────────────────────
  // Dipanggil SETIAP ada perubahan (set/delete).
  //
  // ⬇️ CACAT TERBESAR ADA DI SINI ⬇️
  // Kita menulis ulang SELURUH database untuk SATU perubahan kecil.
  // Simpan 1 byte → tulis ulang 1 juta byte. EKSPERIMEN 2 akan
  // menunjukkan betapa lambatnya ini saat data membesar.
  private persist(): void {
    // Map tidak bisa di-JSON.stringify langsung — konversi ke object dulu
    const obj: Record<string, unknown> = {};
    for (const [key, value] of this.data.entries()) {
      obj[key] = value;
    }

    const text = JSON.stringify(obj, null, 2);

    // Pastikan folder ada
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    // TULIS LANGSUNG — tidak atomik!
    // Kalau proses mati di tengah penulisan ini → file setengah jadi → corrupt.
    // Database sungguhan menulis ke file TEMPORER lalu rename (atomik),
    // atau menulis ke Write-Ahead Log (kita pelajari di M07).
    fs.writeFileSync(this.filePath, text, 'utf-8');
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────────

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    this.persist(); // ⬅️ setiap SET menulis ulang seluruh file!
  }

  async get(key: string): Promise<unknown> {
    return this.data.get(key);
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.data.delete(key);
    if (existed) {
      this.persist(); // ⬅️ setiap DELETE juga menulis ulang seluruh file!
    }
    return existed;
  }

  // Pencarian dengan prefix — satu-satunya "query" yang kita punya.
  // Perhatikan: kita harus memeriksa SETIAP key satu per satu.
  // Tidak ada cara lain — tidak ada index! (EKSPERIMEN 4)
  async keys(prefix = ''): Promise<string[]> {
    const result: string[] = [];
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) {
        result.push(key);
      }
    }
    return result;
  }

  async count(): Promise<number> {
    return this.data.size;
  }

  // Helper untuk eksperimen: mengosongkan database
  async clear(): Promise<void> {
    this.data.clear();
    this.persist();
  }

  // Helper untuk eksperimen 4: mencari value berdasarkan isi
  // (HARUS membaca semua value — inilah yang namanya "full scan")
  async findByValue(predicate: (value: unknown) => boolean): Promise<[string, unknown][]> {
    const result: [string, unknown][] = [];
    for (const [key, value] of this.data.entries()) {
      if (predicate(value)) {
        result.push([key, value]);
      }
    }
    return result;
  }
}
