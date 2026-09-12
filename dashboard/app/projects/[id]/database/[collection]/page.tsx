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
  getRules,
  updateRules,
  createRecordWithFiles,
  updateRecordWithFiles,
  fileUrl,
  type CollectionInfo,
  type FieldDef,
  type CollectionRules as Rules,
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

  // ── M10u: Rules editor state ──
  const [rules, setRules] = useState<Rules | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [rulesDraft, setRulesDraft] = useState<Rules | null>(null);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesError, setRulesError] = useState("");

  const RULE_LABELS: { key: keyof Rules; label: string; hint: string }[] = [
    { key: "listRule", label: "List", hint: "siapa boleh melihat daftar record" },
    { key: "viewRule", label: "View", hint: "siapa boleh melihat 1 record" },
    { key: "createRule", label: "Create", hint: "siapa boleh membuat record" },
    { key: "updateRule", label: "Update", hint: "siapa boleh mengubah" },
    { key: "deleteRule", label: "Delete", hint: "siapa boleh menghapus" },
  ];

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

  // ── M10u: muat rules saat collection berubah ──
  useEffect(() => {
    getRules(projectId, collectionName)
      .then(setRules)
      .catch(() => setRules(null));
  }, [projectId, collectionName]);

  async function saveRules() {
    if (!rulesDraft) return;
    setRulesSaving(true);
    setRulesError("");
    try {
      const saved = await updateRules(projectId, collectionName, rulesDraft);
      setRules(saved);
      setRulesDraft(null);
    } catch (e) {
      setRulesError(e instanceof Error ? e.message : "Gagal menyimpan rules");
    } finally {
      setRulesSaving(false);
    }
  }

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

      {/* M10u: API Rules (keamanan per collection) */}
      <div className="card" style={{ marginTop: "0.5rem", padding: "0.75rem 1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>🔐 API Rules</span>
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setShowRules(!showRules);
                setRulesDraft(null);
                setRulesError("");
              }}
            >
              {showRules ? "Tutup" : "Edit"}
            </button>
            {showRules && rulesDraft && (
              <button className="btn btn-primary" onClick={saveRules} disabled={rulesSaving}>
                {rulesSaving ? "Menyimpan…" : "Simpan rules"}
              </button>
            )}
          </div>
        </div>

        {!showRules ? (
          rules && (
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
              {RULE_LABELS.map(({ key, label }) => {
                const v = rules[key];
                const badge = v === null ? "🔒 Admin" : v.trim() === "" ? "🌐 Publik" : "🧮 Rule";
                return (
                  <span key={key} className="type-badge" title={`${label}: ${String(v ?? "null")}`}>
                    {label}: {badge}
                  </span>
                );
              })}
            </div>
          )
        ) : (
          <div style={{ marginTop: "0.6rem" }}>
            <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.6rem" }}>
              Kosongkan = publik (siapa pun). Hapus isi & tulis <code>null</code> = admin-only.
              Gunakan <code>@request.auth.id</code> untuk identitas user yang login.
              Contoh: <code>user = @request.auth.id</code>
            </p>
            {(rulesDraft ?? rules) &&
              RULE_LABELS.map(({ key, label, hint }) => {
                const draft = rulesDraft ?? rules!;
                const val = draft[key];
                return (
                  <div key={key} style={{ marginBottom: "0.5rem" }}>
                    <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.2rem" }}>
                      <strong>{label}</strong> <span className="muted">— {hint}</span>
                    </label>
                    <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                      <input
                        className="input"
                        style={{ flex: 1, fontFamily: "var(--mono, monospace)", fontSize: "0.8rem" }}
                        placeholder="(null = admin-only) atau rule, misal: user = @request.auth.id"
                        value={val === null ? "null" : val}
                        onChange={(e) => {
                          const text = e.target.value;
                          // "null" (persis, lowercase) → null (admin-only);
                          // string lain (termasuk kosong) → rule publik/kosong
                          const parsed: string | null = text.trim() === "null" ? null : text;
                          setRulesDraft({
                            ...(rulesDraft ?? rules!),
                            [key]: parsed,
                          });
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            {rulesError && <div className="error-text">{rulesError}</div>}
            <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.4rem" }}>
              💡 Trik: ketik <code>null</code> (huruf kecil) untuk admin-only, string kosong untuk publik.
            </p>
          </div>
        )}
      </div>

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
                      {allColumns.map((col) => {
                        const fieldMeta = collection?.fields.find((f) => f.name === col);
                        // M14u: render file field sebagai link/preview
                        if (fieldMeta?.type === "file") {
                          const files = Array.isArray(rec[col])
                            ? (rec[col] as string[])
                            : rec[col]
                              ? [String(rec[col])]
                              : [];
                          if (files.length === 0) return <td key={col}>—</td>;
                          return (
                            <td key={col}>
                              {files.map((fn) => {
                                const isImage = /\.(png|jpe?g|gif|webp|avif)$/i.test(fn);
                                const url = fileUrl(projectId, collectionName, String(rec.id), fn);
                                return (
                                  <div key={fn} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                    {isImage && (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img
                                        src={url}
                                        alt={fn}
                                        style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4 }}
                                      />
                                    )}
                                    <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                                      📎 {fn.length > 18 ? fn.slice(0, 18) + "…" : fn}
                                    </a>
                                  </div>
                                );
                              })}
                            </td>
                          );
                        }
                        return <td key={col}>{formatCell(rec[col])}</td>;
                      })}
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
          projectId={projectId}
          collectionName={collectionName}
          initial={editing ?? undefined}
          onClose={() => {
            setShowNew(false);
            setEditing(null);
          }}
          onSave={async (data, files) => {
            if (editing) {
              if (files && Object.keys(files).length > 0) {
                await updateRecordWithFiles(projectId, collectionName, String(editing.id), data, files);
              } else {
                await updateRecord(projectId, collectionName, String(editing.id), data);
              }
            } else {
              if (files && Object.keys(files).length > 0) {
                await createRecordWithFiles(projectId, collectionName, data, files);
              } else {
                await createRecord(projectId, collectionName, data);
              }
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
  projectId,
  collectionName,
  initial,
  onClose,
  onSave,
}: {
  collection: CollectionInfo;
  projectId: string;
  collectionName: string;
  initial?: Record<string, unknown>;
  onClose: () => void;
  onSave: (data: Record<string, unknown>, files?: Record<string, File | File[]>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of collection.fields) {
      v[f.name] = initial?.[f.name] ?? defaultForType(f);
    }
    return v;
  });
  const [fileValues, setFileValues] = useState<Record<string, File | File[]>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function handleSave() {
    setSaving(true);
    setErr("");
    try {
      // Field file yang punya File baru dikirim via multipart; field file
      // TANPA file baru (nilai lama) dijadikan string agar tidak tertimpa null
      const dataWithoutFiles: Record<string, unknown> = {};
      for (const f of collection.fields) {
        if (f.type === "file" && fileValues[f.name]) continue; // dikirim sebagai file
        dataWithoutFiles[f.name] = values[f.name];
      }
      await onSave(dataWithoutFiles, fileValues);
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
              projectId={projectId}
              collectionName={collectionName}
              recordId={initial ? String(initial.id) : undefined}
              value={values[f.name]}
              onChange={(val) => setValues({ ...values, [f.name]: val })}
              onFileChange={(file) => {
                const next = { ...fileValues };
                if (file === undefined) delete next[f.name];
                else next[f.name] = file;
                setFileValues(next);
              }}
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
  projectId,
  collectionName,
  recordId,
  value,
  onChange,
  onFileChange,
}: {
  field: FieldDef;
  projectId?: string;
  collectionName?: string;
  recordId?: string;
  value: unknown;
  onChange: (v: unknown) => void;
  onFileChange?: (f: File | File[] | undefined) => void;
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
    case "select": {
      // Dropdown dari options.values
      const allowed = field.options?.values ?? [];
      return (
        <select
          className="input"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">— pilih —</option>
          {allowed.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
    }
    case "autodate":
      // Diisi otomatis oleh sistem — tampilkan sebagai info, tidak bisa diedit
      return (
        <div className="muted" style={{ fontSize: "0.85rem", fontStyle: "italic" }}>
          ⏱ Diisi otomatis oleh sistem
        </div>
      );
    case "file": {
      // M14u: upload via <input type=file>; preview untuk file yang sudah ada
      const isMulti = (field.options?.maxSelect ?? 1) > 1;
      const existing = Array.isArray(value)
        ? (value as string[])
        : value
          ? [String(value)]
          : [];

      return (
        <div>
          <input
            type="file"
            multiple={isMulti}
            accept={field.options?.mime ?? undefined}
            onChange={(e) => {
              const fl = e.target.files;
              if (!fl || fl.length === 0) {
                onFileChange?.(undefined);
                return;
              }
              onFileChange?.(isMulti ? Array.from(fl) : fl[0]);
            }}
          />
          {existing.length > 0 && (
            <div style={{ marginTop: "0.4rem", fontSize: "0.82rem" }}>
              <span className="muted">File saat ini: </span>
              {existing.map((fn) => {
                const url =
                  projectId && collectionName && recordId
                    ? fileUrl(projectId, collectionName, recordId, fn)
                    : null;
                const isImage = /\.(png|jpe?g|gif|webp|avif)$/i.test(fn);
                return (
                  <div key={fn} style={{ marginTop: "0.25rem" }}>
                    {isImage && url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={url}
                        alt={fn}
                        style={{ maxWidth: 120, maxHeight: 80, display: "block", borderRadius: 4 }}
                      />
                    ) : null}
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer">
                        📎 {fn}
                      </a>
                    ) : (
                      <span>📎 {fn}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }
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
