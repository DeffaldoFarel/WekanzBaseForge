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
  deleteRecordsBatch,
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
import { Navbar } from "@/components/Navbar";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { StudioSidebar } from "@/components/studio/StudioSidebar";
import { StudioTabs } from "@/components/studio/StudioTabs";
import { RecordsTab } from "@/components/studio/RecordsTab";
import { SchemaTab } from "@/components/studio/SchemaTab";
import { RulesTab } from "@/components/studio/RulesTab";
import { ImportExportTab } from "@/components/studio/ImportExportTab";
import { RawJsonModal } from "@/components/studio/RawJsonModal";
import { DuplicateModal } from "@/components/studio/DuplicateModal";
import { RecordFormModal } from "@/components/studio/RecordFormModal";
import { RenderTableCell } from "@/components/studio/RenderTableCell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useToasts, ToastHost } from "@/components/ui/toast";
import { errorMessage } from "@/components/ui/load-error";
import AggregatePanel from "@/components/AggregatePanel";
import {
  Database,
  Eye,
  Users,
  Plus,
  Search,
  Copy,
  Download,
  Upload,
  Trash2,
  Shield,
  Table as TableIcon,
  Layers,
  ArrowLeft,
  Loader2,
  MoreHorizontal,
} from "lucide-react";

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<"records" | "schema" | "rules" | "agg" | "io">("records");

  // Records Table State
  const [result, setResult] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  // Nilai yang benar-benar dikirim ke server. Dipisah dari nilai input agar
  // mengetik tidak sama dengan memanggil API: dulu setiap karakter masuk ke
  // deps loadRecords, jadi "customer" = 8 query FTS5 berturut-turut (terukur
  // 7x beban server dibanding satu query). Route admin tidak melewati
  // checkSearchRateLimit (guard itu hanya dipasang di publicRoutes), jadi
  // tidak ada rem apa pun di sisi server.
  const [searchApplied, setSearchApplied] = useState("");
  const [filterApplied, setFilterApplied] = useState("");
  // true selama ketikan belum menjadi query — dipakai untuk spinner kecil di
  // kotak search, supaya jeda 300 ms tidak terasa seperti aplikasi diam.
  const queryPending =
    searchQuery !== searchApplied || filterQuery !== filterApplied;
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
  const [duplicating, setDuplicating] = useState(false);

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
  // Terpisah dari rulesError (kegagalan SAVE): ini kegagalan LOAD, yang
  // membuat seluruh editor tidak boleh dipercaya.
  const [rulesLoadError, setRulesLoadError] = useState("");

  // Import / Export State
  const [importJsonText, setImportJsonText] = useState("");
  const [importMode, setImportMode] = useState<"create" | "replace" | "merge">("create");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [ioMessage, setIoMessage] = useState("");

  // Notifikasi non-blokir (pengganti alert()) + konfirmasi delete (pengganti confirm())
  const toasts = useToasts();
  const [confirmDeleteRecord, setConfirmDeleteRecord] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [confirmDeleteCol, setConfirmDeleteCol] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      setError(e instanceof Error ? e.message : "Failed to load collections");
      return [];
    }
  }, [projectId, collectionName]);

  const loadRecords = useCallback(
    async (signal?: AbortSignal) => {
      if (!collectionName) return;
      try {
        setLoading(true);
        const data = await listRecords(projectId, collectionName, {
          search: searchApplied.trim() || undefined,
          filter: filterApplied.trim() || undefined,
          sort: sortQuery || undefined,
          page,
          perPage: 15,
          signal,
        });
        if (signal?.aborted) return;
        setResult(data);
        setSelectedIds(new Set());
        setError("");
      } catch (e) {
        // Request yang dibatalkan BUKAN kegagalan — menampilkannya sebagai
        // error akan membuat tabel berkedip merah di tiap ketikan.
        if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(errorMessage(e, "Failed to load records"));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId, collectionName, searchApplied, filterApplied, sortQuery, page]
  );

  useEffect(() => {
    loadAllCollections();
  }, [loadAllCollections]);

  // ─── Debounce: ketikan → query ────────────────────────────────────────────
  // 300 ms setelah ketikan berhenti, barulah nilai dikirim ke server. Tombol
  // "Filter" tetap berguna sebagai jalan pintas (submit = terapkan seketika).
  useEffect(() => {
    const t = setTimeout(() => {
      setSearchApplied(searchQuery);
      setFilterApplied(filterQuery);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery, filterQuery]);

  // Query berubah → kembali ke halaman 1. Tanpa ini, mempersempit pencarian
  // saat berada di halaman 5 menyisakan tabel kosong yang terlihat seperti
  // "tidak ada hasil".
  useEffect(() => {
    setPage(1);
  }, [searchApplied, filterApplied, sortQuery]);

  useEffect(() => {
    // AbortController: ketikan cepat tetap bisa menghasilkan beberapa request
    // yang tumpang tindih (debounce mengurangi, bukan meniadakan). Tanpa ini
    // respons lambat dari query LAMA bisa mendarat setelah query baru dan
    // menimpa tabel dengan hasil yang salah.
    const ac = new AbortController();
    loadRecords(ac.signal);
    return () => ac.abort();
  }, [loadRecords]);

  // Muat rules saat berpindah tab atau collection
  const loadRules = useCallback(() => {
    if (!collectionName) return;
    setRulesLoadError("");
    getRules(projectId, collectionName)
      .then((r) => {
        setRules(r);
        setRulesDraft(r);
      })
      .catch((e) => {
        // BAHAYA yang dulu ada di sini: `.catch(() => setRules(null))`.
        // rulesDraft ikut tertinggal null, dan RulesTab merender null sebagai
        // badge "Admin Only (null)" untuk KELIMA rule — collection yang
        // sebenarnya publik tampak terkunci rapat.
        //
        // Lebih buruk lagi: onRulesChange menyusun draft dari DEFAULT_RULES
        // (semua null), jadi admin yang mengubah SATU rule lalu menekan Save
        // akan diam-diam me-reset empat rule lainnya menjadi admin-only —
        // cukup untuk mematikan aplikasi produksi yang bergantung padanya.
        setRules(null);
        setRulesDraft(null);
        setRulesLoadError(errorMessage(e, "Failed to load API rules"));
      });
  }, [projectId, collectionName]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    // Submit = "terapkan SEKARANG", tanpa menunggu debounce. Menerapkan nilai
    // input langsung ke state applied sudah cukup: useEffect loadRecords
    // memicu request-nya, jadi kita tidak menembak dua kali.
    setSearchApplied(searchQuery);
    setFilterApplied(filterQuery);
    setPage(1);
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
    setDeleting(true);
    try {
      await deleteRecord(projectId, collectionName, id);
      setConfirmDeleteRecord(null);
      toasts.success("Record deleted.");
      await loadRecords();
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : "Failed to delete record");
    } finally {
      setDeleting(false);
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    setDeleting(true);
    const ids = Array.from(selectedIds);
    try {
      // Satu request untuk seluruh batch — dulu SATU HTTP request per record,
      // jadi menghapus 100 record = 100 request serial yang membekukan UI.
      // Server tetap melaporkan hasil per id (partial), jadi pesan ke user
      // tidak berubah.
      const res = await deleteRecordsBatch(projectId, collectionName, ids);
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
      if (res.failedCount === 0) {
        toasts.success(`Deleted ${res.deletedCount} records.`);
      } else {
        const reasons = [...new Set(res.failed.map((f) => f.reason))].join("; ");
        toasts.error(
          `Deleted ${res.deletedCount} of ${ids.length} records — ${res.failedCount} failed (${reasons}).`
        );
      }
    } catch (e) {
      toasts.error(errorMessage(e, "Failed to delete records"));
    } finally {
      setDeleting(false);
    }
    await loadRecords();
  }

  async function handleDeleteCollection() {
    setDeleting(true);
    try {
      await deleteCollection(projectId, collectionName);
      toasts.success(`Collection "${collectionName}" deleted.`);
      const remaining = collections.filter((c) => c.name !== collectionName);
      if (remaining.length > 0) {
        router.push(`/projects/${projectId}/database/${encodeURIComponent(remaining[0].name)}`);
      } else {
        router.push(`/projects/${projectId}/database`);
      }
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : "Failed to delete collection");
      setDeleting(false);
    }
  }

  async function handleDuplicateCollection() {
    if (!duplicateName.trim()) return;
    // Duplicate collection besar (withData) membaca + menulis ulang SELURUH
    // table — bisa berjalan detik. Tanpa disabled, double-click memulai dua
    // duplikasi (yang kedua gagal karena nama sudah dipakai).
    setDuplicating(true);
    try {
      await duplicateCollection(projectId, collectionName, duplicateName.trim(), duplicateWithData);
      setShowDuplicateCol(false);
      toasts.success("Collection duplicated.");
      const target = duplicateName.trim();
      setDuplicateName("");
      await loadAllCollections();
      router.push(`/projects/${projectId}/database/${encodeURIComponent(target)}`);
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : "Failed to duplicate collection");
    } finally {
      setDuplicating(false);
    }
  }

  async function handleExportJson() {
    // Export collection besar bisa lama; tanpa disabled, klik berulang
    // memulai beberapa export paralel (masing-masing membaca SELURUH table).
    setExporting(true);
    try {
      const json = await exportCollection(projectId, collectionName);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${collectionName}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
      toasts.success(`Exported ${collectionName} as JSON.`);
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : "Failed to export data");
    } finally {
      setExporting(false);
    }
  }

  async function handleImportJson() {
    if (!importJsonText.trim()) return;
    setImporting(true);
    setIoMessage("");
    try {
      const parsed = JSON.parse(importJsonText);
      const res = await importCollection(projectId, parsed, importMode);
      setIoMessage(`Successfully imported ${res.recordCount} records!`);
      setImportJsonText("");
      await loadRecords();
      await loadAllCollections();
    } catch (e) {
      setIoMessage(e instanceof Error ? e.message : "Failed to import JSON");
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
      toasts.success("API Rules updated successfully!");
    } catch (e) {
      setRulesError(e instanceof Error ? e.message : "Failed to save rules");
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
      toasts.success("Schema & indexes updated successfully via Table Rebuild!");
      await loadAllCollections();
      await loadRecords();
    } catch (e) {
      setSchemaError(e instanceof Error ? e.message : "Failed to update schema");
    } finally {
      setSchemaSaving(false);
    }
  }

  const filteredCollections = collections.filter((c) =>
    c.name.toLowerCase().includes(colFilter.toLowerCase())
  );
  const isView = collection?.type === "view";

  return (
    <>
      <Navbar projectId={projectId} />
      <div className="flex min-h-[calc(100vh-61px)] px-5 py-5 gap-5 items-stretch">
        {/* ─── GLOBAL PROJECT SIDEBAR ─── */}
        <ProjectSidebar projectId={projectId} />

        {/* ─── SIDEBAR MASTER COLLECTIONS (Bisa di-collapse untuk menghemat ruang) ─── */}
        <StudioSidebar
          projectId={projectId}
          collectionName={collectionName}
          collections={collections}
          colFilter={colFilter}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onColFilterChange={setColFilter}
          onNewCollection={() => setShowNewCol(true)}
        />

        {/* ─── MAIN CONTENT STUDIO (Membentang penuh mengisi tinggi viewport) ─── */}
        <main className="flex-1 min-w-0 bg-card border border-border rounded-xl p-6 min-h-[calc(100vh-101px)] flex flex-col">
          {/* Header Koleksi */}
          <div className="flex justify-between items-center mb-5 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center border border-border shrink-0">
                {collection?.type === "view" ? (
                  <Eye className="w-5 h-5 text-purple-400" />
                ) : collection?.type === "auth" ? (
                  <Users className="w-5 h-5 text-emerald-400" />
                ) : (
                  <Database className="w-5 h-5 text-foreground" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl sm:text-2xl font-semibold tracking-tight m-0">{collectionName}</h1>
                  <Badge
                    variant={
                      collection?.type === "view"
                        ? "purple"
                        : collection?.type === "auth"
                        ? "green"
                        : "outline"
                    }
                  >
                    {collection?.type === "view"
                      ? "SQL View"
                      : collection?.type === "auth"
                      ? "Auth Collection"
                      : "Base Collection"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                  {collection?.fields.length ?? 0} fields · {collection?.recordCount ?? 0} records
                </p>
              </div>
            </div>

            {/* Aksi Koleksi — diringkas ke DropdownMenu (⋯) agar tidak mempolusi tampilan harian */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" className="h-8 w-8 p-0" title="Collection options">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={() => {
                    setDuplicateName(`${collectionName}_copy`);
                    setShowDuplicateCol(true);
                  }}
                  className="gap-2 cursor-pointer text-xs"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Duplicate Collection</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleExportJson}
                  disabled={exporting}
                  className="gap-2 cursor-pointer text-xs"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export as JSON</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setConfirmDeleteCol(true)}
                  className="gap-2 text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer text-xs"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Collection</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>


        {/* Konfirmasi delete collection — sabuk ketik nama (aksi paling berbahaya) */}
        {confirmDeleteCol && (
          <ConfirmDelete
            title={`Delete collection "${collectionName}" permanently?`}
            description={`All ${collection?.recordCount ?? 0} records and their files will be lost. This cannot be undone.`}
            requireTyped={collectionName}
            confirmLabel="Delete Collection"
            busy={deleting}
            onConfirm={handleDeleteCollection}
            onCancel={() => setConfirmDeleteCol(false)}
          />
        )}

        {/* Konfirmasi delete satu record */}
        {confirmDeleteRecord && (
          <ConfirmDelete
            title="Delete this record?"
            description="This record will be permanently removed and cannot be recovered."
            confirmLabel="Delete Record"
            busy={deleting}
            onConfirm={() => handleDeleteRecord(confirmDeleteRecord)}
            onCancel={() => setConfirmDeleteRecord(null)}
          />
        )}

        {/* Konfirmasi bulk delete */}
        {confirmBulkDelete && (
          <ConfirmDelete
            title={`Delete ${selectedIds.size} selected records?`}
            description="Selected records will be permanently removed. Records that fail to delete remain in the table and are reported."
            confirmLabel={`Delete ${selectedIds.size} Records`}
            busy={deleting}
            onConfirm={handleBulkDelete}
            onCancel={() => setConfirmBulkDelete(false)}
          />
        )}

        {/* Studio Sub-Tabs */}
        <StudioTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          recordCount={result?.totalItems ?? 0}
          fieldCount={collection?.fields.length ?? 0}
        />

        {error && <div className="text-destructive text-sm font-medium mb-4">{error}</div>}

        {/* ─── TAB CONTENT (Membentang penuh mengisi tinggi viewport) ─── */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* ─── TAB 1: RECORDS (DATA BROWSER) ─── */}
          {activeTab === "records" && (
            <RecordsTab
              projectId={projectId}
              collectionName={collectionName}
              collection={collection}
              result={result}
              loading={loading}
              error={error}
              searchQuery={searchQuery}
              filterQuery={filterQuery}
              queryPending={queryPending}
              sortQuery={sortQuery}
              page={page}
              selectedIds={selectedIds}
              isView={isView}
              onSearchSubmit={handleSearch}
              onSearchChange={setSearchQuery}
              onFilterChange={setFilterQuery}
              onSortChange={setSortQuery}
              onPageChange={setPage}
              onSelectAll={(checked) => {
                if (checked && result) {
                  setSelectedIds(new Set(result.items.map((it) => String(it.id))));
                } else {
                  setSelectedIds(new Set());
                }
              }}
              onToggleRow={handleToggleRow}
              onNewRecord={() => {
                setEditingRecord(null);
                setShowNewRecord(true);
              }}
              onEditRecord={(row) => {
                setEditingRecord(row);
                setShowNewRecord(true);
              }}
              onDuplicateRecord={(row) => {
                const clone = { ...row };
                delete clone.id;
                delete clone.created;
                delete clone.updated;
                setEditingRecord(clone);
                setShowNewRecord(true);
              }}
              onDeleteRecord={(id) => setConfirmDeleteRecord(id)}
              onBulkDelete={() => setConfirmBulkDelete(true)}
              onViewJson={setRawJsonView}
              renderCell={(props) => <RenderTableCell {...props} />}
            />
          )}

          {/* ─── TAB 2: SCHEMA & FIELDS (OR VIEW QUERY) ─── */}
          {activeTab === "schema" && (
            <SchemaTab
              projectId={projectId}
              collectionName={collectionName}
              collection={collection}
              collections={collections}
              isView={isView}
              fieldsDraft={fieldsDraft}
              indexesDraft={indexesDraft}
              schemaSaving={schemaSaving}
              schemaError={schemaError}
              onFieldsChange={setFieldsDraft}
              onIndexesChange={setIndexesDraft}
              onSaveSchema={handleSaveSchema}
            />
          )}

          {/* ─── TAB 3: API RULES ─── */}
          {activeTab === "rules" && (
            <RulesTab
              rulesDraft={rulesDraft}
              rulesSaving={rulesSaving}
              rulesError={rulesError}
              rulesLoadError={rulesLoadError}
              onRetryLoad={loadRules}
              onRulesChange={setRulesDraft}
              onSaveRules={handleSaveRules}
            />
          )}

          {/* ─── TAB 4: AGGREGATIONS (M19) ─── */}
          {activeTab === "agg" && collection && (
            <AggregatePanel
              projectId={projectId}
              collection={collection}
              initialFilter={filterQuery}
            />
          )}

          {/* ─── TAB 5: EXPORT / IMPORT ─── */}
          {activeTab === "io" && (
            <ImportExportTab
              collectionName={collectionName}
              importMode={importMode}
              importJsonText={importJsonText}
              importing={importing}
              ioMessage={ioMessage}
              onImportModeChange={setImportMode}
              onImportJsonChange={setImportJsonText}
              onExport={handleExportJson}
              onImport={handleImportJson}
            />
          )}
        </div>
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
      <RawJsonModal data={rawJsonView} onClose={() => setRawJsonView(null)} />

      {/* ─── MODAL: DUPLICATE COLLECTION ─── */}
      <DuplicateModal
        open={showDuplicateCol}
        collectionName={collectionName}
        duplicateName={duplicateName}
        duplicateWithData={duplicateWithData}
      busy={duplicating}
        onNameChange={setDuplicateName}
        onWithDataChange={setDuplicateWithData}
        onCancel={() => setShowDuplicateCol(false)}
        onDuplicate={handleDuplicateCollection}
      />

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

      {/* Toast notifications (pengganti alert()) */}
      <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
    </>
  );
}

// ─── END OF PAGE ───
