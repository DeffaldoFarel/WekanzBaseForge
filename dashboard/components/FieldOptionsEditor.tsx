"use client";

import React from "react";
import type { FieldDef } from "@/lib/api";

interface FieldOptionsEditorProps {
  field: FieldDef;
  onChange: (updates: Partial<FieldDef>) => void;
  allCollections?: { name: string }[];
}

export function FieldOptionsEditor({
  field,
  onChange,
  allCollections = [],
}: FieldOptionsEditorProps) {
  const opts = field.options || {};

  function updateOptions(patch: Record<string, unknown>) {
    onChange({
      options: {
        ...opts,
        ...patch,
      },
    });
  }

  return (
    <div
      style={{
        marginTop: "0.6rem",
        padding: "0.75rem",
        background: "rgba(0, 0, 0, 0.2)",
        borderRadius: "6px",
        border: "1px solid var(--border)",
        fontSize: "0.85rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
          fontWeight: 600,
          color: "var(--accent)",
          fontSize: "0.8rem",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        <span>⚙️ Options: {field.type}</span>
      </div>

      {/* ─── 1. TEXT ─── */}
      {field.type === "text" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Min Karakter:
            </label>
            <input
              type="number"
              className="input"
              placeholder="e.g. 3"
              value={opts.min ?? ""}
              onChange={(e) =>
                updateOptions({ min: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Max Karakter:
            </label>
            <input
              type="number"
              className="input"
              placeholder="e.g. 255"
              value={opts.max ?? ""}
              onChange={(e) =>
                updateOptions({ max: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Validation Regex Pattern:
            </label>
            <input
              type="text"
              className="input"
              placeholder="^[a-zA-Z0-9_-]+$"
              value={opts.pattern ?? ""}
              onChange={(e) => updateOptions({ pattern: e.target.value || undefined })}
            />
          </div>
          <div style={{ gridColumn: "1 / -1", marginTop: "0.2rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!!opts.fulltext}
                onChange={(e) => updateOptions({ fulltext: e.target.checked })}
              />
              <span>Aktifkan <strong>SQLite FTS5 Full-Text Search</strong> Index</span>
            </label>
          </div>
        </div>
      )}

      {/* ─── 2. NUMBER ─── */}
      {field.type === "number" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Nilai Minimum:
            </label>
            <input
              type="number"
              className="input"
              placeholder="e.g. 0"
              value={opts.min ?? ""}
              onChange={(e) =>
                updateOptions({ min: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Nilai Maksimum:
            </label>
            <input
              type="number"
              className="input"
              placeholder="e.g. 99999"
              value={opts.max ?? ""}
              onChange={(e) =>
                updateOptions({ max: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </div>
          <div style={{ gridColumn: "1 / -1", marginTop: "0.2rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!!opts.noDecimal}
                onChange={(e) => updateOptions({ noDecimal: e.target.checked })}
              />
              <span>Disallow Decimals (Integers Only)</span>
            </label>
          </div>
        </div>
      )}

      {/* ─── 3. BOOL ─── */}
      {field.type === "bool" && (
        <div className="muted" style={{ fontSize: "0.82rem" }}>
          ℹ️ Stored as <code>INTEGER 0/1</code> in SQLite, automatically deserialized to <code>true/false</code> in JSON responses.
        </div>
      )}

      {/* ─── 4. EMAIL ─── */}
      {field.type === "email" && (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Only Allowed Domains (pisahkan dengan koma):
            </label>
            <input
              type="text"
              className="input"
              placeholder="gmail.com, wekanz.id"
              value={opts.onlyDomains?.join(", ") ?? ""}
              onChange={(e) =>
                updateOptions({
                  onlyDomains: e.target.value
                    .split(",")
                    .map((s) => s.trim().toLowerCase())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Blocked / Except Domains (pisahkan dengan koma):
            </label>
            <input
              type="text"
              className="input"
              placeholder="tempmail.com, 10minutemail.com"
              value={opts.exceptDomains?.join(", ") ?? ""}
              onChange={(e) =>
                updateOptions({
                  exceptDomains: e.target.value
                    .split(",")
                    .map((s) => s.trim().toLowerCase())
                    .filter(Boolean),
                })
              }
            />
          </div>
        </div>
      )}

      {/* ─── 5. URL ─── */}
      {field.type === "url" && (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Only Allowed Hosts (pisahkan dengan koma):
            </label>
            <input
              type="text"
              className="input"
              placeholder="github.com, wekanz.id"
              value={opts.onlyDomains?.join(", ") ?? ""}
              onChange={(e) =>
                updateOptions({
                  onlyDomains: e.target.value
                    .split(",")
                    .map((s) => s.trim().toLowerCase())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Blocked Hosts (pisahkan dengan koma):
            </label>
            <input
              type="text"
              className="input"
              placeholder="malicious.com"
              value={opts.exceptDomains?.join(", ") ?? ""}
              onChange={(e) =>
                updateOptions({
                  exceptDomains: e.target.value
                    .split(",")
                    .map((s) => s.trim().toLowerCase())
                    .filter(Boolean),
                })
              }
            />
          </div>
        </div>
      )}

      {/* ─── 6. DATE ─── */}
      {field.type === "date" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Min Date (ISO format):
            </label>
            <input
              type="date"
              className="input"
              value={opts.min ? String(opts.min).slice(0, 10) : ""}
              onChange={(e) =>
                updateOptions({ min: e.target.value ? `${e.target.value}T00:00:00Z` : undefined })
              }
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Max Date (ISO format):
            </label>
            <input
              type="date"
              className="input"
              value={opts.max ? String(opts.max).slice(0, 10) : ""}
              onChange={(e) =>
                updateOptions({ max: e.target.value ? `${e.target.value}T23:59:59Z` : undefined })
              }
            />
          </div>
        </div>
      )}

      {/* ─── 7. SELECT ─── */}
      {field.type === "select" && (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Allowed Values (comma separated):
            </label>
            <input
              type="text"
              className="input"
              placeholder="draft, pending, active, archived"
              value={opts.values?.join(", ") ?? ""}
              onChange={(e) =>
                updateOptions({
                  values: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Max Select (1 = single select, &gt;1 = multi-select array):
            </label>
            <input
              type="number"
              className="input"
              min={1}
              value={opts.maxSelect ?? 1}
              onChange={(e) =>
                updateOptions({ maxSelect: Math.max(1, Number(e.target.value) || 1) })
              }
            />
          </div>
        </div>
      )}

      {/* ─── 8. FILE ─── */}
      {field.type === "file" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Max File Size (MB):
            </label>
            <input
              type="number"
              className="input"
              min={1}
              value={Math.round((opts.maxSize ?? 5242880) / (1024 * 1024))}
              onChange={(e) =>
                updateOptions({
                  maxSize: Math.max(1, Number(e.target.value) || 5) * 1024 * 1024,
                })
              }
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Max Files (1 = single, &gt;1 = multi-upload):
            </label>
            <input
              type="number"
              className="input"
              min={1}
              value={opts.maxSelect ?? 1}
              onChange={(e) =>
                updateOptions({ maxSelect: Math.max(1, Number(e.target.value) || 1) })
              }
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Allowed MIME Types (pisahkan dengan koma):
            </label>
            <input
              type="text"
              className="input"
              placeholder="image/jpeg, image/png, application/pdf"
              value={opts.mimeTypes?.join(", ") ?? ""}
              onChange={(e) =>
                updateOptions({
                  mimeTypes: e.target.value
                    .split(",")
                    .map((s) => s.trim().toLowerCase())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Thumbnail Presets (e.g. 100x100, 300x0, 0x200):
            </label>
            <input
              type="text"
              className="input"
              placeholder="100x100, 300x0"
              value={opts.thumbs?.join(", ") ?? ""}
              onChange={(e) =>
                updateOptions({
                  thumbs: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <div style={{ gridColumn: "1 / -1", marginTop: "0.2rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!!opts.protected}
                onChange={(e) => updateOptions({ protected: e.target.checked })}
              />
              <span><strong>Protected File:</strong> Requires Authorization Token to access file URL</span>
            </label>
          </div>
        </div>
      )}

      {/* ─── 9. RELATION ─── */}
      {field.type === "relation" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Target Collection:
            </label>
            <select
              className="input"
              value={opts.collectionId ?? ""}
              onChange={(e) => updateOptions({ collectionId: e.target.value })}
            >
              <option value="">— pilih target collection —</option>
              {allCollections.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Cascade Delete Action:
            </label>
            <select
              className="input"
              value={opts.cascadeDelete ?? "setNull"}
              onChange={(e) => updateOptions({ cascadeDelete: e.target.value })}
            >
              <option value="setNull">setNull (ubah jadi null)</option>
              <option value="cascade">cascade (ikut terhapus)</option>
              <option value="restrict">restrict (tolak hapus parent)</option>
            </select>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Max Select (1 = single relation ID, &gt;1 = multi relation array):
            </label>
            <input
              type="number"
              className="input"
              min={1}
              value={opts.maxSelect ?? 1}
              onChange={(e) =>
                updateOptions({ maxSelect: Math.max(1, Number(e.target.value) || 1) })
              }
            />
          </div>
        </div>
      )}

      {/* ─── 10. JSON ─── */}
      {field.type === "json" && (
        <div>
          <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
            Max Size (KB):
          </label>
          <input
            type="number"
            className="input"
            placeholder="e.g. 2048 (2MB)"
            value={opts.maxSize ? Math.round(Number(opts.maxSize) / 1024) : ""}
            onChange={(e) =>
              updateOptions({
                maxSize: e.target.value ? Number(e.target.value) * 1024 : undefined,
              })
            }
          />
        </div>
      )}

      {/* ─── 11. EDITOR ─── */}
      {field.type === "editor" && (
        <div>
          <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
            Max HTML Length (karakter):
          </label>
          <input
            type="number"
            className="input"
            placeholder="e.g. 50000"
            value={opts.max ?? ""}
            onChange={(e) =>
              updateOptions({ max: e.target.value ? Number(e.target.value) : undefined })
            }
          />
        </div>
      )}

      {/* ─── 12. PASSWORD ─── */}
      {field.type === "password" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
          <div className="muted" style={{ gridColumn: "1 / -1", fontSize: "0.82rem" }}>
            🔒 Password di-hash menggunakan algoritma <code>scrypt</code> node:crypto sebelum disimpan. Bersifat write-only (hash asli tidak pernah dibocorkan ke JSON response).
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Min Karakter:
            </label>
            <input
              type="number"
              className="input"
              min={6}
              value={opts.min ?? 8}
              onChange={(e) =>
                updateOptions({ min: Math.max(6, Number(e.target.value) || 8) })
              }
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.2rem" }}>
              Cost Factor (Default: 16384):
            </label>
            <input
              type="number"
              className="input"
              placeholder="16384"
              value={opts.cost ?? 16384}
              onChange={(e) =>
                updateOptions({ cost: Number(e.target.value) || 16384 })
              }
            />
          </div>
        </div>
      )}

      {/* ─── 13. GEOPOINT ─── */}
      {field.type === "geoPoint" && (
        <div className="muted" style={{ fontSize: "0.82rem" }}>
          📍 Koordinat Geografis valid <code>{`{ lat: -90..90, lng: -180..180 }`}</code>.
        </div>
      )}

      {/* ─── 14. AUTODATE ─── */}
      {field.type === "autodate" && (
        <div style={{ display: "grid", gap: "0.4rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={opts.onCreate !== false}
              onChange={(e) => updateOptions({ onCreate: e.target.checked })}
            />
            <span>Auto-fill saat Record Dibuat (onCreate)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={opts.onUpdate !== false}
              onChange={(e) => updateOptions({ onUpdate: e.target.checked })}
            />
            <span>Auto-update saat Record Diedit (onUpdate)</span>
          </label>
        </div>
      )}
    </div>
  );
}
