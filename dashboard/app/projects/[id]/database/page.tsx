"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  listCollections,
  createCollection,
  deleteCollection,
  type CollectionInfo,
  type FieldDef,
} from "../../../../lib/api";

const FIELD_TYPES = [
  "text",
  "number",
  "bool",
  "email",
  "date",
  "json",
  "relation",
  "select",
  "url",
  "autodate",
  "file", // M14: file upload
];

export default function DatabasePage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);

  // Form state untuk collection baru
  const [newName, setNewName] = useState("");
  const [newFields, setNewFields] = useState<FieldDef[]>([
    { name: "", type: "text", required: false },
  ]);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    try {
      setLoading(true);
      const data = await listCollections(projectId);
      setCollections(data);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memuat");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function addFieldRow() {
    setNewFields([...newFields, { name: "", type: "text", required: false }]);
  }

  function removeFieldRow(i: number) {
    setNewFields(newFields.filter((_, idx) => idx !== i));
  }

  function updateFieldRow(i: number, patch: Partial<FieldDef>) {
    setNewFields(newFields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }

  async function handleCreate() {
    setSubmitting(true);
    setError("");
    try {
      const fields = newFields.filter((f) => f.name.trim().length > 0);
      await createCollection(projectId, { name: newName.trim(), fields });
      setShowNew(false);
      setNewName("");
      setNewFields([{ name: "", type: "text", required: false }]);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal membuat collection");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Hapus collection "${name}" beserta semua datanya?`)) return;
    try {
      await deleteCollection(projectId, name);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menghapus");
    }
  }

  return (
    <div className="page">
      <Link href={`/projects/${projectId}`} className="nav-back">
        ← Kembali ke project
      </Link>

      <div className="header-row">
        <div>
          <h1 style={{ fontSize: "1.5rem" }}>Database</h1>
          <p className="muted" style={{ fontSize: "0.9rem", marginTop: "0.25rem" }}>
            Kelola collections dan records — seperti PocketBase Admin.
          </p>
        </div>
        <button className="btn" onClick={() => setShowNew(true)}>
          + New Collection
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginTop: "1rem" }}>
        {loading ? (
          <p className="muted">Memuat collections…</p>
        ) : collections.length === 0 ? (
          <div className="empty-state">
            <div className="big">📦</div>
            <p>Belum ada collection. Buat yang pertama!</p>
          </div>
        ) : (
          collections.map((c) => (
            <div className="collection-item" key={c.name}>
              <div className="info">
                <div className="name">📦 {c.name}</div>
                <div className="meta">
                  {c.fields.length} fields · {c.recordCount ?? 0} records
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <Link
                  href={`/projects/${projectId}/database/${c.name}`}
                  className="btn btn-secondary"
                >
                  Buka →
                </Link>
                <button className="btn btn-danger" onClick={() => handleDelete(c.name)}>
                  Hapus
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal: New Collection */}
      {showNew && (
        <div className="modal-overlay" onClick={() => setShowNew(false)}>
          <div className="modal-box card" onClick={(e) => e.stopPropagation()}>
            <h3>New Collection</h3>

            <div className="field">
              <label>Nama collection</label>
              <input
                className="input"
                placeholder="misal: habits"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>

            <div className="field">
              <label>Fields</label>
              {newFields.map((f, i) => (
                <div className="field-row" key={i}>
                  <input
                    className="input"
                    placeholder="nama field"
                    value={f.name}
                    onChange={(e) => updateFieldRow(i, { name: e.target.value })}
                  />
                  <select
                    className="input"
                    value={f.type}
                    onChange={(e) => updateFieldRow(i, { type: e.target.value })}
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                    <input
                      type="checkbox"
                      checked={!!f.required}
                      onChange={(e) => updateFieldRow(i, { required: e.target.checked })}
                    />
                    req
                  </label>
                  <button className="btn-icon" onClick={() => removeFieldRow(i)}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn btn-secondary" onClick={addFieldRow} style={{ marginTop: "0.25rem" }}>
                + Field
              </button>
            </div>

            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setShowNew(false)}>
                Batal
              </button>
              <button className="btn" onClick={handleCreate} disabled={submitting || !newName.trim()}>
                {submitting ? "Membuat…" : "Buat Collection"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
