/**
 * Ops-5: Reset password admin platform — fungsi inti yang dipakai CLI dan test.
 *
 * Kenapa terpisah: CLI (`src/cli/index.ts`) dan test membutuhkan logika yang
 * sama, tetapi spawn CLI dari test tidak andal di Windows (env tidak
 * diteruskan). Mengekstrak fungsi inti ke sini membuat keduanya berbagi
 * satu sumber kebenaran.
 */

import { initPlatformDb, getPlatformDb } from '../core/platformDb.js';
import { hashPassword, validatePasswordStrength } from '../auth/password.js';

export interface ResetAdminPasswordResult {
  ok: boolean;
  error?: string;
}

/**
 * Reset password admin yang sudah ada di `_platform_admins`.
 *
 * Tidak membuat admin baru — hanya mengubah password yang sudah ada.
 * Recovery offline: bekerja saat server mati, tanpa butuh token.
 */
export function resetAdminPassword(email: string, newPassword: string): ResetAdminPasswordResult {
  const strengthErr = validatePasswordStrength(newPassword);
  if (strengthErr !== null) {
    return { ok: false, error: `Password lemah: ${strengthErr}` };
  }

  initPlatformDb();
  const db = getPlatformDb();

  const row = db
    .prepare('SELECT id, email FROM _platform_admins WHERE lower(email) = ?')
    .get(email.toLowerCase()) as { id: string; email: string } | undefined;

  if (!row) {
    return { ok: false, error: `Admin '${email}' tidak ditemukan di _platform_admins.` };
  }

  const hash = hashPassword(newPassword);
  db.prepare(
    "UPDATE _platform_admins SET password_hash = ?, updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(hash, row.id);

  return { ok: true };
}
