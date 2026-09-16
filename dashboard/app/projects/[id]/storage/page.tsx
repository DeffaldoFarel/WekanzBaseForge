"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  listStorageFiles,
  deleteStorageFile,
  cleanOrphanedStorageFiles,
  fileUrl,
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
} from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export default function StorageExplorerPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [files, setFiles] = useState<StoredFileInfo[]>([]);
  const [stats, setStats] = useState<StorageStats>({ totalFiles: 0, totalSize: 0, orphanedCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Filter & Search State
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "images" | "documents" | "media" | "orphaned">("all");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

  // Modal Preview
  const [previewFile, setPreviewFile] = useState<StoredFileInfo | null>(null);
  const [cleaning, setCleaning] = useState(false);

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
    if (!confirm(`Permanently delete file "${file.name}" from disk?`)) return;
    try {
      await deleteStorageFile(projectId, file.recordId, file.name);
      setNotice(`File "${file.name}" was deleted successfully.`);
      setTimeout(() => setNotice(""), 4000);
      loadFiles();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete file");
    }
  }

  async function handleCleanOrphans() {
    if (!confirm(`Clean all ${stats.orphanedCount} orphaned files whose records no longer exist in the database?`)) return;
    setCleaning(true);
    try {
      const res = await cleanOrphanedStorageFiles(projectId);
      alert(`Successfully cleaned ${res.cleaned} orphaned files from disk!`);
      loadFiles();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to clean orphaned files");
    } finally {
      setCleaning(false);
    }
  }

  function copyFileUrl(file: StoredFileInfo) {
    if (!file.collectionName) {
      alert("This file is not linked to any active collection.");
      return;
    }
    const url = fileUrl(projectId, file.collectionName, file.recordId, file.name);
    navigator.clipboard.writeText(url);
    setNotice("File URL copied to clipboard!");
    setTimeout(() => setNotice(""), 3000);
  }

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
      if (typeFilter === "orphaned") return f.isOrphaned;

      return true;
    });
  }, [files, search, typeFilter]);

  const imageCount = useMemo(() => files.filter((f) => f.isImage).length, [files]);

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
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2.5">
              <HardDrive className="w-7 h-7 text-slate-800" />
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
                onClick={handleCleanOrphans}
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

        {notice && (
          <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200/80 text-emerald-800 text-xs font-semibold mb-6 flex items-center gap-2 shadow-sm">
            <Check className="w-4 h-4 text-emerald-600" />
            <span>{notice}</span>
          </div>
        )}

        {error && (
          <div className="p-3.5 rounded-2xl bg-destructive/10 border border-destructive/20 text-destructive text-xs font-semibold mb-6 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        {/* Metric Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <Card className="p-5 rounded-[22px]">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <Package className="w-4 h-4 text-slate-400" />
              <span>Total Files</span>
            </div>
            <div className="text-2xl font-extrabold text-foreground mt-2">
              {stats.totalFiles}
            </div>
          </Card>

          <Card className="p-5 rounded-[22px]">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <HardDrive className="w-4 h-4 text-brand-blue" />
              <span>Storage Used</span>
            </div>
            <div className="text-2xl font-extrabold text-brand-blue mt-2">
              {formatBytes(stats.totalSize)}
            </div>
          </Card>

          <Card className="p-5 rounded-[22px]">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <ImageIcon className="w-4 h-4 text-emerald-600" />
              <span>Image Files</span>
            </div>
            <div className="text-2xl font-extrabold text-emerald-700 mt-2">
              {imageCount}
            </div>
          </Card>

          <Card className="p-5 rounded-[22px]">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <AlertTriangle className={`w-4 h-4 ${stats.orphanedCount > 0 ? "text-destructive" : "text-slate-400"}`} />
              <span>Orphaned Files</span>
            </div>
            <div className={`text-2xl font-extrabold mt-2 ${stats.orphanedCount > 0 ? "text-destructive" : "text-foreground"}`}>
              {stats.orphanedCount}
            </div>
          </Card>
        </div>

        {/* Toolbar: Search, Filters, View Modes */}
        <Card className="p-3 mb-6 flex flex-col md:flex-row justify-between items-center gap-3 rounded-[22px]">
          <div className="relative flex-1 w-full">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-10 h-10 border-slate-200"
              placeholder="Search by filename, record ID, or collection..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto overflow-x-auto pb-1 md:pb-0">
            {/* Filter Pills */}
            <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-full border border-border">
              {[
                { id: "all", label: "All" },
                { id: "images", label: "Images" },
                { id: "documents", label: "Documents" },
                { id: "media", label: "Media" },
                ...(stats.orphanedCount > 0 ? [{ id: "orphaned", label: `Orphaned (${stats.orphanedCount})` }] : []),
              ].map((t) => {
                const active = typeFilter === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTypeFilter(t.id as typeof typeFilter)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold transition-all whitespace-nowrap ${
                      active
                        ? "bg-primary text-primary-foreground shadow-pill"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* View Mode Toggle */}
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-full border border-border shrink-0">
              <button
                onClick={() => setViewMode("grid")}
                className={`p-1.5 rounded-full transition-all ${
                  viewMode === "grid" ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
                title="Grid View"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode("table")}
                className={`p-1.5 rounded-full transition-all ${
                  viewMode === "table" ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
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
          <Card className="py-20 text-center rounded-[24px]">
            <RefreshCw className="w-8 h-8 animate-spin mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Scanning storage disk...</p>
          </Card>
        ) : filteredFiles.length === 0 ? (
          <Card className="py-20 text-center rounded-[28px]">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4 border border-border">
              <FolderOpen className="w-8 h-8 text-slate-400" />
            </div>
            <h3 className="text-lg font-bold text-foreground">No Files Found</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto mt-1">
              {files.length === 0
                ? "No files have been uploaded to this project yet. Upload files via the database record form."
                : "No files match your search keyword or active filters."}
            </p>
          </Card>
        ) : viewMode === "grid" ? (
          /* Grid View */
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredFiles.map((file) => {
              const fileDirectUrl = file.collectionName
                ? fileUrl(projectId, file.collectionName, file.recordId, file.name)
                : null;
              const thumbUrl = file.isImage && file.collectionName
                ? `${fileDirectUrl}?thumb=200x200`
                : null;

              return (
                <Card
                  key={file.storedName}
                  className={`p-3.5 rounded-[22px] flex flex-col justify-between hover:shadow-lg transition-all ${
                    file.isOrphaned ? "border-dashed border-destructive/50 bg-red-50/20" : "bg-white"
                  }`}
                >
                  {/* Thumbnail Container */}
                  <div
                    onClick={() => setPreviewFile(file)}
                    className="h-36 rounded-2xl bg-slate-100 flex items-center justify-center cursor-pointer overflow-hidden relative group border border-slate-100"
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
                      <div className="flex flex-col items-center gap-1 text-slate-400 group-hover:text-slate-600 transition-colors">
                        {file.isImage ? (
                          <ImageIcon className="w-10 h-10" />
                        ) : file.mime.includes("pdf") ? (
                          <FileText className="w-10 h-10 text-rose-500" />
                        ) : file.mime.includes("audio") ? (
                          <Music className="w-10 h-10 text-amber-500" />
                        ) : file.mime.includes("video") ? (
                          <Film className="w-10 h-10 text-violet-500" />
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

                    <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <span className="bg-white/95 text-foreground px-3 py-1 rounded-full text-xs font-semibold shadow-sm flex items-center gap-1">
                        <Eye className="w-3.5 h-3.5" />
                        View
                      </span>
                    </div>
                  </div>

                  {/* File Info */}
                  <div className="mt-3 px-1">
                    <div className="font-semibold text-xs text-foreground truncate" title={file.name}>
                      {file.name}
                    </div>
                    <div className="flex justify-between items-center text-[11px] text-muted-foreground mt-1 font-medium">
                      <span>{formatBytes(file.size)}</span>
                      <Badge variant="secondary" className="text-[10px] py-0 px-2 font-mono">
                        {file.collectionName ?? "unlinked"}
                      </Badge>
                    </div>
                  </div>

                  {/* Action Icons */}
                  <div className="flex items-center gap-1.5 mt-3 pt-2.5 border-t border-slate-100">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPreviewFile(file)}
                      className="h-8 flex-1 rounded-full px-0"
                      title="Preview"
                    >
                      <Eye className="w-3.5 h-3.5 text-slate-600" />
                    </Button>
                    {fileDirectUrl && (
                      <>
                        <a
                          href={fileDirectUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="h-8 flex-1 rounded-full inline-flex items-center justify-center hover:bg-slate-100 text-slate-600 transition-colors"
                          title="Download file"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyFileUrl(file)}
                          className="h-8 flex-1 rounded-full px-0"
                          title="Copy file URL"
                        >
                          <Copy className="w-3.5 h-3.5 text-slate-600" />
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(file)}
                      className="h-8 flex-1 rounded-full px-0 text-destructive hover:text-destructive hover:bg-destructive/10"
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
          <Card className="overflow-hidden rounded-[24px] p-0 border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-border text-slate-500 font-semibold uppercase tracking-wider">
                    <th className="p-3.5 pl-5">File Name</th>
                    <th className="p-3.5">Size</th>
                    <th className="p-3.5">MIME Type</th>
                    <th className="p-3.5">Collection</th>
                    <th className="p-3.5">Record ID</th>
                    <th className="p-3.5">Status</th>
                    <th className="p-3.5 pr-5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {filteredFiles.map((file) => {
                    const fileDirectUrl = file.collectionName
                      ? fileUrl(projectId, file.collectionName, file.recordId, file.name)
                      : null;

                    return (
                      <tr key={file.storedName} className="hover:bg-slate-50/80 transition-colors font-sans">
                        <td className="p-3.5 pl-5 font-semibold text-foreground flex items-center gap-2">
                          {file.isImage ? (
                            <ImageIcon className="w-4 h-4 text-brand-blue" />
                          ) : (
                            <FileText className="w-4 h-4 text-slate-500" />
                          )}
                          <span className="truncate max-w-[200px]" title={file.name}>
                            {file.name}
                          </span>
                        </td>
                        <td className="p-3.5 text-muted-foreground font-mono">{formatBytes(file.size)}</td>
                        <td className="p-3.5 text-muted-foreground">{file.mime}</td>
                        <td className="p-3.5">
                          <Badge variant="secondary" className="text-[10px] font-mono">
                            {file.collectionName ?? "—"}
                          </Badge>
                        </td>
                        <td className="p-3.5 font-mono text-[11px] text-muted-foreground">{file.recordId}</td>
                        <td className="p-3.5">
                          {file.isOrphaned ? (
                            <Badge variant="destructive" className="text-[10px]">Orphaned</Badge>
                          ) : (
                            <Badge variant="green" className="text-[10px]">Connected</Badge>
                          )}
                        </td>
                        <td className="p-3.5 pr-5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => setPreviewFile(file)}
                              title="View"
                            >
                              <Eye className="w-3.5 h-3.5 text-slate-600" />
                            </Button>
                            {fileDirectUrl && (
                              <>
                                <a
                                  href={fileDirectUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-600"
                                  title="Download"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </a>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => copyFileUrl(file)}
                                  title="Copy URL"
                                >
                                  <Copy className="w-3.5 h-3.5 text-slate-600" />
                                </Button>
                              </>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:bg-destructive/10"
                              onClick={() => handleDelete(file)}
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

        {/* Modal File Preview with shadcn Dialog */}
        <Dialog open={previewFile !== null} onOpenChange={(open: boolean) => !open && setPreviewFile(null)}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="text-base font-bold truncate pr-6">
                {previewFile?.name}
              </DialogTitle>
            </DialogHeader>

            {previewFile && (
              <div className="space-y-4">
                {/* Media Render Preview */}
                <div className="bg-slate-100 rounded-2xl p-4 flex items-center justify-center min-h-[200px] border border-border overflow-hidden">
                  {previewFile.isImage && previewFile.collectionName ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={fileUrl(projectId, previewFile.collectionName, previewFile.recordId, previewFile.name)}
                      alt={previewFile.name}
                      className="max-h-[340px] max-w-full rounded-lg object-contain shadow-sm"
                    />
                  ) : previewFile.mime.includes("audio") && previewFile.collectionName ? (
                    <audio
                      controls
                      src={fileUrl(projectId, previewFile.collectionName, previewFile.recordId, previewFile.name)}
                      className="w-full"
                    />
                  ) : previewFile.mime.includes("video") && previewFile.collectionName ? (
                    <video
                      controls
                      src={fileUrl(projectId, previewFile.collectionName, previewFile.recordId, previewFile.name)}
                      className="max-h-[300px] max-w-full rounded-lg"
                    />
                  ) : (
                    <div className="text-center py-6">
                      <FileText className="w-16 h-16 mx-auto text-slate-400 mb-2" />
                      <p className="text-xs text-muted-foreground font-medium">Visual preview not available for this file type</p>
                    </div>
                  )}
                </div>

                {/* Metadata Details */}
                <div className="grid grid-cols-2 gap-3 text-xs bg-slate-50 p-4 rounded-2xl border border-border">
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
                    <span className="font-semibold text-foreground">{previewFile.collectionName ?? "— (Orphaned)"}</span>
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
                      handleDelete(f);
                    }}
                    className="gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete File</span>
                  </Button>

                  <div className="flex items-center gap-2">
                    {previewFile.collectionName && (
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
                          href={fileUrl(projectId, previewFile.collectionName, previewFile.recordId, previewFile.name)}
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
    </>
  );
}
