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
  const [colType, setColType] = useState<"base" | "view" | "auth">("base");
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);
  const [activeTab, setActiveTab] = useState<"fields" | "rules">("fields");

  // Base & Auth Collection State
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
        if (colType === "base" && validFields.length === 0) {
          throw new Error("Minimal tambahkan 1 field kustom untuk Base collection");
        }
        const created = await createCollection(projectId, {
          name: name.trim().toLowerCase(),
          type: colType,
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
                <span>{colType === "base" ? "📦 Base" : colType === "view" ? "👁️ View" : "👤 Auth"}</span>
                <span style={{ fontSize: "0.75rem" }}>▾</span>
              </button>

              {showTypeDropdown && (
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "100%",
                    marginTop: "0.4rem",
                    width: "300px",
                    background: "#FFFFFF",
                    border: "1px solid var(--border)",
                    borderRadius: "14px",
                    boxShadow: "var(--shadow-modal)",
                    zIndex: 100,
                    overflow: "hidden",
                    padding: "0.5rem",
                  }}
                >
                  {/* Option 1: Base collection */}
                  <div
                    onClick={() => {
                      setColType("base");
                      setShowTypeDropdown(false);
                    }}
                    style={{
                      padding: "0.65rem 0.85rem",
                      borderRadius: "10px",
                      cursor: "pointer",
                      background: colType === "base" ? "#0A0B0D" : "transparent",
                      color: colType === "base" ? "#FFFFFF" : "var(--text)",
                      marginBottom: "0.3rem",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 700, fontSize: "0.88rem" }}>
                      <span>📦</span> Base collection
                    </div>
                    <div style={{ fontSize: "0.75rem", marginTop: "0.2rem", color: colType === "base" ? "rgba(255,255,255,0.7)" : "var(--text-muted)" }}>
                      Standard data storage table with full CRUD operations.
                    </div>
                  </div>

                  {/* Option 2: View collection */}
                  <div
                    onClick={() => {
                      setColType("view");
                      setShowTypeDropdown(false);
                    }}
                    style={{
                      padding: "0.65rem 0.85rem",
                      borderRadius: "10px",
                      cursor: "pointer",
                      background: colType === "view" ? "#0A0B0D" : "transparent",
                      color: colType === "view" ? "#FFFFFF" : "var(--text)",
                      marginBottom: "0.3rem",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 700, fontSize: "0.88rem" }}>
                      <span>👁️</span> View collection
                    </div>
                    <div style={{ fontSize: "0.75rem", marginTop: "0.2rem", color: colType === "view" ? "rgba(255,255,255,0.7)" : "var(--text-muted)" }}>
                      Read-only collection populated by SQL SELECT query (aggregations & joins).
                    </div>
                  </div>

                  {/* Option 3: Auth collection */}
                  <div
                    onClick={() => {
                      setColType("auth");
                      setShowTypeDropdown(false);
                      if (fields.length === 1 && fields[0].name === "title") {
                        setFields([
                          { name: "name", type: "text" },
                          { name: "avatar", type: "file" },
                        ]);
                      }
                    }}
                    style={{
                      padding: "0.65rem 0.85rem",
                      borderRadius: "10px",
                      cursor: "pointer",
                      background: colType === "auth" ? "#0A0B0D" : "transparent",
                      color: colType === "auth" ? "#FFFFFF" : "var(--text)",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 700, fontSize: "0.88rem" }}>
                      <span>👤</span> Auth collection
                    </div>
                    <div style={{ fontSize: "0.75rem", marginTop: "0.2rem", color: colType === "auth" ? "rgba(255,255,255,0.7)" : "var(--text-muted)" }}>
                      User authentication collection with email & password login + profile custom fields.
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
              {colType === "view" ? "SQL Query" : `Fields (${fields.length})`}
            </button>
            <button
              type="button"
              className={`studio-tab ${activeTab === "rules" ? "active" : ""}`}
              onClick={() => setActiveTab("rules")}
            >
              API Rules 🔒
            </button>
          </div>

          {/* TAB 1: FIELDS (BASE / AUTH) or SQL QUERY (VIEW) */}
          {activeTab === "fields" && (
            <div>
              {colType !== "view" ? (
                <div>
                  {/* PocketBase-style System Fields Bar */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      padding: "0.55rem 0.85rem",
                      background: "#F1F5F9",
                      borderRadius: "10px",
                      border: "1px dashed var(--border)",
                      fontSize: "0.78rem",
                      color: "var(--muted)",
                      marginBottom: "0.75rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>System Fields (Automatic):</span>
                    <span className="badge badge-gray">T id (PK)</span>
                    {colType === "auth" && (
                      <>
                        <span className="badge badge-accent">✉️ email (unique)</span>
                        <span className="badge badge-accent">🔒 password</span>
                        <span className="badge badge-gray">✓ verified</span>
                      </>
                    )}
                    <span className="badge badge-gray">📅 created</span>
                    <span className="badge badge-gray">📅 updated</span>
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
                              title="Delete field"
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
                    💡 <strong>View Collection Tips:</strong>
                    <br />
                    • Query must start with <code>SELECT</code> and include a unique <code>id</code> column.
                    <br />
                    • Column schema will be dynamically inferred by the BaseForge query engine.
                    <br />
                    • Views are strictly read-only (mutations like Create, Update, and Delete are rejected).
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: API RULES */}
          {activeTab === "rules" && (
            <div style={{ display: "grid", gap: "0.8rem" }}>
              <div className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.3rem" }}>
                Configure access control rules for this collection. Leave empty / click <code>🔒 Lock</code> for Admin Only, or click <code>🌐 Public</code> for unauthenticated access.
              </div>

              {[
                { key: "listRule", label: "List/Search Rule", desc: "GET records list access" },
                { key: "viewRule", label: "View Rule", desc: "GET single record by ID access" },
                ...(colType === "base"
                  ? [
                      { key: "createRule", label: "Create Rule", desc: "POST new record access" },
                      { key: "updateRule", label: "Update Rule", desc: "PATCH/PUT edit record access" },
                      { key: "deleteRule", label: "Delete Rule", desc: "DELETE record access" },
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
                          🔒 Lock (null)
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: "0.15rem 0.45rem", fontSize: "0.72rem" }}
                          onClick={() => setRules({ ...rules, [ruleKey]: "" })}
                        >
                          🌐 Public (&quot;&quot;)
                        </button>
                      </div>
                    </div>

                    <input
                      className="input"
                      style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.82rem" }}
                      placeholder="null (admin only), or expression: user = @request.auth.id"
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
              Cancel
            </button>
            <button type="submit" className="btn" disabled={submitting || !name.trim()}>
              {submitting ? "Creating Collection…" : `Create ${colType === "view" ? "View" : "Collection"}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
