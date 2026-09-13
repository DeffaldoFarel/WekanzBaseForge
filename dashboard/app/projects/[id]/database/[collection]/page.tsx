"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  listCollections,
  createCollection,
  updateCollection,
  rebuildCollectionSchema,
  deleteCollection,
  duplicateCollection,
  exportCollection,
  importCollection,
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
  type IndexDef,
  type CollectionRules as Rules,
  type ListResult,
} from "@/lib/api";
import { FieldOptionsEditor } from "@/components/FieldOptionsEditor";
import { IndexesEditor } from "@/components/IndexesEditor";
import { CreateCollectionModal } from "@/components/CreateCollectionModal";

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

const SORT_OPTIONS = [
  { value: "-created", label: "Created (Newest first)" },
  { value: "created", label: "Created (Oldest first)" },
  { value: "-updated", label: "Updated (Newest first)" },
  { value: "updated", label: "Updated (Oldest first)" },
];

export default function AdvancedDatabaseStudioPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const collectionName = params.collection as string;

  // ─── Studio State ──────────────────────────────────────────────────────────
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [colFilter, setColFilter] = useState("");
  const [collection, setCollection] = useState<CollectionInfo | null>(null);
  const [activeTab, setActiveTab] = useState<"records" | "schema" | "rules" | "io">("records");

  // Records Table State
  const [result, setResult] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const [sortQuery, setSortQuery] = useState("-created");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Modals
  const [editingRecord, setEditingRecord] = useState<Record<string, unknown> | null>(null);
  const [showNewRecord, setShowNewRecord] = useState(false);
  const [rawJsonView, setRawJsonView] = useState<Record<string, unknown> | null>(null);
  const [showDuplicateCol, setShowDuplicateCol] = useState(false);
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicateWithData, setDuplicateWithData] = useState(true);

  // New Collection Modal
  const [showNewCol, setShowNewCol] = useState(false);

  // Schema Editor State (M16 / D4 Rebuild)
  const [fieldsDraft, setFieldsDraft] = useState<FieldDef[]>([]);
  const [indexesDraft, setIndexesDraft] = useState<IndexDef[]>([]);
  const [schemaSaving, setSchemaSaving] = useState(false);
  const [schemaError, setSchemaError] = useState("");

  // Rules Editor State
  const [rules, setRules] = useState<Rules | null>(null);
  const [rulesDraft, setRulesDraft] = useState<Rules | null>(null);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesError, setRulesError] = useState("");

  // Import / Export State
  const [importJsonText, setImportJsonText] = useState("");
  const [importMode, setImportMode] = useState<"create" | "replace" | "merge">("create");
  const [importing, setImporting] = useState(false);
  const [ioMessage, setIoMessage] = useState("");

  // ─── Data Loaders ──────────────────────────────────────────────────────────

  const loadAllCollections = useCallback(async () => {
    try {
      const data = await listCollections(projectId);
      setCollections(data);
      const current = data.find((c) => c.name === collectionName);
      setCollection(current ?? null);
      if (current) {
        setFieldsDraft(JSON.parse(JSON.stringify(current.fields)));
        setIndexesDraft(JSON.parse(JSON.stringify(current.indexes || [])));
      }
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memuat collections");
      return [];
    }
  }, [projectId, collectionName]);

  const loadRecords = useCallback(async () => {
    if (!collectionName) return;
    try {
      setLoading(true);
      const data = await listRecords(projectId, collectionName, {
        search: searchQuery.trim() || undefined,
        filter: filterQuery.trim() || undefined,
        sort: sortQuery || undefined,
        page,
        perPage: 15,
      });
      setResult(data);
      setSelectedIds(new Set());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memuat records");
    } finally {
      setLoading(false);
    }
  }, [projectId, collectionName, searchQuery, filterQuery, sortQuery, page]);

  useEffect(() => {
    loadAllCollections();
  }, [loadAllCollections]);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  // Muat rules saat berpindah tab atau collection
  useEffect(() => {
    if (collectionName) {
      getRules(projectId, collectionName)
        .then((r) => {
          setRules(r);
          setRulesDraft(r);
        })
        .catch(() => setRules(null));
    }
  }, [projectId, collectionName]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    await loadRecords();
  }

  function handleSelectAll(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.checked && result) {
      setSelectedIds(new Set(result.items.map((it) => String(it.id))));
    } else {
      setSelectedIds(new Set());
    }
  }

  function handleToggleRow(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  async function handleDeleteRecord(id: string) {
    if (!confirm("Hapus record ini?")) return;
    try {
      await deleteRecord(projectId, collectionName, id);
      await loadRecords();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Gagal menghapus");
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Hapus ${selectedIds.size} record yang dipilih?`)) return;
    try {
      for (const id of Array.from(selectedIds)) {
        await deleteRecord(projectId, collectionName, id);
      }
      setSelectedIds(new Set());
      await loadRecords();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Gagal menghapus beberapa record");
    }
  }

  async function handleDeleteCollection() {
    if (!confirm(`HAPUS KOLEKSI "${collectionName}" BESERTA SELURUH DATA & FILE DI DALAMNYA?`)) return;
    try {
      await deleteCollection(projectId, collectionName);
      const remaining = collections.filter((c) => c.name !== collectionName);
      if (remaining.length > 0) {
        router.push(`/projects/${projectId}/database/${encodeURIComponent(remaining[0].name)}`);
      } else {
        router.push(`/projects/${projectId}/database`);
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Gagal menghapus collection");
    }
  }

  async function handleDuplicateCollection() {
    if (!duplicateName.trim()) return;
    try {
      await duplicateCollection(projectId, collectionName, duplicateName.trim(), duplicateWithData);
      setShowDuplicateCol(false);
      setDuplicateName("");
      const updated = await loadAllCollections();
      router.push(`/projects/${projectId}/database/${encodeURIComponent(duplicateName.trim())}`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Gagal menduplikasi collection");
    }
  }

  async function handleExportJson() {
    try {
      const json = await exportCollection(projectId, collectionName);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${collectionName}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Gagal mengekspor data");
    }
  }

  async function handleImportJson() {
    if (!importJsonText.trim()) return;
    setImporting(true);
    setIoMessage("");
    try {
      const parsed = JSON.parse(importJsonText);
      const res = await importCollection(projectId, parsed, importMode);
      setIoMessage(`Berhasil import ${res.recordCount} records!`);
      setImportJsonText("");
      await loadRecords();
      await loadAllCollections();
    } catch (e) {
      setIoMessage(e instanceof Error ? e.message : "Gagal mengimpor JSON");
    } finally {
      setImporting(false);
    }
  }

  async function handleSaveRules() {
    if (!rulesDraft) return;
    setRulesSaving(true);
    setRulesError("");
    try {
      const saved = await updateRules(projectId, collectionName, rulesDraft);
      setRules(saved);
      alert("API Rules berhasil diperbarui!");
    } catch (e) {
      setRulesError(e instanceof Error ? e.message : "Gagal menyimpan rules");
    } finally {
      setRulesSaving(false);
    }
  }

  async function handleSaveSchema() {
    if (!collection) return;
    setSchemaSaving(true);
    setSchemaError("");
    try {
      const validFields = fieldsDraft.filter((f) => f.name.trim().length > 0);
      const updated = await rebuildCollectionSchema(projectId, collectionName, {
        fields: validFields,
        indexes: indexesDraft,
      });
      setCollection(updated);
      setFieldsDraft(JSON.parse(JSON.stringify(updated.fields)));
      setIndexesDraft(JSON.parse(JSON.stringify(updated.indexes || [])));
      alert("Skema & Indeks berhasil diperbarui via Table Rebuild!");
      await loadAllCollections();
      await loadRecords();
    } catch (e) {
      setSchemaError(e instanceof Error ? e.message : "Gagal memperbarui skema");
    } finally {
      setSchemaSaving(false);
    }
  }

  const filteredCollections = collections.filter((c) =>
    c.name.toLowerCase().includes(colFilter.toLowerCase())
  );
  const isView = collection?.type === "view";

  return (
    <div className="studio-layout">
      {/* ─── SIDEBAR MASTER COLLECTIONS ─── */}
      <aside className="studio-sidebar">
        <div style={{ marginBottom: "0.85rem" }}>
          <Link href={`/projects/${projectId}`} className="nav-back" style={{ fontSize: "0.82rem" }}>
            ← Project Home
          </Link>
          <div className="studio-sidebar-header">
            <span>Collections ({collections.length})</span>
            <button
              className="btn btn-secondary"
              style={{ padding: "0.25rem 0.55rem", fontSize: "0.78rem" }}
              onClick={() => setShowNewCol(true)}
              title="Buat koleksi baru"
            >
              + New
            </button>
          </div>

          <input
            className="input"
            placeholder="Cari koleksi..."
            value={colFilter}
            onChange={(e) => setColFilter(e.target.value)}
            style={{ fontSize: "0.8rem", padding: "0.4rem 0.65rem", marginBottom: "0.5rem" }}
          />
        </div>

        <div className="studio-sidebar-list">
          {filteredCollections.map((c) => {
            const isActive = c.name === collectionName;
            const isView = c.type === "view";
            return (
              <Link
                key={c.name}
                href={`/projects/${projectId}/database/${encodeURIComponent(c.name)}`}
                className={`studio-col-link ${isActive ? "active" : ""}`}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", overflow: "hidden" }}>
                  <span>{isView ? "👁️" : "📦"}</span>
                  <span style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                    {c.name}
                  </span>
                </div>
                <span className="badge badge-gray" style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }}>
                  {c.recordCount ?? 0}
                </span>
              </Link>
            );
          })}
        </div>
      </aside>

      {/* ─── MAIN CONTENT STUDIO ─── */}
      <main className="studio-main">
        {/* Header Koleksi */}
        <div className="header-row" style={{ marginBottom: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontSize: "1.6rem" }}>{collection?.type === "view" ? "👁️" : "📦"}</span>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <h1 style={{ fontSize: "1.4rem", margin: 0 }}>{collectionName}</h1>
                <span className="badge badge-accent" style={{ textTransform: "uppercase" }}>
                  {collection?.type === "view" ? "SQL View" : "Base Collection"}
                </span>
              </div>
              <p className="muted" style={{ fontSize: "0.82rem", margin: "0.2rem 0 0" }}>
                {collection?.fields.length ?? 0} fields · {collection?.recordCount ?? 0} records
              </p>
            </div>
          </div>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              className="btn btn-secondary"
              style={{ fontSize: "0.82rem", padding: "0.45rem 0.8rem" }}
              onClick={() => {
                setDuplicateName(`${collectionName}_copy`);
                setShowDuplicateCol(true);
              }}
              title="Duplikasi struktur atau data collection ini"
            >
              📑 Duplicate
            </button>
            <button
              className="btn btn-secondary"
              style={{ fontSize: "0.82rem", padding: "0.45rem 0.8rem" }}
              onClick={handleExportJson}
              title="Download backup JSON"
            >
              📥 Export JSON
            </button>
            <button
              className="btn btn-danger"
              style={{ fontSize: "0.82rem", padding: "0.45rem 0.8rem" }}
              onClick={handleDeleteCollection}
            >
              🗑️ Delete
            </button>
          </div>
        </div>

        {/* Studio Sub-Tabs */}
        <div className="studio-tabs">
          <button
            className={`studio-tab ${activeTab === "records" ? "active" : ""}`}
            onClick={() => setActiveTab("records")}
          >
            📊 Records ({result?.totalItems ?? 0})
          </button>
          <button
            className={`studio-tab ${activeTab === "schema" ? "active" : ""}`}
            onClick={() => setActiveTab("schema")}
          >
            📐 Schema & Fields ({collection?.fields.length ?? 0})
          </button>
          <button
            className={`studio-tab ${activeTab === "rules" ? "active" : ""}`}
            onClick={() => setActiveTab("rules")}
          >
            🔒 API Rules
          </button>
          <button
            className={`studio-tab ${activeTab === "io" ? "active" : ""}`}
            onClick={() => setActiveTab("io")}
          >
            💾 Export / Import
          </button>
        </div>

        {error && <div className="error-text" style={{ marginBottom: "1rem" }}>{error}</div>}

        {/* ─── TAB 1: RECORDS (DATA BROWSER) ─── */}
        {activeTab === "records" && (
          <div>
            {/* Search, Filter & Action Toolbar */}
            <div className="studio-toolbar">
              <form onSubmit={handleSearch} className="studio-search-group">
                <input
                  className="input"
                  placeholder="🔎 Search (?search=... FTS5)"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ fontSize: "0.85rem" }}
                />
                <input
                  className="input"
                  placeholder="Filter: status = 'active' && streak > 5"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  style={{ fontSize: "0.85rem", flex: 1.5 }}
                />
                <button type="submit" className="btn btn-secondary" style={{ padding: "0.55rem 0.9rem" }}>
                  Filter
                </button>
                {(searchQuery || filterQuery) && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setSearchQuery("");
                      setFilterQuery("");
                      setPage(1);
                    }}
                  >
                    Reset
                  </button>
                )}
              </form>

              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <select
                  className="input"
                  value={sortQuery}
                  onChange={(e) => setSortQuery(e.target.value)}
                  style={{ fontSize: "0.85rem", width: "auto" }}
                >
                  {SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>

                {selectedIds.size > 0 && (
                  <button className="btn btn-danger" onClick={handleBulkDelete} style={{ fontSize: "0.85rem" }}>
                    🗑️ Hapus ({selectedIds.size})
                  </button>
                )}

                {isView ? (
                  <span
                    className="badge badge-purple"
                    style={{ padding: "0.45rem 0.85rem", fontSize: "0.82rem", whiteSpace: "nowrap" }}
                  >
                    👁️ Read-only View
                  </span>
                ) : (
                  <button
                    className="btn"
                    onClick={() => {
                      setEditingRecord(null);
                      setShowNewRecord(true);
                    }}
                    style={{ fontSize: "0.85rem", whiteSpace: "nowrap" }}
                  >
                    + New Record
                  </button>
                )}
              </div>
            </div>

            {/* Records Data Table */}
            <div className="table-container">
              {loading ? (
                <div style={{ padding: "2.5rem", textAlign: "center" }} className="muted">
                  Memuat data records…
                </div>
              ) : !result || result.items.length === 0 ? (
                <div className="empty-state">
                  <div className="big">📄</div>
                  <p>Tidak ada record yang cocok.</p>
                </div>
              ) : (
                <div className="table-wrap" style={{ margin: 0 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: "36px" }}>
                          <input
                            type="checkbox"
                            checked={selectedIds.size === result.items.length && result.items.length > 0}
                            onChange={handleSelectAll}
                          />
                        </th>
                        <th style={{ width: "140px" }}>ID</th>
                        {collection?.fields.map((f) => (
                          <th key={f.name}>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                              <span>{f.name}</span>
                              <span className="type-badge" style={{ fontSize: "0.68rem" }}>{f.type}</span>
                            </div>
                          </th>
                        ))}
                        <th style={{ width: "150px" }}>Created</th>
                        <th style={{ width: "90px", textAlign: "right" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.items.map((row) => {
                        const id = String(row.id);
                        const isSelected = selectedIds.has(id);
                        return (
                          <tr key={id} style={{ background: isSelected ? "rgba(249, 115, 22, 0.08)" : undefined }}>
                            <td onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => handleToggleRow(id)}
                              />
                            </td>
                            <td style={{ color: "var(--accent)", fontWeight: 600 }}>{id}</td>
                            {collection?.fields.map((f) => {
                              const val = row[f.name];
                              return (
                                <td key={f.name}>
                                  <RenderTableCell
                                    field={f}
                                    value={val}
                                    record={row}
                                    projectId={projectId}
                                    collectionName={collectionName}
                                    onViewJson={() => setRawJsonView(row)}
                                  />
                                </td>
                              );
                            })}
                            <td className="muted" style={{ fontSize: "0.78rem" }}>
                              {String(row.created || "").slice(0, 19).replace("T", " ")}
                            </td>
                            <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                              {!isView && (
                                <>
                                  <button
                                    className="btn-icon"
                                    style={{ marginRight: "0.3rem" }}
                                    onClick={() => {
                                      setEditingRecord(row);
                                      setShowNewRecord(true);
                                    }}
                                    title="Edit record"
                                  >
                                    ✏️
                                  </button>
                                  <button
                                    className="btn-icon"
                                    style={{ marginRight: "0.3rem" }}
                                    onClick={() => {
                                      // Duplicate record
                                      const clone = { ...row };
                                      delete clone.id;
                                      delete clone.created;
                                      delete clone.updated;
                                      setEditingRecord(clone);
                                      setShowNewRecord(true);
                                    }}
                                    title="Duplicate record"
                                  >
                                    📑
                                  </button>
                                </>
                              )}
                              <button
                                className="btn-icon"
                                style={{ marginRight: isView ? 0 : "0.3rem" }}
                                onClick={() => setRawJsonView(row)}
                                title="View Raw JSON"
                              >
                                🔍
                              </button>
                              {!isView && (
                                <button
                                  className="btn-icon"
                                  onClick={() => handleDeleteRecord(id)}
                                  title="Delete record"
                                >
                                  ✕
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Pagination Controls */}
            {result && result.totalPages > 1 && (
              <div className="pagination">
                <button
                  className="btn btn-secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  ← Previous
                </button>
                <span className="page-info">
                  Halaman {page} dari {result.totalPages} ({result.totalItems} records)
                </span>
                <button
                  className="btn btn-secondary"
                  disabled={page >= result.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ─── TAB 2: SCHEMA & FIELDS (OR VIEW QUERY) ─── */}
        {activeTab === "schema" && (
          <div className="card">
            {isView ? (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
                  <div>
                    <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span>👁️</span> SQL View Definition — "{collectionName}"
                    </h3>
                    <p className="muted" style={{ fontSize: "0.85rem", margin: "0.25rem 0 0" }}>
                      Koleksi ini adalah read-only SQL View yang dikompilasi secara otomatis oleh SQLite.
                    </p>
                  </div>
                  <span className="badge badge-purple" style={{ padding: "0.35rem 0.75rem", fontSize: "0.82rem" }}>
                    Read-only View
                  </span>
                </div>

                <div style={{ background: "var(--panel-2)", padding: "1.25rem", borderRadius: "10px", border: "1px solid var(--border)", marginBottom: "1.5rem" }}>
                  <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--accent)", marginBottom: "0.5rem", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                    Kueri SQL SELECT:
                  </div>
                  <pre
                    style={{
                      background: "var(--bg)",
                      padding: "1rem",
                      borderRadius: "8px",
                      border: "1px solid var(--border)",
                      fontFamily: "ui-monospace, monospace",
                      fontSize: "0.88rem",
                      overflowX: "auto",
                      color: "var(--text)",
                      lineHeight: "1.5",
                      margin: 0,
                    }}
                  >
                    {collection?.viewQuery || "SELECT ..."}
                  </pre>
                </div>

                <div>
                  <h4 style={{ margin: "0 0 0.75rem 0", fontSize: "0.95rem" }}>
                    Inferred Columns ({collection?.fields.length ?? 0})
                  </h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "0.6rem" }}>
                    {collection?.fields.map((f) => (
                      <div
                        key={f.name}
                        style={{
                          background: "var(--panel-2)",
                          border: "1px solid var(--border)",
                          borderRadius: "8px",
                          padding: "0.6rem 0.85rem",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{f.name}</span>
                        <span className="badge badge-gray" style={{ fontSize: "0.72rem" }}>
                          {f.type}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem", flexWrap: "wrap", gap: "0.5rem" }}>
                  <div>
                    <h3 style={{ margin: 0 }}>Schema Editor — "{collectionName}"</h3>
                    <p className="muted" style={{ fontSize: "0.85rem", margin: "0.25rem 0 0" }}>
                      Ubah tipe kolom, tambah, atau hapus field. Perubahan dijalankan via SQLite Table Rebuild (data tetap selamat!).
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setFieldsDraft([
                          ...fieldsDraft,
                          { name: "", type: "text", required: false },
                        ]);
                      }}
                    >
                      + Add Field
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={handleSaveSchema}
                      disabled={schemaSaving}
                    >
                      {schemaSaving ? "Menyimpan Skema…" : "💾 Save Schema Changes"}
                    </button>
                  </div>
                </div>

                {schemaError && <div className="error-text" style={{ marginBottom: "1rem" }}>{schemaError}</div>}

                <div style={{ display: "grid", gap: "0.75rem" }}>
                  {fieldsDraft.map((f, i) => (
                    <div key={i} className="field-card" style={{ background: "var(--panel-2)" }}>
                      <div className="field-card-header">
                        <input
                          className="input"
                          placeholder="nama field"
                          value={f.name}
                          onChange={(e) => {
                            const updated = [...fieldsDraft];
                            updated[i].name = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
                            setFieldsDraft(updated);
                          }}
                          style={{ flex: 2, fontWeight: 600 }}
                        />

                        <select
                          className="input"
                          value={f.type}
                          onChange={(e) => {
                            const updated = [...fieldsDraft];
                            updated[i].type = e.target.value;
                            setFieldsDraft(updated);
                          }}
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
                            onChange={(e) => {
                              const updated = [...fieldsDraft];
                              updated[i].required = e.target.checked;
                              setFieldsDraft(updated);
                            }}
                          />
                          Req
                        </label>

                        <button
                          type="button"
                          className="btn-icon"
                          onClick={() => {
                            if (confirm(`Hapus kolom "${f.name || 'baru'}"? Kolom ini akan dihapus saat skema disimpan.`)) {
                              setFieldsDraft(fieldsDraft.filter((_, idx) => idx !== i));
                            }
                          }}
                          title="Hapus kolom"
                        >
                          ✕
                        </button>
                      </div>

                      {/* Field Specific Options for All 14 Types */}
                      <FieldOptionsEditor
                        field={f}
                        allCollections={collections}
                        onChange={(patch) => {
                          const updated = [...fieldsDraft];
                          updated[i] = { ...updated[i], ...patch };
                          setFieldsDraft(updated);
                        }}
                      />
                    </div>
                  ))}
                </div>

                {/* ─── POCKETBASE-STYLE INDEXES & UNIQUE CONSTRAINTS SECTION ─── */}
                <IndexesEditor
                  collectionName={collectionName}
                  indexes={indexesDraft}
                  fields={fieldsDraft}
                  onChange={setIndexesDraft}
                />

                <div style={{ marginTop: "1.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setFieldsDraft([
                        ...fieldsDraft,
                        { name: "", type: "text", required: false },
                      ]);
                    }}
                  >
                    + Add Field
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleSaveSchema}
                    disabled={schemaSaving}
                  >
                    {schemaSaving ? "Menyimpan Skema…" : "💾 Save Schema Changes"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── TAB 3: API RULES ─── */}
        {activeTab === "rules" && (
          <div className="card">
            <div style={{ marginBottom: "1.25rem" }}>
              <h3 style={{ margin: 0 }}>API Rules (Row-Level Security)</h3>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Atur otorisasi siapa yang boleh membaca, menulis, mengubah, dan menghapus data pada koleksi ini.
              </p>
            </div>

            {rulesError && <div className="error-text" style={{ marginBottom: "1rem" }}>{rulesError}</div>}

            <div style={{ display: "grid", gap: "1rem" }}>
              {(
                [
                  { key: "listRule", label: "List Rule", hint: "Siapa boleh melihat daftar record (GET .../records)" },
                  { key: "viewRule", label: "View Rule", hint: "Siapa boleh melihat 1 record spesifik (GET .../records/:id)" },
                  { key: "createRule", label: "Create Rule", hint: "Siapa boleh menambah record baru (POST .../records)" },
                  { key: "updateRule", label: "Update Rule", hint: "Siapa boleh mengubah record (PATCH .../records/:id)" },
                  { key: "deleteRule", label: "Delete Rule", hint: "Siapa boleh menghapus record (DELETE .../records/:id)" },
                ] as const
              ).map((r) => {
                const val = rulesDraft ? rulesDraft[r.key] : null;
                const isLocked = val === null || val === undefined;
                const isPublic = val === "";
                const isCustom = !isLocked && !isPublic;

                return (
                  <div key={r.key} style={{ background: "var(--panel-2)", padding: "1rem", borderRadius: "8px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <strong>{r.label}</strong>
                        {isLocked && <span className="badge badge-accent">🔒 Admin Only (null)</span>}
                        {isPublic && <span className="badge badge-green">🌐 Publik ("")</span>}
                        {isCustom && <span className="badge badge-blue">🧮 Custom Rule</span>}
                      </div>
                      <div style={{ display: "flex", gap: "0.3rem" }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
                          onClick={() => setRulesDraft((prev) => ({ ...(prev || DEFAULT_RULES), [r.key]: null }))}
                        >
                          🔒 Kunci (null)
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
                          onClick={() => setRulesDraft((prev) => ({ ...(prev || DEFAULT_RULES), [r.key]: "" }))}
                        >
                          🌐 Buka ("")
                        </button>
                      </div>
                    </div>
                    <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.5rem" }}>{r.hint}</p>
                    <input
                      className="input"
                      placeholder="null (admin only), atau ekspresi: user = @request.auth.id"
                      value={val === null || val === undefined ? "" : val}
                      onChange={(e) => {
                        const nextVal = e.target.value === "" ? null : e.target.value;
                        setRulesDraft((prev) => ({ ...(prev || DEFAULT_RULES), [r.key]: nextVal }));
                      }}
                      style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.85rem" }}
                    />
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: "1.5rem", display: "flex", justifyContent: "flex-end" }}>
              <button className="btn" onClick={handleSaveRules} disabled={rulesSaving}>
                {rulesSaving ? "Menyimpan Rules…" : "Simpan Perubahan Rules"}
              </button>
            </div>
          </div>
        )}

        {/* ─── TAB 4: EXPORT / IMPORT ─── */}
        {activeTab === "io" && (
          <div className="card">
            <h3 style={{ marginBottom: "0.5rem" }}>Backup & Migrasi Data (JSON)</h3>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "1.5rem" }}>
              Ekspor seluruh skema dan baris data ke format JSON mandiri, atau impor dari backup sebelumnya.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
              {/* Export Box */}
              <div style={{ background: "var(--panel-2)", padding: "1.25rem", borderRadius: "10px" }}>
                <h4 style={{ marginBottom: "0.5rem" }}>📥 Export Koleksi</h4>
                <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "1rem" }}>
                  Unduh file <code>{collectionName}-export.json</code> yang berisi seluruh definisi field beserta semua baris record di dalamnya.
                </p>
                <button className="btn" onClick={handleExportJson}>
                  Unduh File JSON Export
                </button>
              </div>

              {/* Import Box */}
              <div style={{ background: "var(--panel-2)", padding: "1.25rem", borderRadius: "10px" }}>
                <h4 style={{ marginBottom: "0.5rem" }}>📤 Import JSON Data</h4>
                <div className="field">
                  <label>Mode Import:</label>
                  <select
                    className="input"
                    value={importMode}
                    onChange={(e) => setImportMode(e.target.value as "create" | "replace" | "merge")}
                    style={{ fontSize: "0.85rem" }}
                  >
                    <option value="create">create — buat baru (gagal jika sudah ada)</option>
                    <option value="replace">replace — hapus semua data lama & ganti</option>
                    <option value="merge">merge — upsert berdasarkan ID record</option>
                  </select>
                </div>

                <div className="field">
                  <label>Paste Isi JSON Export:</label>
                  <textarea
                    className="input"
                    rows={4}
                    placeholder='{"collection": {"name": "..."}, "records": [...]}'
                    value={importJsonText}
                    onChange={(e) => setImportJsonText(e.target.value)}
                    style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}
                  />
                </div>

                {ioMessage && (
                  <div style={{ fontSize: "0.82rem", marginBottom: "0.75rem", color: ioMessage.includes("Berhasil") ? "var(--green)" : "var(--red)" }}>
                    {ioMessage}
                  </div>
                )}

                <button className="btn" onClick={handleImportJson} disabled={importing || !importJsonText.trim()}>
                  {importing ? "Mengimpor…" : "Mulai Import JSON"}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ─── MODAL: RECORD FORM (CREATE / EDIT) ─── */}
      {showNewRecord && (
        <RecordFormModal
          collection={collection!}
          initialData={editingRecord}
          projectId={projectId}
          onClose={() => {
            setShowNewRecord(false);
            setEditingRecord(null);
          }}
          onSuccess={() => {
            setShowNewRecord(false);
            setEditingRecord(null);
            loadRecords();
          }}
        />
      )}

      {/* ─── MODAL: VIEW RAW JSON ─── */}
      {rawJsonView && (
        <div className="modal-overlay" onClick={() => setRawJsonView(null)}>
          <div className="modal-box-lg card" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h3 style={{ margin: 0 }}>Record Raw JSON ({String(rawJsonView.id || "")})</h3>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: "0.8rem", padding: "0.3rem 0.7rem" }}
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(rawJsonView, null, 2));
                    alert("JSON berhasil di-copy ke clipboard!");
                  }}
                >
                  📋 Copy JSON
                </button>
                <button className="btn-icon" onClick={() => setRawJsonView(null)}>✕</button>
              </div>
            </div>
            <pre style={{ background: "var(--panel-2)", padding: "1rem", borderRadius: "8px", overflowX: "auto", fontSize: "0.82rem", color: "var(--accent)" }}>
              {JSON.stringify(rawJsonView, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* ─── MODAL: DUPLICATE COLLECTION ─── */}
      {showDuplicateCol && (
        <div className="modal-overlay" onClick={() => setShowDuplicateCol(false)}>
          <div className="modal-box card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: "1rem" }}>Duplicate Collection "{collectionName}"</h3>
            <div className="field">
              <label>Nama Collection Baru</label>
              <input
                className="input"
                value={duplicateName}
                onChange={(e) => setDuplicateName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                placeholder="nama_koleksi_baru"
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.88rem", cursor: "pointer", marginBottom: "1.25rem" }}>
              <input
                type="checkbox"
                checked={duplicateWithData}
                onChange={(e) => setDuplicateWithData(e.target.checked)}
              />
              <span>Sertakan seluruh data record (withData)</span>
            </label>
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setShowDuplicateCol(false)}>Batal</button>
              <button className="btn" onClick={handleDuplicateCollection}>Duplikasi Sekarang</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: NEW COLLECTION (POCKETBASE STYLE) ─── */}
      {showNewCol && (
        <CreateCollectionModal
          projectId={projectId}
          existingCollections={collections}
          onClose={() => setShowNewCol(false)}
          onCreated={async (created) => {
            setShowNewCol(false);
            await loadAllCollections();
            router.push(`/projects/${projectId}/database/${encodeURIComponent(created.name)}`);
          }}
        />
      )}
    </div>
  );
}

// ─── HELPER: CELL RENDERING ──────────────────────────────────────────────────

function RenderTableCell({
  field,
  value,
  record,
  projectId,
  collectionName,
  onViewJson,
}: {
  field: FieldDef;
  value: unknown;
  record: Record<string, unknown>;
  projectId: string;
  collectionName: string;
  onViewJson: () => void;
}) {
  if (value === null || value === undefined) {
    return <span className="muted" style={{ fontStyle: "italic", fontSize: "0.8rem" }}>null</span>;
  }

  if (field.type === "bool") {
    return value ? (
      <span className="badge badge-green">✓ true</span>
    ) : (
      <span className="badge badge-gray">✕ false</span>
    );
  }

  if (field.type === "file") {
    const filename = String(value);
    const url = fileUrl(projectId, collectionName, String(record.id), filename);
    const isImg = /\.(png|jpe?g|gif|webp|avif)$/i.test(filename);

    return (
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
        {isImg && url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${url}?thumb=100x100`}
            alt={filename}
            style={{ width: 26, height: 26, borderRadius: 4, objectFit: "cover" }}
          />
        ) : null}
        <a href={url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
          📎 {filename.slice(0, 18)}
        </a>
      </div>
    );
  }

  if (field.type === "json") {
    return (
      <button
        type="button"
        className="badge badge-gray"
        onClick={onViewJson}
        style={{ cursor: "pointer", fontFamily: "ui-monospace, monospace" }}
      >
        {typeof value === "object" ? JSON.stringify(value).slice(0, 24) + "…" : String(value)}
      </button>
    );
  }

  if (field.type === "password") {
    return <span className="muted">•••••••• (hash)</span>;
  }

  return <span>{String(value).slice(0, 36)}</span>;
}

