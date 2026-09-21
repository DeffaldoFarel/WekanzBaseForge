"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  listStorageFiles,
  deleteStorageFile,
  deleteBucketFile,
  cleanOrphanedStorageFiles,
  fileUrl,
  bucketFileUrl,
  type StoredFileInfo,
  type StorageStats,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import { useToasts, ToastHost } from "@/components/ui/toast";
import {
  HardDrive,
  FileText,
  Image as ImageIcon,
  Music,
  Film,
  Package,
  Trash2,
  Download,
  Copy,
  ExternalLink,
  LayoutGrid,
  List,
  AlertTriangle,
  RefreshCw,
  Search,
  Eye,
  Check,
  FolderOpen,
  Box,
} from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/** Render media di modal preview — image/audio/video untuk record & bucket file. */
function MediaPreview({ projectId, file }: { projectId: string; file: StoredFileInfo }) {
  const url = file.isBucket
    ? bucketFileUrl(projectId, file.recordId)
    : file.collectionName
      ? fileUrl(projectId, file.collectionName, file.recordId, file.name)
      : null;

  if (!url) {
    return (
      <div className="text-center py-6">
        <FileText className="w-16 h-16 mx-auto text-muted-foreground mb-2" />
        <p className="text-xs text-muted-foreground font-medium">No URL available (orphaned, unlinked file)</p>
      </div>
    );
  }

  if (file.isImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={file.name}
        className="max-h-[340px] max-w-full rounded-lg object-contain shadow-sm"
      />
    );
  }
  if (file.mime.includes("audio")) {
    return <audio controls src={url} className="w-full" />;
  }
  if (file.mime.includes("video")) {
    return <video controls src={url} className="max-h-[300px] max-w-full rounded-lg" />;
  }
  return (
    <div className="text-center py-6">
      <FileText className="w-16 h-16 mx-auto text-muted-foreground mb-2" />
      <p className="text-xs text-muted-foreground font-medium">Visual preview not available for this file type</p>
    </div>
  );
}

