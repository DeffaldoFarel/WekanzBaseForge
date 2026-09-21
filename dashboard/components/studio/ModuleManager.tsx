"use client";

// ============================================================================
// M43: MODULE MANAGER ($lib) — shared library untuk functions
//
// Sebelumnya dashboard hanya bisa MEMILIH modul di FunctionEditor; membuat
// atau mengedit isinya harus lewat curl. Panel ini menutup jarak itu:
// create/edit/delete modul dengan editor kode, plus daftar function mana
// saja yang sedang memakai modul tersebut (supaya delete tidak membabi buta).
//
// Server mengkompilasi TS → CJS saat simpan dan menolak 400 bila sintaks
// salah — pesan itu ditampilkan apa adanya, bukan diganti "gagal menyimpan".
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  listModules,
  getModule,
  setModule,
  deleteModule,
  MODULE_NAME_PATTERN,
  MAX_MODULE_CODE_BYTES,
  type ModuleMeta,
  type StoredFunction,
} from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import {
  Package,
  Plus,
  Pencil,
  Trash2,
  Save,
  X,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";

const STARTER_CODE = `// Shared helpers available to functions that enable this module.
// Everything you export becomes a property of $lib.<moduleName>.

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const VERSION = "1.0.0";
`;

interface Props {
  projectId: string;
  /** Untuk menampilkan function mana yang memakai tiap modul. */
  functions: StoredFunction[];
  onChanged?: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

export function ModuleManager({ projectId, functions, onChanged, onSuccess, onError }: Props) {
  const [modules, setModules] = useState<ModuleMeta[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null); // null = create
  const [nameDraft, setNameDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingCode, setLoadingCode] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);

  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setModules(await listModules(projectId));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load modules");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  /** Function mana yang memakai modul ini. */
  function consumersOf(name: string): string[] {
    return functions.filter((f) => (f.modules ?? []).includes(name)).map((f) => f.name);
  }

  function handleCodeKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const val = target.value;
      const nextVal = val.substring(0, start) + "  " + val.substring(end);
      setCodeDraft(nextVal);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  }

  function startCreate() {
    setEditingName(null);
    setNameDraft("");
    setCodeDraft(STARTER_CODE);
    setCompileError(null);
    setEditorOpen(true);
  }

  async function startEdit(name: string) {
    setEditingName(name);
    setNameDraft(name);
    setCompileError(null);
    setEditorOpen(true);
    setLoadingCode(true);
    try {
      const mod = await getModule(projectId, name);
      setCodeDraft(mod.code);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load module code");
      setEditorOpen(false);
    } finally {
      setLoadingCode(false);
    }
  }

  async function handleSave() {
    const name = nameDraft.trim();
    if (!MODULE_NAME_PATTERN.test(name)) {
      setCompileError(
        "Module name must start with a lowercase letter and contain only lowercase letters, digits, or underscores (max 64 chars)."
      );
      return;
    }
    const bytes = new TextEncoder().encode(codeDraft).length;
    if (bytes > MAX_MODULE_CODE_BYTES) {
      setCompileError(`Module code is ${(bytes / 1024).toFixed(1)} KB — the limit is 256 KB.`);
      return;
    }
    if (!codeDraft.trim()) {
      setCompileError("Module code is required.");
      return;
    }
    setSaving(true);
    setCompileError(null);
    try {
      await setModule(projectId, name, codeDraft);
      onSuccess(editingName ? `Module "${name}" updated.` : `Module "${name}" created.`);
      setEditorOpen(false);
      load();
      onChanged?.();
    } catch (e) {
      // Server mengembalikan diagnostic TypeScript — tampilkan mentah.
      setCompileError(e instanceof Error ? e.message : "Failed to save module");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(name: string) {
    setDeleting(true);
    try {
      await deleteModule(projectId, name);
      onSuccess(`Module "${name}" deleted.`);
      setConfirmName(null);
      load();
      onChanged?.();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete module");
    } finally {
      setDeleting(false);
    }
  }

  const codeBytes = new TextEncoder().encode(codeDraft).length;

  return (
    <Card className="p-4 mt-6">
      {/* Header collapsible */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
        <Package className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold">Shared Modules</span>
        <code className="text-[11px] text-muted-foreground">$lib</code>
        {modules.length > 0 && (
          <Badge variant="secondary" className="text-[10px]">{modules.length}</Badge>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground">
          {open ? "Hide" : "Reusable code shared across functions"}
        </span>
      </button>

      {open && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground mb-3">
            Write helpers once and enable them per function. Exports land on{" "}
            <code className="text-foreground">$lib.&lt;module&gt;</code> inside the sandbox.
            TypeScript is compiled on save.
          </p>

          {/* Daftar modul */}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading modules…</p>
          ) : modules.length === 0 ? (
            <p className="text-sm text-muted-foreground mb-3">
              No shared modules yet.
            </p>
          ) : (
            <div className="space-y-1.5 mb-3">
              {modules.map((m) => {
                const consumers = consumersOf(m.name);
                return (
                  <div
                    key={m.name}
                    className="bg-muted border border-border rounded-md p-2.5 flex items-center gap-3 flex-wrap"
                  >
                    <code className="text-sm text-foreground font-medium">$lib.{m.name}</code>
                    <span className="text-[11px] text-muted-foreground">
                      {(m.sizeBytes / 1024).toFixed(1)} KB
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      updated {new Date(m.updated).toLocaleString()}
                    </span>
                    {consumers.length > 0 ? (
                      <Badge variant="secondary" className="text-[10px]">
                        used by {consumers.length}: {consumers.slice(0, 3).join(", ")}
                        {consumers.length > 3 ? "…" : ""}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] text-muted-foreground">
                        unused
                      </Badge>
                    )}
                    <span className="flex-1" />
                    <Button variant="ghost" size="sm" className="h-7" onClick={() => startEdit(m.name)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-destructive"
                      onClick={() => setConfirmName(m.name)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {!editorOpen && (
            <Button variant="secondary" size="sm" onClick={startCreate} className="gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              <span>New Module</span>
            </Button>
          )}

          {/* Editor */}
          {editorOpen && (
            <div className="border border-border rounded-lg p-3 mt-2 space-y-3">
              <div className="flex items-end gap-3 flex-wrap">
                <div className="space-y-1.5">
                  <Label htmlFor="mod-name" className="text-xs">Module name</Label>
                  <Input
                    id="mod-name"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    disabled={editingName !== null}
                    placeholder="text_utils"
                    className="h-8 w-56 font-mono text-sm"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground pb-2">
                  {editingName
                    ? "Name cannot be changed — delete and recreate to rename."
                    : "Lowercase letters, digits, underscore. Referenced as $lib.<name>."}
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="mod-code" className="text-xs">Code (TypeScript or JavaScript)</Label>
                  <span
                    className={`text-[10px] ${
                      codeBytes > MAX_MODULE_CODE_BYTES ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {(codeBytes / 1024).toFixed(1)} / 256 KB
                  </span>
                </div>
                {loadingCode ? (
                  <p className="text-sm text-muted-foreground">Loading code…</p>
                ) : (
                  <textarea
                    id="mod-code"
                    value={codeDraft}
                    onChange={(e) => setCodeDraft(e.target.value)}
                    onKeyDown={handleCodeKeyDown}
                    spellCheck={false}
                    rows={14}
                    className="w-full bg-background border border-border rounded-md p-3 font-mono text-xs text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                )}
              </div>

              {compileError && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 text-destructive text-xs p-2.5 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span className="whitespace-pre-wrap break-all font-mono">{compileError}</span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button onClick={handleSave} disabled={saving || loadingCode} size="sm" className="gap-1.5">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span>{saving ? "Saving…" : editingName ? "Save Changes" : "Create Module"}</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditorOpen(false)} disabled={saving} className="gap-1.5">
                  <X className="w-3.5 h-3.5" />
                  <span>Cancel</span>
                </Button>
              </div>
            </div>
          )}

          {/* Konfirmasi delete */}
          {confirmName && (
            <div className="mt-3">
              <ConfirmDelete
                title={`Delete module "${confirmName}"?`}
                description={
                  consumersOf(confirmName).length > 0
                    ? `${consumersOf(confirmName).length} function(s) still enable this module: ${consumersOf(confirmName).join(", ")}. They will fail at runtime until you update them.`
                    : "No function currently uses this module."
                }
                confirmLabel="Delete Module"
                busy={deleting}
                onConfirm={() => handleDelete(confirmName)}
                onCancel={() => setConfirmName(null)}
              />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
