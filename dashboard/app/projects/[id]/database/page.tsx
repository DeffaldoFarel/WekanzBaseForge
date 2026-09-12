"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  listCollections,
  createCollection,
  type CollectionInfo,
  type FieldDef,
} from "@/lib/api";

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
  "file",
  "editor",
  "geoPoint",
  "password",
];

export default function DatabaseIndexPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Modal new collection
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newFields, setNewFields] = useState<FieldDef[]>([
    { name: "title", type: "text", required: true },
  ]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    listCollections(projectId)
      .then((cols) => {
        setCollections(cols);
        // Jika sudah ada collection, otomatis redirect ke collection pertama ala studio!
        if (cols.length > 0) {
          router.replace(`/projects/${projectId}/database/${encodeURIComponent(cols[0].name)}`);
        } else {
          setLoading(false);
        }
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Gagal memuat database");
        setLoading(false);
      });
  }, [projectId, router]);

  async function handleCreate() {
    setSubmitting(true);
    setError("");
    try {
      const fields = newFields.filter((f) => f.name.trim().length > 0);
      const created = await createCollection(projectId, {
        name: newName.trim(),
        fields,
      });
      router.push(`/projects/${projectId}/database/${encodeURIComponent(created.name)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal membuat collection");
      setSubmitting(false);
    }
  }

  function addFieldRow() {
    setNewFields([...newFields, { name: "", type: "text", required: false }]);
  }

  function removeFieldRow(i: number) {
    setNewFields(newFields.filter((_, idx) => idx !== i));
  }

  function updateFieldRow(i: number, patch: Partial<FieldDef>) {
    setNewFields(newFields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }

  if (loading) {
    return (
      <div className="page" style={{ textAlign: "center", paddingTop: "4rem" }}>
        <p className="muted">Memuat database studio…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <Link href={`/projects/${projectId}`} className="nav-back">
        ← Kembali ke project
      </Link>

      <div className="header-row">
        <div>
          <h1 style={{ fontSize: "1.5rem" }}>Database Studio</h1>
          <p className="muted" style={{ fontSize: "0.9rem", marginTop: "0.25rem" }}>
            Kelola collections dan records — setara PocketBase Console.
          </p>
        </div>
        <button className="btn" onClick={() => setShowNew(true)}>
          + New Collection
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginTop: "1.5rem" }}>
        <div className="empty-state">
          <div className="big">📦</div>
          <h3 style={{ marginBottom: "0.5rem" }}>Belum ada collection di project ini</h3>
          <p className="muted" style={{ marginBottom: "1.25rem" }}>
            Buat collection pertama Anda untuk mulai menyimpan data.
          </p>
          <button className="btn" onClick={() => setShowNew(true)}>
            + Buat Collection Pertama
          </button>
        </div>
      </div>

      {/* Modal New Collection */}
      {showNew && (
        <div className="modal-overlay" onClick={() => setShowNew(false)}>
          <div className="modal-box-lg card" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
              <h3 style={{ margin: 0 }}>New Collection</h3>
              <button className="btn-icon" onClick={() => setShowNew(false)}>✕</button>
            </div>

            <div className="field">
              <label>Nama Collection</label>
              <input
                className="input"
                placeholder="misal: posts, products, habits"
                value={newName}
                onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                autoFocus
              />
              <span className="muted" style={{ fontSize: "0.78rem" }}>
                Hanya huruf kecil, angka, dan underscore.
              </span>
            </div>

            <div className="field" style={{ marginTop: "1.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <label style={{ margin: 0, fontWeight: 600 }}>Fields Skema ({newFields.length})</label>
                <button type="button" className="btn btn-secondary" onClick={addFieldRow} style={{ padding: "0.3rem 0.75rem", fontSize: "0.82rem" }}>
                  + Add Field
                </button>
              </div>

              {newFields.map((f, i) => (
                <div className="field-card" key={i}>
                  <div className="field-card-header">
                    <input
                      className="input"
                      placeholder="nama field (misal: title)"
                      value={f.name}
                      onChange={(e) => updateFieldRow(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}
                      style={{ flex: 2 }}
                    />
                    <select
                      className="input"
                      value={f.type}
                      onChange={(e) => updateFieldRow(i, { type: e.target.value })}
                      style={{ flex: 1.5 }}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>

                    <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.82rem", whiteSpace: "nowrap", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={!!f.required}
                        onChange={(e) => updateFieldRow(i, { required: e.target.checked })}
                      />
                      Req
                    </label>

                    <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.82rem", whiteSpace: "nowrap", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={!!f.unique}
                        onChange={(e) => updateFieldRow(i, { unique: e.target.checked })}
                      />
                      Unique
                    </label>

                    {newFields.length > 1 && (
                      <button type="button" className="btn-icon" onClick={() => removeFieldRow(i)} title="Hapus field">
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Field Specific Options */}
                  {f.type === "select" && (
                    <div className="field-card-options">
                      <label>Allowed Values (pisahkan dengan koma):</label>
                      <input
                        className="input"
                        placeholder="draft, published, archived"
                        value={f.options?.values?.join(", ") || ""}
                        onChange={(e) =>
                          updateFieldRow(i, {
                            options: {
                              ...f.options,
                              values: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                            },
                          })
                        }
                      />
                    </div>
                  )}

                  {f.type === "file" && (
                    <div className="field-card-options" style={{ display: "flex", gap: "1rem" }}>
                      <div style={{ flex: 1 }}>
                        <label>Max Files (maxSelect):</label>
                        <input
                          type="number"
                          className="input"
                          value={f.options?.maxSelect ?? 1}
                          onChange={(e) =>
                            updateFieldRow(i, {
                              options: { ...f.options, maxSelect: Number(e.target.value) || 1 },
                            })
                          }
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label>Max Size (MB):</label>
                        <input
                          type="number"
                          className="input"
                          value={(f.options?.maxSize ?? 5242880) / (1024 * 1024)}
                          onChange={(e) =>
                            updateFieldRow(i, {
                              options: { ...f.options, maxSize: (Number(e.target.value) || 5) * 1024 * 1024 },
                            })
                          }
                        />
                      </div>
                    </div>
                  )}

                  {f.type === "text" && (
                    <div className="field-card-options">
                      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={!!f.options?.fulltext}
                          onChange={(e) =>
                            updateFieldRow(i, {
                              options: { ...f.options, fulltext: e.target.checked },
                            })
                          }
                        />
                        <span>Aktifkan FTS5 Full-Text Search Index pada field ini</span>
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowNew(false)}>
                Batal
              </button>
              <button type="button" className="btn" onClick={handleCreate} disabled={submitting || !newName.trim()}>
                {submitting ? "Menyimpan…" : "Buat Collection"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