// ─── HELPER: RECORD FORM MODAL ───────────────────────────────────────────────

function RecordFormModal({
  collection,
  initialData,
  projectId,
  onClose,
  onSuccess,
}: {
  collection: CollectionInfo;
  initialData: Record<string, unknown> | null;
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isEdit = !!initialData?.id;
  const [formData, setFormData] = useState<Record<string, unknown>>(() => {
    if (initialData) {
      const copy = { ...initialData };
      return copy;
    }
    const empty: Record<string, unknown> = {};
    for (const f of collection.fields) {
      if (f.type === "bool") empty[f.name] = false;
      else if (f.type === "number") empty[f.name] = null;
      else empty[f.name] = "";
    }
    return empty;
  });

  const [files, setFiles] = useState<Record<string, File | File[]>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    try {
      const hasFiles = Object.keys(files).length > 0;

      if (hasFiles) {
        if (isEdit) {
          await updateRecordWithFiles(projectId, collection.name, String(initialData!.id), formData, files);
        } else {
          await createRecordWithFiles(projectId, collection.name, formData, files);
        }
      } else {
        if (isEdit) {
          await updateRecord(projectId, collection.name, String(initialData!.id), formData);
        } else {
          await createRecord(projectId, collection.name, formData);
        }
      }

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan record");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box card" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
          <h3 style={{ margin: 0 }}>{isEdit ? `Edit Record (${initialData.id})` : "New Record"}</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        {error && <div className="error-text" style={{ marginBottom: "1rem" }}>{error}</div>}

        <form onSubmit={handleSubmit}>
          {collection.fields.map((f) => (
            <div key={f.name} className="field">
              <label style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{f.name} {f.required && <span style={{ color: "var(--red)" }}>*</span>}</span>
                <span className="type-badge" style={{ fontSize: "0.7rem" }}>{f.type}</span>
              </label>

              {f.type === "bool" ? (
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={formData[f.name] === true}
                    onChange={(e) => setFormData({ ...formData, [f.name]: e.target.checked })}
                  />
                  <span>{formData[f.name] === true ? "True" : "False"}</span>
                </label>
              ) : f.type === "select" ? (
                <select
                  className="input"
                  value={String(formData[f.name] ?? "")}
                  onChange={(e) => setFormData({ ...formData, [f.name]: e.target.value || null })}
                >
                  <option value="">— pilih opsi —</option>
                  {(f.options?.values || []).map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              ) : f.type === "file" ? (
                <div>
                  <input
                    type="file"
                    className="input"
                    onChange={(e) => {
                      const fl = e.target.files;
                      if (fl && fl.length > 0) {
                        setFiles({ ...files, [f.name]: fl[0] });
                      }
                    }}
                  />
                  {Boolean(initialData?.[f.name]) && (
                    <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.3rem" }}>
                      File saat ini: {String(initialData![f.name])}
                    </div>
                  )}
                </div>
              ) : f.type === "json" ? (
                <textarea
                  className="input"
                  rows={3}
                  value={
                    typeof formData[f.name] === "object"
                      ? JSON.stringify(formData[f.name], null, 2)
                      : String(formData[f.name] ?? "")
                  }
                  onChange={(e) => {
                    try {
                      setFormData({ ...formData, [f.name]: JSON.parse(e.target.value) });
                    } catch {
                      setFormData({ ...formData, [f.name]: e.target.value });
                    }
                  }}
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.82rem" }}
                />
              ) : f.type === "autodate" ? (
                <div className="muted" style={{ fontSize: "0.82rem", fontStyle: "italic" }}>
                  ⏱ Diisi otomatis oleh sistem
                </div>
              ) : (
                <input
                  className="input"
                  type={f.type === "number" ? "number" : f.type === "password" ? "password" : "text"}
                  value={formData[f.name] === null || formData[f.name] === undefined ? "" : String(formData[f.name])}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      [f.name]: f.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value,
                    })
                  }
                  required={f.required}
                />
              )}
            </div>
          ))}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Batal
            </button>
            <button type="submit" className="btn" disabled={saving}>
              {saving ? "Menyimpan…" : isEdit ? "Update Record" : "Create Record"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
