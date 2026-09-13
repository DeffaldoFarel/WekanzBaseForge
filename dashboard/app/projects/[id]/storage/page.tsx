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
      setError(err instanceof Error ? err.message : "Gagal memuat berkas storage");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  async function handleDelete(file: StoredFileInfo) {
    if (!confirm(`Hapus berkas "${file.name}" secara permanen dari disk?`)) return;
    try {
      await deleteStorageFile(projectId, file.recordId, file.name);
      setNotice(`Berkas "${file.name}" berhasil dihapus.`);
      setTimeout(() => setNotice(""), 4000);
      loadFiles();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal menghapus berkas");
    }
  }

  async function handleCleanOrphans() {
    if (!confirm(`Bersihkan semua ${stats.orphanedCount} file yatim (orphaned) yang record-nya sudah tidak ada di database?`)) return;
    setCleaning(true);
    try {
      const res = await cleanOrphanedStorageFiles(projectId);
      alert(`Berhasil membersihkan ${res.cleaned} file yatim dari disk!`);
      loadFiles();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal membersihkan file yatim");
    } finally {
      setCleaning(false);
    }
  }

  function copyFileUrl(file: StoredFileInfo) {
    if (!file.collectionName) {
      alert("File ini tidak terikat dengan koleksi aktif.");
      return;
    }
    const url = fileUrl(projectId, file.collectionName, file.recordId, file.name);
    navigator.clipboard.writeText(url);
    setNotice("URL berkas disalin ke clipboard!");
    setTimeout(() => setNotice(""), 3000);
  }

  // Filtered files memo
  const filteredFiles = useMemo(() => {
    return files.filter((f) => {
      // Search
      const matchesSearch =
        f.name.toLowerCase().includes(search.toLowerCase()) ||
        f.recordId.toLowerCase().includes(search.toLowerCase()) ||
        (f.collectionName && f.collectionName.toLowerCase().includes(search.toLowerCase()));

      if (!matchesSearch) return false;

      // Type filter
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
      <div className="page" style={{ maxWidth: "1200px" }}>
        {/* Top Navigation */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
          <div>
            <h2 style={{ margin: "0.35rem 0 0", fontSize: "1.85rem", fontWeight: 800, letterSpacing: "-0.03em" }}>
              📁 Storage Explorer
            </h2>
            <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.88rem" }}>
              Kelola berkas fisik, aset gambar, dan thumbnail cache pada disk <code>data/storage/{projectId}</code>.
            </p>
          </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          {stats.orphanedCount > 0 && (
            <button
              className="btn"
              onClick={handleCleanOrphans}
              disabled={cleaning}
              style={{
                background: "rgba(245, 158, 11, 0.15)",
                border: "1px solid rgba(245, 158, 11, 0.4)",
                color: "#fbbf24",
                fontSize: "0.85rem",
              }}
            >
              🧹 Bersihkan {stats.orphanedCount} File Yatim
            </button>
          )}
          <button className="btn btn-secondary" onClick={loadFiles} disabled={loading} style={{ fontSize: "0.85rem" }}>
            🔄 Refresh
          </button>
        </div>
      </div>

      {notice && (
        <div style={{ padding: "0.75rem 1rem", background: "rgba(34, 197, 94, 0.15)", border: "1px solid var(--green)", borderRadius: "8px", color: "var(--green)", fontSize: "0.85rem", marginBottom: "1.25rem" }}>
          ✓ {notice}
        </div>
      )}

      {error && (
        <div style={{ padding: "0.75rem 1rem", background: "rgba(239, 68, 68, 0.15)", border: "1px solid var(--red)", borderRadius: "8px", color: "var(--red)", fontSize: "0.85rem", marginBottom: "1.25rem" }}>
          ⚠️ {error}
        </div>
      )}

      {/* Metric Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem", marginBottom: "1.75rem" }}>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="muted" style={{ fontSize: "0.8rem", fontWeight: 600, textTransform: "uppercase" }}>
            📦 Total Berkas Fisik
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700, marginTop: "0.3rem", color: "var(--text)" }}>
            {stats.totalFiles}
          </div>
        </div>

        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="muted" style={{ fontSize: "0.8rem", fontWeight: 600, textTransform: "uppercase" }}>
            💾 Storage Digunakan
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700, marginTop: "0.3rem", color: "var(--accent)" }}>
            {formatBytes(stats.totalSize)}
          </div>
        </div>

        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="muted" style={{ fontSize: "0.8rem", fontWeight: 600, textTransform: "uppercase" }}>
            🖼️ Berkas Gambar
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700, marginTop: "0.3rem", color: "#60a5fa" }}>
            {imageCount}
          </div>
        </div>

        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="muted" style={{ fontSize: "0.8rem", fontWeight: 600, textTransform: "uppercase" }}>
            🧹 File Yatim (Orphaned)
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700, marginTop: "0.3rem", color: stats.orphanedCount > 0 ? "#f87171" : "var(--green)" }}>
            {stats.orphanedCount}
          </div>
        </div>
      </div>

      {/* Filter & View Toolbar */}
      <div className="studio-toolbar" style={{ background: "var(--panel)", padding: "0.85rem 1.25rem", borderRadius: "10px", border: "1px solid var(--border)" }}>
        <div style={{ display: "flex", gap: "0.5rem", flex: 1, minWidth: "260px" }}>
          <input
            className="input"
            placeholder="Cari nama berkas, record id, atau koleksi..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ fontSize: "0.85rem" }}
          />
        </div>

        {/* Type Filter Buttons */}
        <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
          {[
            { id: "all", label: "Semua" },
            { id: "images", label: "🖼️ Gambar" },
            { id: "documents", label: "📄 Dokumen" },
            { id: "media", label: "🎵 Media" },
            ...(stats.orphanedCount > 0 ? [{ id: "orphaned", label: `⚠️ Yatim (${stats.orphanedCount})` }] : []),
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              className={`btn btn-secondary ${typeFilter === t.id ? "btn-active" : ""}`}
              onClick={() => setTypeFilter(t.id as typeof typeFilter)}
              style={{
                fontSize: "0.8rem",
                padding: "0.35rem 0.65rem",
                background: typeFilter === t.id ? "var(--panel-2)" : "transparent",
                borderColor: typeFilter === t.id ? "var(--accent)" : "var(--border)",
                color: typeFilter === t.id ? "var(--accent)" : "var(--muted)",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* View Mode Toggle */}
        <div style={{ display: "flex", gap: "0.2rem", background: "var(--panel-2)", padding: "0.2rem", borderRadius: "6px", border: "1px solid var(--border)" }}>
          <button
            type="button"
            className="btn-icon"
            onClick={() => setViewMode("grid")}
            style={{
              padding: "0.3rem 0.5rem",
              background: viewMode === "grid" ? "var(--panel)" : "transparent",
              color: viewMode === "grid" ? "var(--text)" : "var(--muted)",
              border: "none",
            }}
            title="Grid View"
          >
            🔲
          </button>
          <button
            type="button"
            className="btn-icon"
            onClick={() => setViewMode("table")}
            style={{
              padding: "0.3rem 0.5rem",
              background: viewMode === "table" ? "var(--panel)" : "transparent",
              color: viewMode === "table" ? "var(--text)" : "var(--muted)",
              border: "none",
            }}
            title="Table View"
          >
            📋
          </button>
        </div>
      </div>

      {/* Main Files View */}
      {loading ? (
        <div style={{ padding: "4rem", textAlign: "center" }} className="muted">
          Memindai disk storage…
        </div>
      ) : filteredFiles.length === 0 ? (
        <div className="card empty-state" style={{ marginTop: "1.5rem" }}>
          <div className="big">📁</div>
          <h3>Tidak ada berkas yang cocok</h3>
          <p className="muted" style={{ maxWidth: 400, margin: "0.5rem auto 0" }}>
            {files.length === 0
              ? "Belum ada berkas yang diunggah ke project ini. Upload berkas melalui form data tabel database."
              : "Tidak ada berkas yang cocok dengan filter atau kata kunci pencarian Anda."}
          </p>
        </div>
      ) : viewMode === "grid" ? (
        /* ─── GRID CARD VIEW ─── */
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "1rem", marginTop: "1.5rem" }}>
          {filteredFiles.map((file) => {
            const fileDirectUrl = file.collectionName
              ? fileUrl(projectId, file.collectionName, file.recordId, file.name)
              : null;
            const thumbUrl = file.isImage && file.collectionName
              ? `${fileDirectUrl}?thumb=200x200`
              : null;

            return (
              <div
                key={file.storedName}
                className="card"
                style={{
                  padding: "0.75rem",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  background: "var(--panel)",
                  border: file.isOrphaned ? "1px dashed #f87171" : "1px solid var(--border)",
                  borderRadius: "10px",
                  overflow: "hidden",
                }}
              >
                {/* Thumbnail / Icon Container */}
                <div
                  onClick={() => setPreviewFile(file)}
                  style={{
                    height: "140px",
                    background: "var(--panel-2)",
                    borderRadius: "6px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  {thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbUrl}
                      alt={file.name}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      loading="lazy"
                    />
                  ) : (
                    <span style={{ fontSize: "2.5rem" }}>
                      {file.isImage ? "🖼️" : file.mime.includes("pdf") ? "📄" : file.mime.includes("audio") ? "🎵" : file.mime.includes("video") ? "🎬" : "📦"}
                    </span>
                  )}
                  {file.isOrphaned && (
                    <span
                      className="badge"
                      style={{
                        position: "absolute",
                        top: "6px",
                        left: "6px",
                        background: "rgba(239, 68, 68, 0.85)",
                        color: "#fff",
                        fontSize: "0.68rem",
                      }}
                    >
                      Yatim
                    </span>
                  )}
                </div>

                {/* File Details */}
                <div style={{ marginTop: "0.65rem" }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "0.85rem",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: "var(--text)",
                    }}
                    title={file.name}
                  >
                    {file.name}
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.3rem", fontSize: "0.75rem", color: "var(--muted)" }}>
                    <span>{formatBytes(file.size)}</span>
                    <span className="badge badge-gray" style={{ fontSize: "0.68rem", padding: "0.1rem 0.35rem" }}>
                      {file.collectionName ?? "tanpa tabel"}
                    </span>
                  </div>
                </div>

                {/* Card Actions */}
                <div style={{ display: "flex", gap: "0.3rem", marginTop: "0.75rem", paddingTop: "0.5rem", borderTop: "1px solid var(--border)" }}>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => setPreviewFile(file)}
                    style={{ flex: 1, padding: "0.35rem" }}
                    title="Pratinjau Berkas"
                  >
                    👁️
                  </button>
                  {fileDirectUrl && (
                    <>
                      <a
                        href={fileDirectUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-icon"
                        style={{ flex: 1, padding: "0.35rem", textAlign: "center", textDecoration: "none" }}
                        title="Buka / Unduh Berkas"
                      >
                        📥
                      </a>
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => copyFileUrl(file)}
                        style={{ flex: 1, padding: "0.35rem" }}
                        title="Salin URL Berkas"
                      >
                        📋
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => handleDelete(file)}
                    style={{ flex: 1, padding: "0.35rem" }}
                    title="Hapus Berkas dari Disk"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ─── TABLE VIEW ─── */
        <div className="table-container" style={{ marginTop: "1.5rem" }}>
          <div className="table-wrap" style={{ margin: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: "45px" }}>Tipe</th>
                  <th>Nama Berkas</th>
                  <th>Ukuran</th>
                  <th>MIME Type</th>
                  <th>Record ID</th>
                  <th>Koleksi</th>
                  <th>Tanggal Unggah</th>
                  <th style={{ textAlign: "right" }}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {filteredFiles.map((file) => {
                  const fileDirectUrl = file.collectionName
                    ? fileUrl(projectId, file.collectionName, file.recordId, file.name)
                    : null;

                  return (
                    <tr key={file.storedName}>
                      <td style={{ textAlign: "center" }}>
                        {file.isImage ? "🖼️" : file.mime.includes("pdf") ? "📄" : "📦"}
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>{file.name}</div>
                        {file.isOrphaned && (
                          <span style={{ fontSize: "0.7rem", color: "#f87171" }}>
                            ⚠️ Record induk tidak ditemukan (file yatim)
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: "0.82rem", whiteSpace: "nowrap" }}>{formatBytes(file.size)}</td>
                      <td className="muted" style={{ fontSize: "0.78rem" }}>{file.mime}</td>
                      <td style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}>{file.recordId}</td>
                      <td>
                        {file.collectionName ? (
                          <Link
                            href={`/projects/${projectId}/database/${encodeURIComponent(file.collectionName)}`}
                            style={{ color: "var(--accent)", textDecoration: "none", fontSize: "0.82rem" }}
                          >
                            {file.collectionName}
                          </Link>
                        ) : (
                          <span className="muted" style={{ fontSize: "0.82rem" }}>—</span>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: "0.78rem", whiteSpace: "nowrap" }}>
                        {file.mtime.slice(0, 19).replace("T", " ")}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          className="btn-icon"
                          style={{ marginRight: "0.3rem" }}
                          onClick={() => setPreviewFile(file)}
                          title="Preview Berkas"
                        >
                          👁️
                        </button>
                        {fileDirectUrl && (
                          <>
                            <a
                              href={fileDirectUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="btn-icon"
                              style={{ marginRight: "0.3rem", display: "inline-block", textDecoration: "none" }}
                              title="Buka / Unduh"
                            >
                              📥
                            </a>
                            <button
                              type="button"
                              className="btn-icon"
                              style={{ marginRight: "0.3rem" }}
                              onClick={() => copyFileUrl(file)}
                              title="Salin URL"
                            >
                              📋
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="btn-icon"
                          onClick={() => handleDelete(file)}
                          title="Hapus berkas"
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── MODAL: PREVIEW FILE ─── */}
      {previewFile && (
        <div className="modal-overlay" onClick={() => setPreviewFile(null)}>
          <div className="modal-box card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "580px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h3 style={{ margin: 0, fontSize: "1.1rem", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                {previewFile.name}
              </h3>
              <button className="btn-icon" onClick={() => setPreviewFile(null)}>✕</button>
            </div>

            {/* Media Content */}
            <div style={{ background: "var(--panel-2)", padding: "1rem", borderRadius: "8px", textAlign: "center", marginBottom: "1rem" }}>
              {previewFile.isImage && previewFile.collectionName ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={fileUrl(projectId, previewFile.collectionName, previewFile.recordId, previewFile.name)}
                  alt={previewFile.name}
                  style={{ maxWidth: "100%", maxHeight: "320px", borderRadius: "6px", objectFit: "contain" }}
                />
              ) : previewFile.mime.startsWith("audio/") && previewFile.collectionName ? (
                <audio
                  controls
                  src={fileUrl(projectId, previewFile.collectionName, previewFile.recordId, previewFile.name)}
                  style={{ width: "100%", marginTop: "0.5rem" }}
                />
              ) : previewFile.mime.startsWith("video/") && previewFile.collectionName ? (
                <video
                  controls
                  src={fileUrl(projectId, previewFile.collectionName, previewFile.recordId, previewFile.name)}
                  style={{ width: "100%", maxHeight: "280px", borderRadius: "6px" }}
                />
              ) : (
                <div style={{ padding: "2rem" }}>
                  <div style={{ fontSize: "3rem", marginBottom: "0.5rem" }}>📄</div>
                  <p className="muted" style={{ fontSize: "0.85rem" }}>
                    Pratinjau langsung tidak tersedia untuk format <code>{previewFile.mime}</code>.
                  </p>
                </div>
              )}
            </div>

            {/* File Metadata Info */}
            <div style={{ fontSize: "0.82rem", display: "grid", gap: "0.4rem" }}>
              <div className="kv"><span className="k">Ukuran:</span><span className="v">{formatBytes(previewFile.size)} ({previewFile.size} bytes)</span></div>
              <div className="kv"><span className="k">MIME Type:</span><span className="v">{previewFile.mime}</span></div>
              <div className="kv"><span className="k">Record ID:</span><span className="v"><code>{previewFile.recordId}</code></span></div>
              <div className="kv"><span className="k">Koleksi:</span><span className="v">{previewFile.collectionName ?? "—"}</span></div>
              <div className="kv"><span className="k">Waktu Unggah:</span><span className="v">{previewFile.mtime.replace("T", " ").slice(0, 19)}</span></div>
            </div>

            <div className="form-actions" style={{ marginTop: "1.25rem" }}>
              <button className="btn btn-secondary" onClick={() => setPreviewFile(null)}>Tutup</button>
              {previewFile.collectionName && (
                <a
                  href={fileUrl(projectId, previewFile.collectionName, previewFile.recordId, previewFile.name)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn"
                  style={{ textDecoration: "none" }}
                >
                  Buka Berkas Asli ↗
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
