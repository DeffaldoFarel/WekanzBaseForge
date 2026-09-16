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
  const [activeTab, setActiveTab] = useState<"records" | "schema" | "rules" | "agg" | "io">("records");

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
      setError(e instanceof Error ? e.message : "Failed to load collections");
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
      setError(e instanceof Error ? e.message : "Failed to load records");
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
    if (!confirm("Delete this record?")) return;
    try {
      await deleteRecord(projectId, collectionName, id);
      await loadRecords();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete record");
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} selected records?`)) return;
    try {
      for (const id of Array.from(selectedIds)) {
        await deleteRecord(projectId, collectionName, id);
      }
      setSelectedIds(new Set());
      await loadRecords();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete records");
    }
  }

  async function handleDeleteCollection() {
    if (!confirm(`PERMANENTLY DELETE COLLECTION "${collectionName}" AND ALL ITS DATA & FILES?`)) return;
    try {
      await deleteCollection(projectId, collectionName);
      const remaining = collections.filter((c) => c.name !== collectionName);
      if (remaining.length > 0) {
        router.push(`/projects/${projectId}/database/${encodeURIComponent(remaining[0].name)}`);
      } else {
        router.push(`/projects/${projectId}/database`);
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete collection");
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
      alert(e instanceof Error ? e.message : "Failed to duplicate collection");
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
      alert(e instanceof Error ? e.message : "Failed to export data");
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
      alert("API Rules updated successfully!");
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
      alert("Schema & indexes updated successfully via Table Rebuild!");
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
      <div className="flex min-h-[calc(100vh-60px)] p-5 gap-5 items-start">
        {/* ─── GLOBAL PROJECT SIDEBAR ─── */}
        <ProjectSidebar projectId={projectId} />

        {/* ─── SIDEBAR MASTER COLLECTIONS ─── */}
        <StudioSidebar
          projectId={projectId}
          collectionName={collectionName}
          collections={collections}
          colFilter={colFilter}
          onColFilterChange={setColFilter}
          onNewCollection={() => setShowNewCol(true)}
        />

      {/* ─── MAIN CONTENT STUDIO ─── */}
      <main className="flex-1 bg-card border border-border rounded-3xl p-7 shadow-soft overflow-x-auto">
        {/* Header Koleksi */}
        <div className="flex justify-between items-start mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-secondary flex items-center justify-center border border-border">
              {collection?.type === "view" ? (
                <Eye className="w-5 h-5 text-purple-600" />
              ) : collection?.type === "auth" ? (
                <Users className="w-5 h-5 text-emerald-600" />
              ) : (
                <Database className="w-5 h-5 text-foreground" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold m-0">{collectionName}</h1>
                <Badge
                  variant={
                    collection?.type === "view"
                      ? "secondary"
                      : collection?.type === "auth"
                      ? "default"
                      : "outline"
                  }
                  className={
                    collection?.type === "view"
                      ? "bg-purple-100 text-purple-700 border-purple-200"
                      : collection?.type === "auth"
                      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                      : ""
                  }
                >
                  {collection?.type === "view"
                    ? "SQL View"
                    : collection?.type === "auth"
                    ? "Auth Collection"
                    : "Base Collection"}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                {collection?.fields.length ?? 0} fields · {collection?.recordCount ?? 0} records
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setDuplicateName(`${collectionName}_copy`);
                setShowDuplicateCol(true);
              }}
              title="Duplikasi struktur atau data collection ini"
            >
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              Duplicate
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleExportJson}
              title="Download backup JSON"
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Export JSON
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteCollection}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              Delete
            </Button>
          </div>
        </div>

        {/* Studio Sub-Tabs */}
        <StudioTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          recordCount={result?.totalItems ?? 0}
          fieldCount={collection?.fields.length ?? 0}
        />

        {error && <div className="text-destructive text-sm font-medium mb-4">{error}</div>}

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
            onDeleteRecord={handleDeleteRecord}
            onBulkDelete={handleBulkDelete}
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
    </div>
    </>
  );
}

// ─── END OF PAGE ───
