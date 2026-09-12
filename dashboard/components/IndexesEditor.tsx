"use client";

import React from "react";
import type { IndexDef, FieldDef } from "@/lib/api";

interface IndexesEditorProps {
  collectionName: string;
  indexes: IndexDef[];
  fields: FieldDef[];
  onChange: (updated: IndexDef[]) => void;
}

export function IndexesEditor({
  collectionName,
  indexes,
  fields,
  onChange,
}: IndexesEditorProps) {
  const availableFieldNames = [
    ...fields.map((f) => f.name).filter(Boolean),
    "created",
    "updated",
  ];

  function handleAddIndex() {
    const firstField = availableFieldNames[0] || "created";
    const defaultName = `idx_${collectionName}_${firstField}`;
    onChange([
      ...indexes,
      {
        name: defaultName,
        fields: [firstField],
        unique: false,
      },
    ]);
  }

  function handleUpdateIndex(idx: number, patch: Partial<IndexDef>) {
    const updated = [...indexes];
    updated[idx] = { ...updated[idx], ...patch };
    onChange(updated);
  }

  function handleRemoveIndex(idx: number) {
    onChange(indexes.filter((_, i) => i !== idx));
  }

  return (
    <div style={{ marginTop: "1.5rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.75rem",
        }}
      >
        <div>
          <h4 style={{ margin: 0, fontSize: "1rem" }}>
            📇 Indexes & Unique Constraints ({indexes.length})
          </h4>
          <p className="muted" style={{ fontSize: "0.8rem", margin: "0.2rem 0 0" }}>
            Kelola Index pencarian & aturan Unique (Single maupun Composite multi-kolom).
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleAddIndex}
          style={{ fontSize: "0.8rem", padding: "0.35rem 0.75rem" }}
        >
          + New Index
        </button>
      </div>

      {indexes.length === 0 ? (
        <div
          style={{
            padding: "1rem",
            background: "var(--panel-2)",
            borderRadius: "8px",
            border: "1px dashed var(--border)",
            fontSize: "0.85rem",
            color: "var(--muted)",
            textAlign: "center",
          }}
        >
          Belum ada custom index. Tabel menggunakan primary key <code>id</code>. Klik <strong>+ New Index</strong> untuk membuat index atau aturan Unique constraint.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          {indexes.map((idx, i) => {
            const cols = idx.fields.map((f) => `"${f}"`).join(", ");
            const sqlPreview = `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX "${idx.name || "idx_name"}" ON "${collectionName}" (${cols || "..."});`;

            return (
              <div
                key={i}
                style={{
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  padding: "0.75rem 1rem",
                }}
              >
                <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                  {/* Name */}
                  <input
                    className="input"
                    placeholder="nama index (e.g. idx_email)"
                    value={idx.name}
                    onChange={(e) =>
                      handleUpdateIndex(i, {
                        name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""),
                      })
                    }
                    style={{ flex: 1.5, fontWeight: 600, fontSize: "0.85rem" }}
                  />

                  {/* Type (INDEX vs UNIQUE INDEX) */}
                  <select
                    className="input"
                    value={idx.unique ? "unique" : "index"}
                    onChange={(e) =>
                      handleUpdateIndex(i, { unique: e.target.value === "unique" })
                    }
                    style={{ flex: 1, fontSize: "0.85rem" }}
                  >
                    <option value="index">Index Biasa (B-Tree)</option>
                    <option value="unique">UNIQUE INDEX</option>
                  </select>

                  {/* Fields selector (multi or comma-separated) */}
                  <input
                    className="input"
                    placeholder="kolom (pisahkan koma jika composite)"
                    value={idx.fields.join(", ")}
                    onChange={(e) =>
                      handleUpdateIndex(i, {
                        fields: e.target.value
                          .split(",")
                          .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""))
                          .filter(Boolean),
                      })
                    }
                    style={{ flex: 1.8, fontSize: "0.85rem" }}
                  />

                  {/* Delete */}
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => handleRemoveIndex(i)}
                    title="Hapus Index"
                  >
                    ✕
                  </button>
                </div>

                {/* Live SQL Preview */}
                <div
                  style={{
                    marginTop: "0.5rem",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "0.76rem",
                  }}
                >
                  <code style={{ color: idx.unique ? "var(--accent)" : "var(--muted)" }}>
                    {sqlPreview}
                  </code>
                  {idx.unique && (
                    <span
                      className="badge badge-accent"
                      style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }}
                    >
                      Enforces Uniqueness
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