export default function StorageExplorerPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [files, setFiles] = useState<StoredFileInfo[]>([]);
  const [stats, setStats] = useState<StorageStats>({ totalFiles: 0, totalSize: 0, orphanedCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filter & Search State
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<
    "all" | "images" | "documents" | "media" | "bucket" | "orphaned"
  >("all");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  // Paginasi client: me-render SELURUH file sekaligus membuat browser
  // memproses ribuan node DOM (dan — untuk gambar — ribuan request
  // thumbnail). Filter & sort tetap atas semua file di memori; yang dibatasi
  // hanya yang dirender.
  const [page, setPage] = useState(1);

  // Modal Preview
  const [previewFile, setPreviewFile] = useState<StoredFileInfo | null>(null);
  const [cleaning, setCleaning] = useState(false);

  // Konfirmasi inline (menggantikan confirm() native)
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<StoredFileInfo | null>(null);
  const [confirmClean, setConfirmClean] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState("");

  // Toast (menggantikan alert() native)
  const { toasts, success: toastSuccess, error: toastError, dismiss: dismissToast } = useToasts();

  // URL file untuk semua aksi UI — dispatcher bucket vs record.
  // File bucket (M35) dilayani lewat /api/files/:pid/bucket/:fileId; file record
  // lewat /api/files/:pid/:collection/:recordId/:filename. Dulu halaman ini
  // hanya tahu jalur record → bucket file tidak bisa di-preview/copy URL.
  const uiFileUrl = useCallback(
    (file: StoredFileInfo): string | null =>
      file.isBucket
        ? bucketFileUrl(projectId, file.recordId)
        : file.collectionName
          ? fileUrl(projectId, file.collectionName, file.recordId, file.name)
          : null,
    [projectId]
  );

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await listStorageFiles(projectId);
      setFiles(res.files);
      setStats(res.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load storage files");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  async function handleDelete(file: StoredFileInfo) {
    setActionError("");
    setDeleting(true);
    try {
      if (file.isBucket) {
        // File bucket: hapus via endpoint bucket (membersihkan metadata + disk)
        await deleteBucketFile(projectId, file.recordId);
      } else {
        await deleteStorageFile(projectId, file.recordId, file.name);
      }
      toastSuccess(`File "${file.name}" deleted from disk.`);
      setConfirmDeleteFile(null);
      loadFiles();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete file";
      setActionError(msg);
      toastError(msg);
    } finally {
      setDeleting(false);
    }
  }

  async function handleCleanOrphans() {
    setConfirmClean(false);
    setActionError("");
    setCleaning(true);
    try {
      const res = await cleanOrphanedStorageFiles(projectId);
      toastSuccess(`Cleaned ${res.cleaned} orphaned file${res.cleaned === 1 ? "" : "s"} from disk.`);
      loadFiles();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to clean orphaned files";
      setActionError(msg);
      toastError(msg);
    } finally {
      setCleaning(false);
    }
  }

  function copyFileUrl(file: StoredFileInfo) {
    const url = uiFileUrl(file);
    if (!url) {
      toastError("This file is not linked to any active collection.");
      return;
    }
    navigator.clipboard.writeText(url);
    toastSuccess("File URL copied to clipboard!");
  }

  // Filter berubah → kembali ke halaman 1 (menghindari "terdampar di halaman
  // kosong" saat hasil menyempit).
  useEffect(() => {
    setPage(1);
  }, [search, typeFilter]);

  // Filtered files memo
  const filteredFiles = useMemo(() => {
    return files.filter((f) => {
      const matchesSearch =
        f.name.toLowerCase().includes(search.toLowerCase()) ||
        f.recordId.toLowerCase().includes(search.toLowerCase()) ||
        (f.collectionName && f.collectionName.toLowerCase().includes(search.toLowerCase()));

      if (!matchesSearch) return false;

      if (typeFilter === "images") return f.isImage;
      if (typeFilter === "documents") {
        return f.mime.includes("pdf") || f.mime.includes("text") || f.mime.includes("json") || f.mime.includes("csv");
      }
      if (typeFilter === "media") {
        return f.mime.includes("audio") || f.mime.includes("video");
      }
      if (typeFilter === "bucket") return !!f.isBucket;
      if (typeFilter === "orphaned") return f.isOrphaned;

      return true;
    });
  }, [files, search, typeFilter]);

  const imageCount = useMemo(() => files.filter((f) => f.isImage).length, [files]);
  const bucketCount = useMemo(() => files.filter((f) => f.isBucket).length, [files]);

  // ─── Paginasi atas hasil filter ───────────────────────────────────────────
  // PerPage dipilih habis dibagi lebar grid (1/2/3/4 kolom) supaya baris
  // terakhir tidak pernah timpang di semua breakpoint.
  const PER_PAGE = 24;
  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / PER_PAGE));
  const safePage = Math.min(page, totalPages); // filter menyempit → jepit
  const pagedFiles = useMemo(
    () => filteredFiles.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE),
    [filteredFiles, safePage]
  );

  return (
    <>
      <Navbar projectId={projectId} />

      <div className="max-w-[1400px] mx-auto px-6 py-6 flex gap-6 items-start">
        {/* ─── PROJECT SIDEBAR ─── */}
        <ProjectSidebar projectId={projectId} />

        {/* ─── MAIN CONTENT ─── */}
        <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header Navigation */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground flex items-center gap-2.5">
              <HardDrive className="w-7 h-7 text-foreground" />
              <span>Storage Explorer</span>
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1">
              Manage physical files, image thumbnail caching, and automated orphaned files cleanup on project disk.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {stats.orphanedCount > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmClean(true)}
                disabled={cleaning}
                className="gap-1.5"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Clean {stats.orphanedCount} Orphaned {stats.orphanedCount === 1 ? "File" : "Files"}</span>
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={loadFiles}
              disabled={loading}
              className="gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </Button>
          </div>
        </div>

        {confirmClean && (
          <ConfirmDelete
            title={`Clean ${stats.orphanedCount} orphaned file${stats.orphanedCount === 1 ? "" : "s"}?`}
            description={
              stats.orphanedCount > 0
                ? "Files whose parent records no longer exist in the database will be permanently deleted from disk. Bucket files are protected and will not be touched."
                : undefined
            }
            confirmLabel="Clean Orphans"
            busy={cleaning}
            error={actionError}
            onConfirm={handleCleanOrphans}
            onCancel={() => { setConfirmClean(false); setActionError(""); }}
          />
        )}

        {confirmDeleteFile && (
          <ConfirmDelete
            title={`Delete "${confirmDeleteFile.name}"?`}
            description={
              confirmDeleteFile.isBucket
                ? "This is a bucket file (public URL /api/files/…/bucket/…). Deleting it permanently removes the file and its metadata — any app still referencing its URL will break."
                : `The physical file will be permanently deleted from disk.${
                    confirmDeleteFile.collectionName
                      ? " The record that references this file stays in the database (its file field will point to a missing file)."
                      : ""
                  }`
            }
            confirmLabel="Delete File"
            busy={deleting}
            error={actionError}
            onConfirm={() => handleDelete(confirmDeleteFile)}
            onCancel={() => { setConfirmDeleteFile(null); setActionError(""); }}
          />
        )}

        {error && (
          <div className="p-3.5 rounded-lg bg-destructive/10 border border-destructive/40 text-destructive text-xs font-medium mb-6 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        {/* Metric Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <Card className="p-5">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <Package className="w-4 h-4" />
              <span>Total Files</span>
            </div>
            <div className="text-2xl font-semibold text-foreground mt-2">
              {stats.totalFiles}
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <HardDrive className="w-4 h-4" />
              <span>Storage Used</span>
            </div>
            <div className="text-2xl font-semibold text-foreground mt-2">
              {formatBytes(stats.totalSize)}
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <ImageIcon className="w-4 h-4" />
              <span>Image Files</span>
            </div>
            <div className="text-2xl font-semibold text-foreground mt-2">
              {imageCount}
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <Box className="w-4 h-4" />
              <span>Bucket Files</span>
            </div>
            <div className="text-2xl font-semibold text-foreground mt-2">
              {bucketCount}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Decoupled files with stable public URL
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <AlertTriangle className={`w-4 h-4 ${stats.orphanedCount > 0 ? "text-destructive" : ""}`} />
              <span>Orphaned Files</span>
            </div>
            <div className={`text-2xl font-semibold mt-2 ${stats.orphanedCount > 0 ? "text-destructive" : "text-foreground"}`}>
              {stats.orphanedCount}
            </div>
          </Card>
        </div>

        {/* Toolbar: Search, Filters, View Modes */}
        <Card className="p-3 mb-6 flex flex-col md:flex-row justify-between items-center gap-3">
          <div className="relative flex-1 w-full">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9 h-9"
              placeholder="Search by filename, record ID, or collection..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto overflow-x-auto pb-1 md:pb-0">
            {/* Filter Segments */}
            <div className="flex items-center gap-1 bg-secondary p-1 rounded-lg border border-border">
              {[
                { id: "all", label: "All" },
                { id: "images", label: "Images" },
                { id: "documents", label: "Documents" },
                { id: "media", label: "Media" },
                ...(bucketCount > 0 ? [{ id: "bucket", label: `Bucket (${bucketCount})` }] : []),
                ...(stats.orphanedCount > 0 ? [{ id: "orphaned", label: `Orphaned (${stats.orphanedCount})` }] : []),
              ].map((t) => {
                const active = typeFilter === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTypeFilter(t.id as typeof typeFilter)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* View Mode Toggle */}
            <div className="flex items-center gap-1 bg-secondary p-1 rounded-lg border border-border shrink-0">
              <button
                onClick={() => setViewMode("grid")}
                className={`p-1.5 rounded-md transition-colors ${
                  viewMode === "grid" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                title="Grid View"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode("table")}
                className={`p-1.5 rounded-md transition-colors ${
                  viewMode === "table" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                title="Table View"
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </Card>

        {/* Files View */}
        {loading ? (
          <Card className="py-20 text-center">
            <RefreshCw className="w-8 h-8 animate-spin mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Scanning storage disk...</p>
          </Card>
        ) : filteredFiles.length === 0 ? (
          <Card className="py-20 text-center">
            <div className="w-16 h-16 rounded-lg bg-secondary flex items-center justify-center mx-auto mb-4 border border-border">
              <FolderOpen className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">No Files Found</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto mt-1">
              {files.length === 0
                ? "No files have been uploaded to this project yet. Upload files via the database record form."
                : "No files match your search keyword or active filters."}
            </p>
          </Card>
        ) : viewMode === "grid" ? (
          /* Grid View */
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {pagedFiles.map((file) => {
              const fileDirectUrl = uiFileUrl(file);
              const thumbUrl = file.isImage && fileDirectUrl
                ? `${fileDirectUrl}?thumb=200x200`
                : null;

              return (
                <Card
                  key={file.storedName}
                  className={`p-3 flex flex-col justify-between hover:border-foreground/20 transition-colors ${
                    file.isOrphaned ? "border-dashed border-destructive/50 bg-destructive/5" : ""
                  }`}
                >
                  {/* Thumbnail Container */}
                  <div
                    onClick={() => setPreviewFile(file)}
                    className="h-36 rounded-lg bg-secondary flex items-center justify-center cursor-pointer overflow-hidden relative group border border-border"
                  >
                    {thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumbUrl}
                        alt={file.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-1 text-muted-foreground group-hover:text-foreground transition-colors">
                        {file.isImage ? (
                          <ImageIcon className="w-10 h-10" />
                        ) : file.mime.includes("pdf") ? (
                          <FileText className="w-10 h-10 text-rose-400" />
                        ) : file.mime.includes("audio") ? (
                          <Music className="w-10 h-10 text-amber-400" />
                        ) : file.mime.includes("video") ? (
                          <Film className="w-10 h-10 text-violet-400" />
                        ) : (
                          <Package className="w-10 h-10" />
                        )}
                      </div>
                    )}

                    {file.isOrphaned && (
                      <Badge variant="destructive" className="absolute top-2.5 left-2.5 text-[10px] py-0 px-2">
                        Orphaned
                      </Badge>
                    )}
                    {!file.isOrphaned && file.isBucket && (
                      <Badge variant="blue" className="absolute top-2.5 left-2.5 text-[10px] py-0 px-2 gap-1">
                        <Box className="w-3 h-3" />
                        Bucket
                      </Badge>
                    )}

                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <span className="bg-background/90 text-foreground px-3 py-1 rounded-md text-xs font-medium border border-border flex items-center gap-1">
                        <Eye className="w-3.5 h-3.5" />
                        View
                      </span>
                    </div>
                  </div>

                  {/* File Info */}
                  <div className="mt-3 px-1">
                    <div className="font-medium text-xs text-foreground truncate" title={file.name}>
                      {file.name}
                    </div>
                    <div className="flex justify-between items-center text-[11px] text-muted-foreground mt-1">
                      <span>{formatBytes(file.size)}</span>
                      <Badge
                        variant={file.isBucket ? "blue" : "secondary"}
                        className="text-[10px] py-0 px-2 font-mono"
                      >
                        {file.isBucket ? "bucket" : (file.collectionName ?? "unlinked")}
                      </Badge>
                    </div>
                  </div>

                  {/* Action Icons */}
                  <div className="flex items-center gap-1 mt-3 pt-2.5 border-t border-border">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPreviewFile(file)}
                      className="h-8 flex-1 px-0 text-muted-foreground"
                      title="Preview"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </Button>
                    {fileDirectUrl && (
                      <>
                        <a
                          href={fileDirectUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="h-8 flex-1 rounded-md inline-flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                          title="Download file"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyFileUrl(file)}
                          className="h-8 flex-1 px-0 text-muted-foreground"
                          title="Copy file URL"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setActionError(""); setConfirmDeleteFile(file); }}
                      className="h-8 flex-1 px-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                      title="Delete file"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          /* Table View */
          <Card className="overflow-hidden p-0 border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-secondary border-b border-border text-muted-foreground font-medium uppercase tracking-wider">
                    <th className="p-3.5 pl-5">File Name</th>
                    <th className="p-3.5">Size</th>
                    <th className="p-3.5">MIME Type</th>
                    <th className="p-3.5">Collection</th>
                    <th className="p-3.5">Record ID</th>
                    <th className="p-3.5">Status</th>
                    <th className="p-3.5 pr-5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-mono">
                    {pagedFiles.map((file) => {

                    const fileDirectUrl = uiFileUrl(file);

                    return (
                      <tr key={file.storedName} className="hover:bg-accent/50 transition-colors font-sans">
                        <td className="p-3.5 pl-5 font-medium text-foreground flex items-center gap-2">
                          {file.isImage ? (
                            <ImageIcon className="w-4 h-4 text-foreground" />
                          ) : (
                            <FileText className="w-4 h-4 text-muted-foreground" />
                          )}
                          <span className="truncate max-w-[200px]" title={file.name}>
                            {file.name}
                          </span>
                        </td>
                        <td className="p-3.5 text-muted-foreground font-mono">{formatBytes(file.size)}</td>
                        <td className="p-3.5 text-muted-foreground">{file.mime}</td>
                        <td className="p-3.5">
                          <Badge
                            variant={file.isBucket ? "blue" : "secondary"}
                            className="text-[10px] font-mono"
                          >
                            {file.isBucket ? "bucket" : (file.collectionName ?? "—")}
                          </Badge>
                        </td>
                        <td className="p-3.5 font-mono text-[11px] text-muted-foreground">{file.recordId}</td>
                        <td className="p-3.5">
                          {file.isOrphaned ? (
                            <Badge variant="destructive" className="text-[10px]">Orphaned</Badge>
                          ) : file.isBucket ? (
                            <Badge variant="blue" className="text-[10px] gap-1">
                              <Box className="w-3 h-3" />
                              Bucket
                            </Badge>
                          ) : (
                            <Badge variant="green" className="text-[10px]">Connected</Badge>
                          )}
                        </td>
                        <td className="p-3.5 pr-5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground"
                              onClick={() => setPreviewFile(file)}
                              title="View"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </Button>
                            {fileDirectUrl && (
                              <>
                                <a
                                  href={fileDirectUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                                  title="Download"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </a>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground"
                                  onClick={() => copyFileUrl(file)}
                                  title="Copy URL"
                                >
                                  <Copy className="w-3.5 h-3.5" />
                                </Button>
                              </>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:bg-destructive/10"
                              onClick={() => { setActionError(""); setConfirmDeleteFile(file); }}
                              title="Delete"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* ─── Paginasi ─── */}
        {totalPages > 1 && (
          <nav
            aria-label="Storage pagination"
            className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-6"
          >
            <p className="text-xs text-muted-foreground">
              Showing{" "}
              <span className="text-foreground font-medium">
                {(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, filteredFiles.length)}
              </span>{" "}
              of <span className="text-foreground font-medium">{filteredFiles.length}</span> files
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="h-9 px-3"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(p - 1, 1))}
              >
                <span>Previous</span>
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums px-1">
                Page {safePage} of {totalPages}
              </span>
              <Button
                variant="outline"
                className="h-9 px-3"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
              >
                <span>Next</span>
              </Button>
            </div>
          </nav>
        )}

        {/* Modal File Preview with shadcn Dialog */}
        <Dialog open={previewFile !== null} onOpenChange={(open: boolean) => !open && setPreviewFile(null)}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold truncate pr-6">
                {previewFile?.name}
              </DialogTitle>
            </DialogHeader>

            {previewFile && (
              <div className="space-y-4">
                {/* Media Render Preview */}
                <div className="bg-secondary rounded-lg p-4 flex items-center justify-center min-h-[200px] border border-border overflow-hidden">
                  <MediaPreview projectId={projectId} file={previewFile} />
                </div>

                {/* Metadata Details */}
                <div className="grid grid-cols-2 gap-3 text-xs bg-secondary p-4 rounded-lg border border-border">
                  <div>
                    <span className="text-muted-foreground block text-[11px]">File Size</span>
                    <span className="font-semibold text-foreground font-mono">{formatBytes(previewFile.size)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">MIME Type</span>
                    <span className="font-semibold text-foreground">{previewFile.mime}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Parent Collection</span>
                    <span className="font-semibold text-foreground">
                      {previewFile.isBucket ? "— (Bucket file)" : (previewFile.collectionName ?? "— (Orphaned)")}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Parent Record ID</span>
                    <span className="font-semibold text-foreground font-mono">{previewFile.recordId}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex justify-between items-center pt-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      const f = previewFile;
                      setPreviewFile(null);
                      setActionError("");
                      setConfirmDeleteFile(f);
                    }}
                    className="gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete File</span>
                  </Button>

                  <div className="flex items-center gap-2">
                    {uiFileUrl(previewFile) && (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => copyFileUrl(previewFile)}
                          className="gap-1.5"
                        >
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy URL</span>
                        </Button>
                        <a
                          href={uiFileUrl(previewFile) ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Button size="sm" className="gap-1.5">
                            <span>Open Original</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </Button>
                        </a>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <ToastHost toasts={toasts} onDismiss={(id) => dismissToast(id)} />
    </>
  );
}
