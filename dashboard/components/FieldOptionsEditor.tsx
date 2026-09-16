"use client";

import React from "react";
import type { FieldDef } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface FieldOptionsEditorProps {
  field: FieldDef;
  onChange: (updates: Partial<FieldDef>) => void;
  allCollections?: { name: string }[];
}

// Helper kecil untuk mengurangi duplikasi label+input
function OptInput({
  label,
  ...props
}: { label: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input {...props} />
    </div>
  );
}

function OptSelect({
  label,
  value,
  onValueChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function OptCheckbox({
  label,
  checked,
  onCheckedChange,
}: {
  label: React.ReactNode;
  checked: boolean;
  onCheckedChange: (c: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <Checkbox checked={checked} onCheckedChange={(c) => onCheckedChange(!!c)} />
      {label}
    </label>
  );
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
    <div className="mt-2.5 p-3 bg-muted/50 rounded-md border border-border text-sm">
      <div className="flex justify-between items-center mb-2 font-semibold text-xs text-accent-foreground uppercase tracking-wider">
        <span>⚙️ Options: {field.type}</span>
      </div>

      {/* ─── 1. TEXT ─── */}
      {field.type === "text" && (
        <div className="grid grid-cols-2 gap-3">
          <OptInput
            label="Min Karakter:"
            type="number"
            placeholder="e.g. 3"
            value={opts.min ?? ""}
            onChange={(e) =>
              updateOptions({ min: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <OptInput
            label="Max Karakter:"
            type="number"
            placeholder="e.g. 255"
            value={opts.max ?? ""}
            onChange={(e) =>
              updateOptions({ max: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <div className="col-span-2 space-y-1">
            <Label className="text-xs text-muted-foreground">Validation Regex Pattern:</Label>
            <Input
              type="text"
              placeholder="^[a-zA-Z0-9_-]+$"
              value={opts.pattern ?? ""}
              onChange={(e) => updateOptions({ pattern: e.target.value || undefined })}
            />
          </div>
          <div className="col-span-2 mt-1">
            <OptCheckbox
              label={<>Aktifkan <strong>SQLite FTS5 Full-Text Search</strong> Index</>}
              checked={!!opts.fulltext}
              onCheckedChange={(c) => updateOptions({ fulltext: c })}
            />
          </div>
        </div>
      )}

      {/* ─── 2. NUMBER ─── */}
      {field.type === "number" && (
        <div className="grid grid-cols-2 gap-3">
          <OptInput
            label="Nilai Minimum:"
            type="number"
            placeholder="e.g. 0"
            value={opts.min ?? ""}
            onChange={(e) =>
              updateOptions({ min: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <OptInput
            label="Nilai Maksimum:"
            type="number"
            placeholder="e.g. 99999"
            value={opts.max ?? ""}
            onChange={(e) =>
              updateOptions({ max: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <div className="col-span-2 mt-1">
            <OptCheckbox
              label="Disallow Decimals (Integers Only)"
              checked={!!opts.noDecimal}
              onCheckedChange={(c) => updateOptions({ noDecimal: c })}
            />
          </div>
        </div>
      )}

      {/* ─── 3. BOOL ─── */}
      {field.type === "bool" && (
        <div className="text-sm text-muted-foreground">
          ℹ️ Stored as <code>INTEGER 0/1</code> in SQLite, automatically deserialized to <code>true/false</code> in JSON responses.
        </div>
      )}

      {/* ─── 4. EMAIL ─── */}
      {field.type === "email" && (
        <div className="grid gap-3">
          <OptInput
            label="Only Allowed Domains (pisahkan dengan koma):"
            type="text"
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
          <OptInput
            label="Blocked / Except Domains (pisahkan dengan koma):"
            type="text"
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
      )}

      {/* ─── 5. URL ─── */}
      {field.type === "url" && (
        <div className="grid gap-3">
          <OptInput
            label="Only Allowed Hosts (pisahkan dengan koma):"
            type="text"
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
          <OptInput
            label="Blocked Hosts (pisahkan dengan koma):"
            type="text"
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
      )}

      {/* ─── 6. DATE ─── */}
      {field.type === "date" && (
        <div className="grid grid-cols-2 gap-3">
          <OptInput
            label="Min Date (ISO format):"
            type="date"
            value={opts.min ? String(opts.min).slice(0, 10) : ""}
            onChange={(e) =>
              updateOptions({ min: e.target.value ? `${e.target.value}T00:00:00Z` : undefined })
            }
          />
          <OptInput
            label="Max Date (ISO format):"
            type="date"
            value={opts.max ? String(opts.max).slice(0, 10) : ""}
            onChange={(e) =>
              updateOptions({ max: e.target.value ? `${e.target.value}T23:59:59Z` : undefined })
            }
          />
        </div>
      )}

      {/* ─── 7. SELECT ─── */}
      {field.type === "select" && (
        <div className="grid gap-3">
          <OptInput
            label="Allowed Values (comma separated):"
            type="text"
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
          <OptInput
            label="Max Select (1 = single select, >1 = multi-select array):"
            type="number"
            min={1}
            value={opts.maxSelect ?? 1}
            onChange={(e) =>
              updateOptions({ maxSelect: Math.max(1, Number(e.target.value) || 1) })
            }
          />
        </div>
      )}

      {/* ─── 8. FILE ─── */}
      {field.type === "file" && (
        <div className="grid grid-cols-2 gap-3">
          <OptInput
            label="Max File Size (MB):"
            type="number"
            min={1}
            value={Math.round((opts.maxSize ?? 5242880) / (1024 * 1024))}
            onChange={(e) =>
              updateOptions({
                maxSize: Math.max(1, Number(e.target.value) || 5) * 1024 * 1024,
              })
            }
          />
          <OptInput
            label="Max Files (1 = single, >1 = multi-upload):"
            type="number"
            min={1}
            value={opts.maxSelect ?? 1}
            onChange={(e) =>
              updateOptions({ maxSelect: Math.max(1, Number(e.target.value) || 1) })
            }
          />
          <div className="col-span-2 space-y-1">
            <Label className="text-xs text-muted-foreground">Allowed MIME Types (pisahkan dengan koma):</Label>
            <Input
              type="text"
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
          <div className="col-span-2 space-y-1">
            <Label className="text-xs text-muted-foreground">Thumbnail Presets (e.g. 100x100, 300x0, 0x200):</Label>
            <Input
              type="text"
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
          <div className="col-span-2 mt-1">
            <OptCheckbox
              label={<><strong>Protected File:</strong> Requires Authorization Token to access file URL</>}
              checked={!!opts.protected}
              onCheckedChange={(c) => updateOptions({ protected: c })}
            />
          </div>
        </div>
      )}

      {/* ─── 9. RELATION ─── */}
      {field.type === "relation" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Target Collection:</Label>
            <Select
              value={opts.collectionId ?? ""}
              onValueChange={(v) => updateOptions({ collectionId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="— pilih target collection —" />
              </SelectTrigger>
              <SelectContent>
                {allCollections.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Cascade Delete Action:</Label>
            <Select
              value={opts.cascadeDelete ?? "setNull"}
              onValueChange={(v) => updateOptions({ cascadeDelete: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="setNull">setNull (ubah jadi null)</SelectItem>
                <SelectItem value="cascade">cascade (ikut terhapus)</SelectItem>
                <SelectItem value="restrict">restrict (tolak hapus parent)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-1">
            <Label className="text-xs text-muted-foreground">Max Select (1 = single relation ID, &gt;1 = multi relation array):</Label>
            <Input
              type="number"
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
        <OptInput
          label="Max Size (KB):"
          type="number"
          placeholder="e.g. 2048 (2MB)"
          value={opts.maxSize ? Math.round(Number(opts.maxSize) / 1024) : ""}
          onChange={(e) =>
            updateOptions({
              maxSize: e.target.value ? Number(e.target.value) * 1024 : undefined,
            })
          }
        />
      )}

      {/* ─── 11. EDITOR ─── */}
      {field.type === "editor" && (
        <OptInput
          label="Max HTML Length (karakter):"
          type="number"
          placeholder="e.g. 50000"
          value={opts.max ?? ""}
          onChange={(e) =>
            updateOptions({ max: e.target.value ? Number(e.target.value) : undefined })
          }
        />
      )}

      {/* ─── 12. PASSWORD ─── */}
      {field.type === "password" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 text-sm text-muted-foreground">
            🔒 Password di-hash menggunakan algoritma <code>scrypt</code> node:crypto sebelum disimpan. Bersifat write-only (hash asli tidak pernah dibocorkan ke JSON response).
          </div>
          <OptInput
            label="Min Karakter:"
            type="number"
            min={6}
            value={opts.min ?? 8}
            onChange={(e) =>
              updateOptions({ min: Math.max(6, Number(e.target.value) || 8) })
            }
          />
          <OptInput
            label="Cost Factor (Default: 16384):"
            type="number"
            placeholder="16384"
            value={opts.cost ?? 16384}
            onChange={(e) =>
              updateOptions({ cost: Number(e.target.value) || 16384 })
            }
          />
        </div>
      )}

      {/* ─── 13. GEOPOINT ─── */}
      {field.type === "geoPoint" && (
        <div className="text-sm text-muted-foreground">
          📍 Koordinat Geografis valid <code>{`{ lat: -90..90, lng: -180..180 }`}</code>.
        </div>
      )}

      {/* ─── 14. AUTODATE ─── */}
      {field.type === "autodate" && (
        <div className="grid gap-2">
          <OptCheckbox
            label="Auto-fill saat Record Dibuat (onCreate)"
            checked={opts.onCreate !== false}
            onCheckedChange={(c) => updateOptions({ onCreate: c })}
          />
          <OptCheckbox
            label="Auto-update saat Record Diedit (onUpdate)"
            checked={opts.onUpdate !== false}
            onCheckedChange={(c) => updateOptions({ onUpdate: c })}
          />
        </div>
      )}
    </div>
  );
}
