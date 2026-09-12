"use client";

// ============================================================================
// M10u: AUTH SERVICE PAGE — User Management untuk END USERS
//
// Dashboard admin bisa: lihat daftar user, tambah user, reset password,
// hapus user. Password tidak pernah ditampilkan (server tidak mengirimnya).
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  listAuthUsers,
  createAuthUser,
  changeAuthUserPassword,
  deleteAuthUser,
  AuthUser,
} from "@/lib/api";

export default function AuthServicePage() {
  const params = useParams();
  const projectId = params.id as string;

  const [users, setUsers] = useState<AuthUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // form tambah user
  const [showAdd, setShowAdd] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  // reset password inline
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await listAuthUsers(projectId, p);
        setUsers(res.items);
        setTotal(res.totalItems);
        setTotalPages(res.totalPages);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Gagal memuat users");
      } finally {
        setLoading(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    load(page);
  }, [load, page]);

  async function handleAdd() {
    setError(null);
    try {
      await createAuthUser(projectId, { email, password, name: name || undefined });
      setEmail("");
      setName("");
      setPassword("");
      setShowAdd(false);
      setNotice("User ditambahkan");
      load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menambah user");
    }
  }

  async function handleResetPassword(userId: string) {
    setError(null);
    try {
      await changeAuthUserPassword(projectId, userId, newPassword);
      setResettingId(null);
      setNewPassword("");
      setNotice("Password diperbarui");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal mengganti password");
    }
  }

  async function handleDelete(user: AuthUser) {
    if (!confirm(`Hapus user ${user.email}? Tindakan ini tidak bisa dibatalkan.`)) return;
    setError(null);
    try {
      await deleteAuthUser(projectId, user.id);
      setNotice("User dihapus");
      load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menghapus user");
    }
  }

  return (
    <div className="page">
      <Link href={`/projects/${projectId}`} className="nav-back">
        ← Kembali ke Project
      </Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2>
          Auth — Users <span className="muted" style={{ fontSize: "0.85rem" }}>({total})</span>
        </h2>
        <button className="btn btn-primary" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Tutup" : "+ User baru"}
        </button>
      </div>

      {notice && <div className="card" style={{ borderColor: "var(--success, #2e7d32)" }}>✅ {notice}</div>}
      {error && <div className="card" style={{ borderColor: "var(--danger, #c62828)" }}>⚠️ {error}</div>}

      {showAdd && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h3 style={{ marginBottom: "0.75rem" }}>Tambah user baru</h3>
          <div className="field-grid">
            <label>
              Email *
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="user@example.com" />
            </label>
            <label>
              Nama
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama (opsional)" />
            </label>
            <label>
              Password *
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="min. 8 karakter" />
            </label>
          </div>
          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
            <button className="btn btn-primary" onClick={handleAdd} disabled={!email || !password}>
              Simpan
            </button>
            <button className="btn" onClick={() => setShowAdd(false)}>
              Batal
            </button>
          </div>
          <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
            Password di-hash scrypt di server — tidak ada yang bisa melihatnya kembali.
          </p>
        </div>
      )}

      <div className="card" style={{ marginTop: "1rem", overflowX: "auto" }}>
        {loading ? (
          <p className="muted">Memuat…</p>
        ) : users.length === 0 ? (
          <p className="muted">
            Belum ada user. User mendaftar via <code>POST /api/p/{projectId}/auth/register</code> atau tambahkan manual di sini.
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Nama</th>
                <th>Dibuat</th>
                <th style={{ width: "40%" }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.email}
                    {u.verified && <span title="verified"> ✅</span>}
                  </td>
                  <td>{u.name ?? <span className="muted">—</span>}</td>
                  <td className="muted">{new Date(u.created).toLocaleDateString("id-ID")}</td>
                  <td>
                    {resettingId === u.id ? (
                      <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                        <input
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          type="password"
                          placeholder="password baru"
                          style={{ maxWidth: "160px" }}
                        />
                        <button className="btn btn-primary" onClick={() => handleResetPassword(u.id)} disabled={!newPassword}>
                          OK
                        </button>
                        <button className="btn" onClick={() => { setResettingId(null); setNewPassword(""); }}>
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: "0.4rem" }}>
                        <button className="btn" onClick={() => setResettingId(u.id)}>
                          Reset password
                        </button>
                        <button className="btn btn-danger" onClick={() => handleDelete(u)}>
                          Hapus
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {totalPages > 1 && (
          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              ← Sebelumnya
            </button>
            <span className="muted">
              {page} / {totalPages}
            </span>
            <button className="btn" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Berikutnya →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
