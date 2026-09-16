"use client";

// ============================================================================
// M15u: FUNCTIONS PAGE — editor + runner + badge schedule/triggers
//
// Layout:
//  - Daftar function: nama, badge (⏰ cron / 🔗 trigger / ▶ callable),
//    toggle enabled, Run, Edit, Delete
//  - Modal editor: name (saat baru), code (textarea mono), timeout,
//    schedule (cron), triggers (collection + actions checkboxes)
//  - Run panel inline: body JSON input → result + logs
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  listFunctions,
  createFunction,
  updateFunction,
  deleteFunction,
  executeFunction,
  listCollectionsForFunctions,
  type StoredFunction,
  type FunctionTrigger,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { FunctionEditor } from "@/components/studio/FunctionEditor";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

const DEFAULT_CODE = `// req = { body, query, auth } untuk callable
// return apapun → JSON response
return { hello: "dunia", dari: req.auth?.email ?? "anon" };`;

export default function FunctionsPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [functions, setFunctions] = useState<StoredFunction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // editor state
  const [editing, setEditing] = useState<StoredFunction | null>(null); // existing
  const [creating, setCreating] = useState(false);
  const [collectionNames, setCollectionNames] = useState<string[]>([]);

  // run panel
  const [running, setRunning] = useState<string | null>(null); // nama function
  const [runBody, setRunBody] = useState("{}");
  const [runResult, setRunResult] = useState<{ ok: boolean; result?: unknown; error?: string; logs: string[]; durationMs: number; timedOut?: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [fns, cols] = await Promise.all([listFunctions(projectId), listCollectionsForFunctions(projectId)]);
      setFunctions(fns);
      setCollectionNames(cols.map((c) => c.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memuat functions");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggle(fn: StoredFunction) {
    setError("");
    try {
      await updateFunction(projectId, fn.name, { enabled: !fn.enabled });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal mengubah status");
    }
  }

  async function handleDelete(fn: StoredFunction) {
    if (!confirm(`Hapus function '${fn.name}'?`)) return;
    setError("");
    try {
      await deleteFunction(projectId, fn.name);
      setNotice(`Function '${fn.name}' dihapus`);
      if (running === fn.name) {
        setRunning(null);
        setRunResult(null);
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menghapus");
    }
  }

  async function handleRun(fn: StoredFunction) {
    setError("");
    setRunning(fn.name);
    setRunResult(null);
    try {
      let body: unknown = {};
      try {
        body = JSON.parse(runBody || "{}");
      } catch {
        throw new Error("Body JSON tidak valid");
      }
      const result = await executeFunction(projectId, fn.name, body);
      setRunResult(result);
    } catch (e) {
      setRunResult({ ok: false, error: e instanceof Error ? e.message : "Gagal menjalankan", logs: [], durationMs: 0 });
    }
  }

  function badges(fn: StoredFunction) {
    const items: string[] = [];
    if (fn.schedule) items.push(`⏰ ${fn.schedule}`);
    for (const t of fn.triggers) {
      items.push(`🔗 ${t.collection}:${t.actions.join("/")}`);
    }
    if (items.length === 0) items.push("▶ callable");
    return items;
  }

  return (
    <>
      <Navbar projectId={projectId} />

      <div className="max-w-[1180px] mx-auto px-6 py-6 flex gap-6 items-start">
        {/* ─── PROJECT SIDEBAR ─── */}
        <ProjectSidebar projectId={projectId} />

        {/* ─── MAIN CONTENT ─── */}
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-center flex-wrap gap-2">
            <h2 className="text-2xl font-bold">
              Functions <span className="text-muted-foreground text-base font-normal">({functions.length})</span>
            </h2>
            <Button
              onClick={() => {
                setCreating(true);
                setEditing(null);
              }}
            >
              + Function baru
            </Button>
          </div>

          <p className="text-sm text-muted-foreground mt-1">
            Kode berjalan di sandbox: tanpa <code>process</code>/<code>require</code>, timeout, console tertangkap.
          </p>

          {notice && (
            <Card className="p-3 mt-3 border-green-600 bg-green-50">
              ✅ {notice}
            </Card>
          )}
          {error && (
            <Card className="p-3 mt-3 border-destructive bg-destructive/10">
              ⚠️ {error}
            </Card>
          )}

      {/* Daftar functions */}
      <Card className="p-4 mt-4">
        {loading ? (
          <p className="text-muted-foreground">Memuat…</p>
        ) : functions.length === 0 ? (
          <p className="text-muted-foreground">
            Belum ada function. Klik <strong>+ Function baru</strong> untuk membuat pertama.
          </p>
        ) : (
          functions.map((fn) => (
            <div
              key={fn.id}
              className="py-3 border-b border-border flex flex-col gap-1.5 last:border-0"
            >
              <div className="flex items-center gap-2.5 flex-wrap">
                <strong className="text-sm">{fn.name}</strong>
                {badges(fn).map((b, i) => (
                  <Badge key={i} variant="secondary" className="text-xs">
                    {b}
                  </Badge>
                ))}
                <span className="text-xs text-muted-foreground">
                  {fn.timeoutMs}ms
                </span>
                <span className="flex-1" />
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <Checkbox
                    checked={fn.enabled}
                    onCheckedChange={() => handleToggle(fn)}
                  />
                  {fn.enabled ? "aktif" : "nonaktif"}
                </label>
                <Button variant="secondary" size="sm" onClick={() => handleRun(fn)}>
                  ▶ Run
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(fn);
                    setCreating(false);
                    setRunning(null);
                  }}
                >
                  Edit
                </Button>
                <Button variant="destructive" size="sm" onClick={() => handleDelete(fn)}>
                  Hapus
                </Button>
              </div>

              {/* Run panel */}
              {running === fn.name && (
                <div className="bg-muted rounded-lg p-3 mt-2">
                  <Label className="text-xs">req.body (JSON)</Label>
                  <Textarea
                    rows={2}
                    value={runBody}
                    onChange={(e) => setRunBody(e.target.value)}
                    className="font-mono text-sm mt-1"
                  />
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" onClick={() => handleRun(fn)}>
                      Jalankan
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setRunning(null)}>
                      Tutup
                    </Button>
                  </div>
                  {runResult && (
                    <div className="mt-3 text-sm">
                      <div>
                        {runResult.ok ? "✅" : "❌"} <strong>{runResult.durationMs}ms</strong>
                        {runResult.timedOut && " ⏱ timeout"}
                      </div>
                      {runResult.error && (
                        <div className="text-destructive">{runResult.error}</div>
                      )}
                      {runResult.result !== undefined && runResult.result !== null && (
                        <pre className="bg-card p-2 rounded mt-2 overflow-x-auto text-xs">
                          {JSON.stringify(runResult.result, null, 2)}
                        </pre>
                      )}
                      {runResult.logs.length > 0 && (
                        <details className="mt-2">
                          <summary className="text-muted-foreground cursor-pointer text-xs">
                            console ({runResult.logs.length})
                          </summary>
                          <pre className="bg-card p-2 rounded mt-1 overflow-x-auto text-xs">
                            {runResult.logs.join("\n")}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </Card>

      {/* Editor modal */}
      {(creating || editing) && (
        <FunctionEditor
          projectId={projectId}
          existing={editing}
          collectionNames={collectionNames}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            setNotice("Function tersimpan");
            load();
          }}
        />
      )}
        </div>
      </div>
    </>
  );
}

// ─── Editor modal (create & edit) ────────────────────────────────────────────

// ─── END OF PAGE ───