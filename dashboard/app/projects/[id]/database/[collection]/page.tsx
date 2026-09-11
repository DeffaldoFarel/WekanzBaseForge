"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  listCollections,
  listRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  type CollectionInfo,
  type FieldDef,
  type ListResult,
} from "../../../../../lib/api";

export default function CollectionDataPage() {
  const params = useParams();
  const projectId = params.id as string;
  const collectionName = params.collection as string;

  const [collection, setCollection] = useState<CollectionInfo | null>(null);
  const [result, setResult] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);

  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [showNew, setShowNew] = useState(false);

  const loadCollection = useCallback(async () => {
    const cols = await listCollections(projectId);
    const found = cols.find((c) => c.name === collectionName);
    setCollection(found ?? null);
    return found;
  }, [projectId, collectionName]);

  const loadRecords = useCallback(async () => {
    const data = await listRecords(projectId, collectionName, {
      filter: filter || undefined,
      page,
      perPage: 10,
    });
    setResult(data);
  }, [projectId, collectionName, filter, page]);

  async function load() {
    try {
      setLoading(true);
      await loadCollection();
      await loadRecords();
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
  }, [projectId, collectionName, page]);

  async function applyFilter(e?: React.FormEvent) {
    e?.preventDefault();
    setPage(1);
    await loadRecords();
  }

  async function handleDeleteRecord(id: string) {
    if (!confirm("Hapus record ini?")) return;
    try {
      await deleteRecord(projectId, collectionName, id);
      await loadRecords();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menghapus");
    }
  }

  // Semua kolom yang ditampilkan: field user + sistem
  const allColumns = collection
    ? ["id", ...collection.fields.map((f) => f.name), "created"]
    : [];

  return (
    <div className="page">
      <Link href={`/projects/${projectId}/database`} className="nav-back">
        ← Kembali ke Database
      </Link>

      <div className="header-row">
        <div>
          <h1 style={{ fontSize: "1.5rem" }}>📦 {collectionName}</h1>
          <p className="muted" style={{ fontSize: "0.9rem", marginTop: "0.25rem" }}>
            {collection ? `${collection.fields.length} fields · ${result?.totalItems ?? 0} records` : "…"}
          </p>
        </div>
        <button className="btn" onClick={() => setShowNew(true)}>
          + New Record
        </button>
      </div>

      {/* Schema mini */}
      {collection && (
        <div className="card" style={{ marginTop: "0.5rem", padding: "0.75rem 1rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <span className="muted" style={{ fontSize: "0.8rem" }}>Fields:</span>
            {collection.fields.map((f) => (
              <span key={f.name} className="type-badge">
                {f.name}: {f.type}
                {f.required && <span className="req-badge"> *</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Filter bar (M04 parser bekerja di sini!) */}
      <form className="filter-bar" onSubmit={applyFilter}>
        <input
          className="input"
          placeholder='filter, misal: streak > 5 && title ~ "olah"'
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="submit" className="btn btn-secondary">
          Apply
        </button>
      </form>

      {error && <div className="error-text">{error}</div>}

      {/* Data table */}
      <div className="card" style={{ marginTop: "1rem" }}>
        {loading ? (
          <p className="muted">Memuat records…</p>
        ) : !result || result.items.length === 0 ? (
          <div className="empty-state">
            <div className="big">🗂️</div>
            <p>Tidak ada records{filter ? " yang cocok dengan filter" : ""}.</p>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    {allColumns.map((col) => (
                      <th key={col}>{col}</th>
                    ))}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((rec) => (
                    <tr key={String(rec.id)} onClick={() => setEditing(rec)}>
                      {allColumns.map((col) => (
                        <td key={col}>{formatCell(rec[col])}</td>
                      ))}
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          className="btn-icon"
                          onClick={() => handleDeleteRecord(String(rec.id))}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="pagination">
              <button
                className="btn btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ◀ Prev
              </button>
              <span className="page-info">
                Page {result.page} of {result.totalPages} ({result.totalItems} items)
              </span>
              <button
                className="btn btn-secondary"
                disabled={page >= result.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next ▶
              </button>
            </div>
          </>
        )}
      </div>

      {/* Modal: New / Edit Record */}
      {(showNew || editing) && collection && (
        <RecordModal
          collection={collection}
          initial={editing ?? undefined}
          onClose={() => {
            setShowNew(false);
            setEditing(null);
          }}
          onSave={async (data) => {
            if (editing) {
              await updateRecord(projectId, collectionName, String(editing.id), data);
            } else {
              await createRecord(projectId, collectionName, data);
            }
            setShowNew(false);
            setEditing(null);
            await loadRecords();
          }}
        />
      )}
    </div>
  );
}

// ─── Modal untuk buat/edit record ────────────────────────────────────────────

function RecordModal({
  collection,
  initial,
  onClose,
  onSave,
}: {
  collection: CollectionInfo;
  initial?: Record<string, unknown>;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of collection.fields) {
      v[f.name] = initial?.[f.name] ?? defaultForType(f);
    }
    return v;
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function handleSave() {
    setSaving(true);
    setErr("");
    try {
      await onSave(values);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Gagal menyimpan");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box card" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? "Edit Record" : "New Record"}</h3>

        {collection.fields.map((f) => (
          <div className="field" key={f.name}>
            <label>
              {f.name} <span className="type-badge">{f.type}</span>
              {f.required && <span className="req-badge"> *</span>}
            </label>
            <FieldInput
              field={f}
              value={values[f.name]}
              onChange={(val) => setValues({ ...values, [f.name]: val })}
            />
          </div>
        ))}

        {err && <div className="error-text">{err}</div>}

        <div className="form-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" onClick={handleSave} disabled={saving}>
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (field.type) {
    case "bool":
      return (
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {value === true ? "true" : "false"}
          </span>
        </label>
      );
    case "number":
      return (
        <input
          type="number"
          className="input"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "json":
      return (
        <textarea
          className="input"
          rows={3}
          style={{ fontFamily: "ui-monospace, monospace" }}
          value={typeof value === "string" ? value : JSON.stringify(value ?? null)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              onChange(e.target.value);
            }
          }}
        />
      );
    default:
      return (
        <input
          className="input"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function defaultForType(f: FieldDef): unknown {
  switch (f.type) {
    case "bool":
      return false;
    case "number":
      return null;
    case "json":
      return null;
    default:
      return "";
  }
}

function formatCell(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "object") return JSON.stringify(val);
  const s = String(val);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}
