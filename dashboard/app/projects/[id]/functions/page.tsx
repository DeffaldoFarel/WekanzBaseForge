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

      <div className="page" style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start" }}>
        {/* ─── PROJECT SIDEBAR ─── */}
        <ProjectSidebar projectId={projectId} />

        {/* ─── MAIN CONTENT ─── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
            <h2>
              Functions <span className="muted" style={{ fontSize: "0.85rem" }}>({functions.length})</span>
            </h2>
            <button
              className="btn btn-primary"
              onClick={() => {
                setCreating(true);
                setEditing(null);
              }}
            >
              + Function baru
            </button>
          </div>

          <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.25rem" }}>
            Kode berjalan di sandbox: tanpa <code>process</code>/<code>require</code>, timeout, console tertangkap.
          </p>

          {notice && <div className="card" style={{ borderColor: "var(--green, #2e7d32)", marginTop: "0.75rem" }}>✅ {notice}</div>}
          {error && <div className="card" style={{ borderColor: "var(--red, #c62828)", marginTop: "0.75rem" }}>⚠️ {error}</div>}

      {/* Daftar functions */}
      <div className="card" style={{ marginTop: "1rem" }}>
        {loading ? (
          <p className="muted">Memuat…</p>
        ) : functions.length === 0 ? (
          <p className="muted">
            Belum ada function. Klik <strong>+ Function baru</strong> untuk membuat pertama.
          </p>
        ) : (
          functions.map((fn) => (
            <div
              key={fn.id}
              style={{
                padding: "0.75rem 0",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: "0.4rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                <strong>{fn.name}</strong>
                {badges(fn).map((b, i) => (
                  <span key={i} className="type-badge">
                    {b}
                  </span>
                ))}
                <span className="muted" style={{ fontSize: "0.75rem" }}>
                  {fn.timeoutMs}ms
                </span>
                <span style={{ flex: 1 }} />
                <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.8rem", cursor: "pointer" }}>
                  <input type="checkbox" checked={fn.enabled} onChange={() => handleToggle(fn)} />
                  {fn.enabled ? "aktif" : "nonaktif"}
                </label>
                <button className="btn btn-secondary" onClick={() => handleRun(fn)}>
                  ▶ Run
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setEditing(fn);
                    setCreating(false);
                    setRunning(null);
                  }}
                >
                  Edit
                </button>
                <button className="btn btn-danger" onClick={() => handleDelete(fn)}>
                  Hapus
                </button>
              </div>

              {/* Run panel */}
              {running === fn.name && (
                <div style={{ background: "var(--panel-2)", borderRadius: 6, padding: "0.75rem" }}>
                  <label style={{ fontSize: "0.8rem" }}>
                    req.body (JSON)
                    <textarea
                      className="input"
                      rows={2}
                      style={{ fontFamily: "ui-monospace, monospace", marginTop: "0.25rem" }}
                      value={runBody}
                      onChange={(e) => setRunBody(e.target.value)}
                    />
                  </label>
                  <div style={{ marginTop: "0.5rem" }}>
                    <button className="btn btn-primary" onClick={() => handleRun(fn)}>
                      Jalankan
                    </button>
                    <button className="btn" onClick={() => setRunning(null)} style={{ marginLeft: "0.4rem" }}>
                      Tutup
                    </button>
                  </div>
                  {runResult && (
                    <div style={{ marginTop: "0.6rem", fontSize: "0.82rem" }}>
                      <div>
                        {runResult.ok ? "✅" : "❌"} <strong>{runResult.durationMs}ms</strong>
                        {runResult.timedOut && " ⏱ timeout"}
                      </div>
                      {runResult.error && <div style={{ color: "var(--red, #c62828)" }}>{runResult.error}</div>}
                      {runResult.result !== undefined && runResult.result !== null && (
                        <pre style={{ background: "var(--panel)", padding: "0.5rem", borderRadius: 4, overflowX: "auto" }}>
                          {JSON.stringify(runResult.result, null, 2)}
                        </pre>
                      )}
                      {runResult.logs.length > 0 && (
                        <details>
                          <summary className="muted" style={{ cursor: "pointer" }}>
                            console ({runResult.logs.length})
                          </summary>
                          <pre style={{ background: "var(--panel)", padding: "0.5rem", borderRadius: 4, overflowX: "auto" }}>
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
      </div>

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

function FunctionEditor({
  projectId,
  existing,
  collectionNames,
  onClose,
  onSaved,
}: {
  projectId: string;
  existing: StoredFunction | null;
  collectionNames: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [code, setCode] = useState(existing?.code ?? DEFAULT_CODE);
  const [timeoutMs, setTimeoutMs] = useState(String(existing?.timeoutMs ?? 2000));
  const [schedule, setSchedule] = useState(existing?.schedule ?? "");
  const [triggers, setTriggers] = useState<FunctionTrigger[]>(existing?.triggers ?? []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  function updateTrigger(idx: number, patch: Partial<FunctionTrigger>) {
    setTriggers(triggers.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  }

  function toggleAction(idx: number, action: string) {
    const t = triggers[idx];
    const has = t.actions.includes(action);
    updateTrigger(idx, {
      actions: has ? t.actions.filter((a) => a !== action) : [...t.actions, action],
    });
  }

  async function handleSave() {
    setSaving(true);
    setErr("");
    try {
      const payload = {
        code,
        timeoutMs: parseInt(timeoutMs, 10) || 2000,
        schedule: schedule.trim() === "" ? null : schedule.trim(),
        triggers,
      };
      if (existing) {
        await updateFunction(projectId, existing.name, payload);
      } else {
        await createFunction(projectId, { name, ...payload });
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Gagal menyimpan");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720, width: "95%" }}>
        <h3>{existing ? `Edit: ${existing.name}` : "Function baru"}</h3>

        {!existing && (
          <label style={{ display: "block", marginBottom: "0.75rem" }}>
            Nama function * <span className="muted">(a-z, 0-9, _, diawali huruf)</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="hitung_total" />
          </label>
        )}

        <label style={{ display: "block", marginBottom: "0.75rem" }}>
          Kode * <span className="muted">(return value → JSON response)</span>
          <textarea
            className="input"
            rows={10}
            style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.85rem" }}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
          />
        </label>

        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <label style={{ flex: 1, minWidth: 140 }}>
            Timeout (ms)
            <input className="input" type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} min={100} max={30000} />
          </label>
          <label style={{ flex: 2, minWidth: 200 }}>
            Schedule (cron, kosongkan jika bukan scheduled){" "}
            <span className="muted">mis. 0 1 * * * = harian 01:00</span>
            <input className="input" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="* * * * *" />
          </label>
        </div>

        {/* Triggers */}
        <div style={{ marginBottom: "0.75rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>🔗 Triggers</span>
            <button
              className="btn btn-secondary"
              onClick={() => setTriggers([...triggers, { collection: collectionNames[0] ?? "", actions: ["create"] }])}
              disabled={collectionNames.length === 0}
            >
              + Trigger
            </button>
          </div>
          {collectionNames.length === 0 && (
            <p className="muted" style={{ fontSize: "0.78rem" }}>
              Buat collection dulu di menu Database untuk memakai trigger.
            </p>
          )}
          {triggers.map((t, idx) => (
            <div key={idx} style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.4rem", flexWrap: "wrap" }}>
              <select
                className="input"
                style={{ maxWidth: 180 }}
                value={t.collection}
                onChange={(e) => updateTrigger(idx, { collection: e.target.value })}
              >
                {collectionNames.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              {["create", "update", "delete"].map((action) => (
                <label key={action} style={{ fontSize: "0.8rem", display: "flex", gap: "0.2rem", alignItems: "center" }}>
                  <input type="checkbox" checked={t.actions.includes(action)} onChange={() => toggleAction(idx, action)} />
                  {action}
                </label>
              ))}
              <button className="btn btn-danger" onClick={() => setTriggers(triggers.filter((_, i) => i !== idx))}>
                ✕
              </button>
            </div>
          ))}
        </div>

        {err && <div className="error-text">{err}</div>}

        <div className="form-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" onClick={handleSave} disabled={saving || (!existing && !name)}>
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  );
}
