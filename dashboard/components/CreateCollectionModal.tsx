"use client";

import React, { useState } from "react";
import {
  createCollection,
  type CollectionInfo,
  type FieldDef,
  type IndexDef,
  type CollectionRules as Rules,
} from "@/lib/api";
import { FieldOptionsEditor } from "@/components/FieldOptionsEditor";
import { IndexesEditor } from "@/components/IndexesEditor";

interface CreateCollectionModalProps {
  projectId: string;
  existingCollections: CollectionInfo[];
  onClose: () => void;
  onCreated: (col: CollectionInfo) => void;
}

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

const DEFAULT_RULES: Rules = {
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
};

export function CreateCollectionModal({
  projectId,
  existingCollections,
  onClose,
  onCreated,
}: CreateCollectionModalProps) {
  const [name, setName] = useState("");
  const [colType, setColType] = useState<"base" | "view">("base");
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);
  const [activeTab, setActiveTab] = useState<"fields" | "rules">("fields");

  // Base Collection State
  const [fields, setFields] = useState<FieldDef[]>([
    { name: "title", type: "text", required: true },
  ]);
  const [indexes, setIndexes] = useState<IndexDef[]>([]);

  // View Collection State
  const [viewQuery, setViewQuery] = useState("");

  // Rules State
  const [rules, setRules] = useState<Rules>({ ...DEFAULT_RULES });

  // Status
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Nama collection wajib diisi");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      if (colType === "view") {
        if (!viewQuery.trim()) {
          throw new Error("Kueri SQL SELECT wajib diisi untuk View collection");
        }
        const created = await createCollection(projectId, {
          name: name.trim().toLowerCase(),
          type: "view",
          viewQuery: viewQuery.trim(),
          rules: {
            listRule: rules.listRule,
            viewRule: rules.viewRule,
          },
        });
        onCreated(created);
      } else {
        const validFields = fields.filter((f) => f.name.trim().length > 0);
        if (validFields.length === 0) {
          throw new Error("Minimal tambahkan 1 field kustom untuk Base collection");
        }
        const created = await createCollection(projectId, {
          name: name.trim().toLowerCase(),
          type: "base",
          fields: validFields,
          indexes: indexes.length > 0 ? indexes : undefined,
          rules,
        });
        onCreated(created);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membuat collection");
      setSubmitting(false);
    }
  }

  function handleAddField() {
    setFields([
      ...fields,
      { name: "", type: "text", required: false },
    ]);
  }

  function handleRemoveField(idx: number) {
    setFields(fields.filter((_, i) => i !== idx));
  }

  function handleUpdateField(idx: number, patch: Partial<FieldDef>) {
    const updated = [...fields];
    updated[idx] = { ...updated[idx], ...patch };
    setFields(updated);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box-lg card"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "800px", padding: "1.75rem" }}
      >
        {/* Modal Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1.25rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span style={{ fontSize: "1.4rem" }}>
              {colType === "base" ? "📦" : "👁️"}
            </span>
            <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 700 }}>
              Create collection
            </h3>
          </div>
          <button className="btn-icon" onClick={onClose} title="Tutup">
            ✕
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: "0.75rem 1rem",
              background: "rgba(239, 68, 68, 0.15)",
              border: "1px solid var(--red)",
              borderRadius: "8px",
              color: "var(--red)",
              fontSize: "0.85rem",
              marginBottom: "1rem",
            }}
          >
            ⚠️ {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Top Bar: Name & Type Dropdown (PocketBase Style) */}
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              alignItems: "flex-end",
              marginBottom: "1.25rem",
            }}
          >
            {/* Name Input */}
            <div style={{ flex: 1 }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  marginBottom: "0.35rem",
                }}
              >
                Name <span style={{ color: "var(--red)" }}>*</span>
              </label>
              <input
                className="input"
                placeholder={colType === "base" ? "e.g. posts, orders, articles" : "e.g. posts_summary, active_users"}
                value={name}
                onChange={(e) =>
                  setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))
                }
                autoFocus
                required
                style={{ fontSize: "0.95rem", fontWeight: 600 }}
              />
            </div>

            {/* PocketBase-style Type Selector Dropdown */}
            <div style={{ position: "relative" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  marginBottom: "0.35rem",
                }}
              >
                Type
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowTypeDropdown(!showTypeDropdown)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.55rem 0.9rem",
                  fontSize: "0.88rem",
                  fontWeight: 600,
                }}
              >
                <span>{colType === "base" ? "📦 Base" : "👁️ View"}</span>
                <span style={{ fontSize: "0.75rem" }}>▾</span>
              </button>

              {showTypeDropdown && (
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "100%",
                    marginTop: "0.4rem",
                    width: "280px",
                    background: "var(--panel-2)",
                    border: "1px solid var(--border)",
                    borderRadius: "10px",
                    boxShadow: "0 10px 25px rgba(0,0,0,0.5)",
                    zIndex: 100,
                    overflow: "hidden",
                    padding: "0.4rem",
                  }}
                >
                  {/* Option 1: Base collection */}
                  <div
                    onClick={() => {
                      setColType("base");
                      setShowTypeDropdown(false);
                    }}
                    style={{
                      padding: "0.6rem 0.75rem",
                      borderRadius: "6px",
                      cursor: "pointer",
                      background: colType === "base" ? "rgba(249, 115, 22, 0.15)" : "transparent",
                      border: colType === "base" ? "1px solid rgba(249, 115, 22, 0.3)" : "1px solid transparent",
                      marginBottom: "0.3rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, fontSize: "0.88rem", color: colType === "base" ? "var(--accent)" : "var(--text)" }}>
                      <span>📦</span> Base collection
                    </div>
                    <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.2rem" }}>
                      Tabel penyimpanan standar dengan operasi penuh CRUD.
                    </div>
                  </div>

                  {/* Option 2: View collection */}
                  <div
                    onClick={() => {
                      setColType("view");
                      setShowTypeDropdown(false);
                    }}
                    style={{
                      padding: "0.6rem 0.75rem",
                      borderRadius: "6px",
                      cursor: "pointer",
                      background: colType === "view" ? "rgba(249, 115, 22, 0.15)" : "transparent",
                      border: colType === "view" ? "1px solid rgba(249, 115, 22, 0.3)" : "1px solid transparent",
                      marginBottom: "0.3rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, fontSize: "0.88rem", color: colType === "view" ? "var(--accent)" : "var(--text)" }}>
                      <span>👁️</span> View collection
                    </div>
                    <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.2rem" }}>
                      Koleksi read-only hasil query SQL SELECT (agregasi & join).
                    </div>
                  </div>

                  {/* Option 3: Auth collection (Disabled / Coming soon info) */}
                  <div
                    style={{
                      padding: "0.6rem 0.75rem",
                      borderRadius: "6px",
                      opacity: 0.6,
                      cursor: "not-allowed",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 600, fontSize: "0.88rem" }}>
                      <span>👤</span> Auth collection
                      <span className="badge badge-gray" style={{ fontSize: "0.65rem", padding: "0.1rem 0.35rem" }}>Tersedia di Menu Auth</span>
                    </div>
                    <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.2rem" }}>
                      Akun end-user dikelola terpusat di menu Auth project.
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* PocketBase Configuration Tabs */}
          <div className="studio-tabs" style={{ marginBottom: "1rem" }}>
            <button
              type="button"
              className={`studio-tab ${activeTab === "fields" ? "active" : ""}`}
              onClick={() => setActiveTab("fields")}
            >
              {colType === "base" ? `Fields (${fields.length})` : "SQL Query"}
            </button>
            <button
              type="button"
              className={`studio-tab ${activeTab === "rules" ? "active" : ""}`}
              onClick={() => setActiveTab("rules")}
            >
              API Rules 🔒
            </button>
          </div>

          {/* TAB 1: FIELDS (BASE) or SQL QUERY (VIEW) */}
          {activeTab === "fields" && (
            <div>
              {colType === "base" ? (
                <div>
                  {/* PocketBase-style System Fields Bar */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.6rem",
                      padding: "0.55rem 0.85rem",
                      background: "rgba(255, 255, 255, 0.03)",
                      borderRadius: "8px",
                      border: "1px dashed var(--border)",
                      fontSize: "0.8rem",
                      color: "var(--muted)",
                      marginBottom: "0.75rem",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>System Fields (Otomatis):</span>
                    <span className="badge badge-gray">T id (15 char PK)</span>
                    <span className="badge badge-gray">📅 created (ISO)</span>
                    <span className="badge badge-gray">📅 updated (ISO)</span>
                  </div>

                  {/* Custom Fields List */}
                  <div style={{ display: "grid", gap: "0.6rem" }}>
                    {fields.map((f, i) => (
                      <div className="field-card" key={i} style={{ background: "var(--panel-2)" }}>
                        <div className="field-card-header">
                          <input
                            className="input"
                            placeholder="nama field (e.g. title, price)"
                            value={f.name}
                            onChange={(e) =>
                              handleUpdateField(i, {
                                name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""),
                              })
                            }
                            style={{ flex: 2, fontWeight: 600 }}
                            required
                          />
                          <select
                            className="input"
                            value={f.type}
                            onChange={(e) => handleUpdateField(i, { type: e.target.value })}
                            style={{ flex: 1.5 }}
                          >
                            {FIELD_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.3rem",
                              fontSize: "0.82rem",
                              whiteSpace: "nowrap",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={!!f.required}
                              onChange={(e) => handleUpdateField(i, { required: e.target.checked })}
                            />
                            Req
                          </label>
                          {fields.length > 1 && (
                            <button
                              type="button"
                              className="btn-icon"
                              onClick={() => handleRemoveField(i)}
                              title="Hapus field"
                            >
                              ✕
                            </button>
                          )}
                        </div>

                        {/* Per-Type Field Specific Settings */}
                        <FieldOptionsEditor
                          field={f}
                          allCollections={existingCollections}
                          onChange={(patch) => handleUpdateField(i, patch)}
                        />
                      </div>
                    ))}
                  </div>

                  <div style={{ marginTop: "0.75rem" }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleAddField}
                      style={{ fontSize: "0.85rem", padding: "0.4rem 0.8rem" }}
                    >
                      + Add Field
                    </button>
                  </div>

                  {/* Indexes & Unique Constraints Manager */}
                  <IndexesEditor
                    collectionName={name || "collection"}
                    indexes={indexes}
                    fields={fields}
                    onChange={setIndexes}
                  />
                </div>
              ) : (
                /* VIEW COLLECTION SQL QUERY EDITOR */
                <div style={{ background: "var(--panel-2)", padding: "1.25rem", borderRadius: "10px", border: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                    <label style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                      SQL SELECT Query <span style={{ color: "var(--red)" }}>*</span>
                    </label>
                    <span className="badge badge-purple" style={{ fontSize: "0.72rem" }}>
                      Read-only View
                    </span>
                  </div>
                  <textarea
                    className="input"
                    rows={6}
                    placeholder={`SELECT\n  h.id,\n  h.title,\n  h.created,\n  h.updated,\n  COUNT(*) AS total_items\nFROM habits h\nGROUP BY h.id`}
                    value={viewQuery}
                    onChange={(e) => setViewQuery(e.target.value)}
                    required
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: "0.85rem",
                      lineHeight: "1.4",
                    }}
                  />
                  <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.5rem", lineHeight: "1.4" }}>
                    💡 <strong>Tips View Collection:</strong>
                    <br />
                    • Kueri wajib dimulai dengan <code>SELECT</code> dan menyertakan kolom unik <code>id</code>.
                    <br />
                    • Skema kolom akan diekstrak secara dinamis oleh engine BaseForge.
                    <br />
                    • View bersifat murni read-only (operasi Create, Update, dan Delete akan ditolak otomatis).
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: API RULES */}
          {activeTab === "rules" && (
            <div style={{ display: "grid", gap: "0.8rem" }}>
              <div className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.3rem" }}>
                Atur kontrol akses ke API collection ini. Kosongkan / klik <code>🔒 Kunci</code> untuk akses Admin Only, atau klik <code>🌐 Publik</code> untuk akses tanpa otentikasi.
              </div>

              {[
                { key: "listRule", label: "List/Search Rule", desc: "Akses GET list records" },
                { key: "viewRule", label: "View Rule", desc: "Akses GET satu record by ID" },
                ...(colType === "base"
                  ? [
                      { key: "createRule", label: "Create Rule", desc: "Akses POST record baru" },
                      { key: "updateRule", label: "Update Rule", desc: "Akses PATCH/PUT edit record" },
                      { key: "deleteRule", label: "Delete Rule", desc: "Akses DELETE hapus record" },
                    ]
                  : []),
              ].map(({ key, label, desc }) => {
                const ruleKey = key as keyof Rules;
                const val = rules[ruleKey];

                return (
                  <div
                    key={key}
                    style={{
                      background: "var(--panel-2)",
                      border: "1px solid var(--border)",
                      borderRadius: "8px",
                      padding: "0.75rem 1rem",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{label}</span>
                        <span className="muted" style={{ fontSize: "0.75rem", marginLeft: "0.5rem" }}>
                          ({desc})
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "0.3rem" }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: "0.15rem 0.45rem", fontSize: "0.72rem" }}
                          onClick={() => setRules({ ...rules, [ruleKey]: null })}
                        >
                          🔒 Kunci (null)
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: "0.15rem 0.45rem", fontSize: "0.72rem" }}
                          onClick={() => setRules({ ...rules, [ruleKey]: "" })}
                        >
                          🌐 Publik ("")
                        </button>
                      </div>
                    </div>

                    <input
                      className="input"
                      style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.82rem" }}
                      placeholder="null (admin only), atau ekspresi: user = @request.auth.id"
                      value={val === null ? "" : val}
                      onChange={(e) =>
                        setRules({
                          ...rules,
                          [ruleKey]: e.target.value === "" ? "" : e.target.value,
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* Form Actions */}
          <div className="form-actions" style={{ marginTop: "1.75rem" }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Batal
            </button>
            <button type="submit" className="btn" disabled={submitting || !name.trim()}>
              {submitting ? "Membuat Collection…" : `Buat ${colType === "view" ? "View" : "Collection"}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
