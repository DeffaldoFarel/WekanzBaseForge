"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import {
  getProject,
  getProjectStats,
  formatBytes,
  deleteProject,
  getToken,
  createProjectApiKey,
  listProjectApiKeys,
  revokeProjectApiKey,
  type Project,
  type ProjectStats,
  type ProjectApiKey,
  type ApiKeyScope,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Trash2,
  CheckCircle2,
  Calendar,
  Hash,
  Globe,
  ChevronRight,
  Activity,
  ArrowUpDown,
  RefreshCw,
  KeyRound,
  Plus,
  Copy,
  Check,
  AlertTriangle,
} from "lucide-react";

export default function ProjectDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [error, setError] = useState("");

  // M26: API keys state
  const [apiKeys, setApiKeys] = useState<ProjectApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScope, setNewKeyScope] = useState<ApiKeyScope>("write");
  const [creatingKey, setCreatingKey] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null); // key penuh — sekali tampil
  const [copied, setCopied] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  function reloadKeys() {
    listProjectApiKeys(id).then(setApiKeys).catch(() => {});
  }

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    getProject(id)
      .then(setProject)
      .catch(() => setError("Project not found"));
    getProjectStats(id).then(setStats).catch(() => {});
    reloadKeys();
  }, [id, router]);

  // M24: refresh statistik tiap 30 detik (selaras interval flush server)
  useEffect(() => {
    const timer = setInterval(() => {
      getProjectStats(id).then(setStats).catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, [id]);

  async function handleCreateKey() {
    setCreatingKey(true);
    setKeyError("");
    try {
      const res = await createProjectApiKey(id, {
        name: newKeyName.trim() || undefined,
        scope: newKeyScope,
      });
      setFreshKey(res.key);
      setCopied(false);
      setNewKeyName("");
      reloadKeys();
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : "Failed to create API key");
    } finally {
      setCreatingKey(false);
    }
  }

  async function handleRevoke(keyId: string) {
    try {
      await revokeProjectApiKey(id, keyId);
      setConfirmRevoke(null);
      reloadKeys();
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : "Failed to revoke");
    }
  }

  async function onDelete() {
    if (!project) return;
    if (!confirm(`Permanently delete project "${project.name}"? All database records and storage files will be lost.`)) return;
    await deleteProject(project.id);
    router.replace("/projects");
  }

  if (error) {
    return (
      <div className="max-w-[1180px] mx-auto px-6 py-6">
        <Link href="/projects" className="text-sm text-muted-foreground hover:text-foreground">← Back to Projects</Link>
        <p className="text-destructive mt-2">{error}</p>
      </div>
    );
  }
  if (!project) return null;

  return (
    <>
      <Navbar projectId={project.id} projectName={project.name} />

      <div className="max-w-[1180px] mx-auto px-6 py-6 flex gap-6 items-start">
        {/* ─── PROJECT SIDEBAR ─── */}
        <ProjectSidebar projectId={project.id} projectName={project.name} />

        {/* ─── MAIN CONTENT ─── */}
        <div style={{ flex: 1, minWidth: 0 }}>
        {/* Breadcrumb & Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5 font-medium">
              <Link href="/projects" className="hover:text-foreground transition-colors">Projects</Link>
              <ChevronRight className="w-3.5 h-3.5" />
              <span className="text-foreground font-medium">{project.name}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
              {project.name}
            </h1>
          </div>

          <Button
            variant="destructive"
            size="sm"
            onClick={onDelete}
            className="gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete Project</span>
          </Button>
        </div>

        {/* Project Metadata Card */}
        <Card className="p-6 mb-8">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5" />
                <span>Project Identifier</span>
              </div>
              <div className="font-mono text-sm text-foreground">
                {project.id}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5" />
                <span>API Endpoint Base</span>
              </div>
              <div className="font-mono text-sm text-foreground">
                /api/p/{project.id}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" />
                <span>Created Date</span>
              </div>
              <div className="text-sm font-medium text-foreground">
                {new Date(project.created).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}
              </div>
            </div>
          </div>
        </Card>

        {/* Usage Statistics Card (M24: request & bandwidth) */}
        <Card className="p-6 mb-8">
          <div className="flex justify-between items-center mb-5">
            <div>
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Activity className="w-4 h-4 text-muted-foreground" />
                <span>Usage Statistics</span>
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                API requests &amp; bandwidth attributed to this project (14-day window).
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              title="Refresh statistics"
              onClick={() => getProjectStats(id).then(setStats).catch(() => {})}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>

          {stats && stats.totals.requests > 0 ? (
            <>
              {/* Stat tiles */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <div className="bg-secondary border border-border rounded-lg p-4">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5" />
                    <span>Requests Today</span>
                  </div>
                  <div className="text-2xl font-semibold text-foreground font-mono">
                    {stats.today.requests.toLocaleString("en-US")}
                  </div>
                </div>
                <div className="bg-secondary border border-border rounded-lg p-4">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5" />
                    <span>Requests Total</span>
                  </div>
                  <div className="text-2xl font-semibold text-foreground font-mono">
                    {stats.totals.requests.toLocaleString("en-US")}
                  </div>
                </div>
                <div className="bg-secondary border border-border rounded-lg p-4">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <ArrowUpDown className="w-3.5 h-3.5" />
                    <span>Bandwidth Today</span>
                  </div>
                  <div className="text-2xl font-semibold text-foreground font-mono">
                    {formatBytes(stats.today.bytesIn + stats.today.bytesOut)}
                  </div>
                </div>
                <div className="bg-secondary border border-border rounded-lg p-4">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <ArrowUpDown className="w-3.5 h-3.5" />
                    <span>Bandwidth Total</span>
                  </div>
                  <div className="text-2xl font-semibold text-foreground font-mono">
                    {formatBytes(stats.totals.bytesIn + stats.totals.bytesOut)}
                  </div>
                </div>
              </div>

              {/* 14-day charts */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <MiniBarChart
                  label="Requests / day"
                  days={stats.days}
                  value={(d) => d.requests}
                  formatValue={(v) => `${v.toLocaleString("en-US")} requests`}
                />
                <MiniBarChart
                  label="Bandwidth / day"
                  days={stats.days}
                  value={(d) => d.bytesIn + d.bytesOut}
                  formatValue={(v) => formatBytes(v)}
                />
              </div>
            </>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
              <Activity className="w-8 h-8 opacity-30" />
              <p>No traffic recorded yet — statistics appear as soon as requests hit this project&apos;s API.</p>
            </div>
          )}
        </Card>

        {/* API Keys Card (M26: server-to-server access) */}
        <Card className="p-6">
          <div className="flex justify-between items-center mb-5">
            <div>
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-muted-foreground" />
                <span>API Keys</span>
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Server-to-server access to this project&apos;s API — keys bypass API Rules (service-level).
              </p>
            </div>
            <Badge variant="secondary" className="text-[11px]">300 req/min per key</Badge>
          </div>

          {/* Fresh key banner — tampil sekali setelah dibuat */}
          {freshKey && (
            <div className="mb-5 p-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10">
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-xs font-medium text-emerald-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>API key created — copy it now, it will not be shown again.</span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    navigator.clipboard.writeText(freshKey);
                    setCopied(true);
                  }}
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <code className="block text-xs font-mono text-foreground bg-background border border-border rounded-md px-3 py-2 overflow-x-auto">
                {freshKey}
              </code>
              <div className="flex justify-end mt-2">
                <Button variant="ghost" size="sm" onClick={() => setFreshKey(null)}>
                  Done
                </Button>
              </div>
            </div>
          )}

          {keyError && (
            <div className="mb-4 p-3 rounded-md bg-destructive/10 border border-destructive/40 text-destructive text-xs flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{keyError}</span>
            </div>
          )}

          {/* Create form */}
          <div className="flex flex-col sm:flex-row gap-3 mb-5">
            <Input
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name (e.g. production-backend)"
              className="flex-[2]"
            />
            <div className="flex gap-1 bg-secondary p-1 rounded-lg border border-border shrink-0">
              {(["read", "write"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setNewKeyScope(s)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    newKeyScope === s ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                  title={s === "read" ? "GET requests only" : "All methods (records CRUD, aggregate, files)"}
                >
                  {s === "read" ? "Read only" : "Read + Write"}
                </button>
              ))}
            </div>
            <Button onClick={handleCreateKey} disabled={creatingKey} className="gap-1.5 shrink-0">
              {creatingKey ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              <span>Create Key</span>
            </Button>
          </div>

          {/* Key list */}
          {apiKeys.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No API keys yet — create one to enable server-to-server access.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {apiKeys.map((k) => (
                <div key={k.id} className="py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{k.name}</span>
                      <Badge variant={k.scope === "write" ? "green" : "secondary"} className="text-[10px]">
                        {k.scope === "write" ? "read+write" : "read only"}
                      </Badge>
                      <code className="text-xs font-mono text-muted-foreground">{k.hint}</code>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {k.requests.toLocaleString("en-US")} requests
                      {k.lastUsed ? ` · last used ${new Date(k.lastUsed).toLocaleString()}` : " · never used"}
                    </div>
                  </div>
                  {confirmRevoke === k.id ? (
                    <div className="flex items-center gap-1.5">
                      <Button variant="destructive" size="sm" onClick={() => handleRevoke(k.id)}>
                        Confirm Revoke
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setConfirmRevoke(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1.5"
                      onClick={() => setConfirmRevoke(k.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Revoke</span>
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Usage snippet */}
          <div className="mt-4 pt-4 border-t border-border">
            <p className="text-xs text-muted-foreground mb-2">Use the key from any server:</p>
            <code className="block text-xs font-mono text-foreground bg-secondary border border-border rounded-md px-3 py-2 overflow-x-auto whitespace-nowrap">
              curl -H "Authorization: Bearer bf_..." http://localhost:5100/api/p/{id}/collections/posts/records
            </code>
          </div>
        </Card>
        </div>
      </div>
    </>
  );
}

// ─── M24: mini bar chart 14 hari (CSS murni, tanpa chart library) ───────────

function MiniBarChart({
  label,
  days,
  value,
  formatValue,
}: {
  label: string;
  days: ProjectStats["days"];
  value: (d: ProjectStats["days"][number]) => number;
  formatValue: (v: number) => string;
}) {
  const max = Math.max(...days.map(value));
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-2">{label}</div>
      <div className="flex items-end gap-1 h-20">
        {days.map((d) => {
          const v = value(d);
          const pct = max > 0 ? Math.max((v / max) * 100, v > 0 ? 6 : 0) : 0;
          return (
            <div
              key={d.date}
              className="flex-1 h-full flex items-end"
              title={`${d.date}: ${formatValue(v)}`}
            >
              <div
                className={`w-full rounded-sm transition-colors ${
                  v > 0 ? "bg-muted-foreground/60 hover:bg-foreground" : "bg-secondary"
                }`}
                style={{ height: `${v > 0 ? Math.max(pct, 6) : 3}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5 font-mono">
        <span>{days[0].date.slice(5)}</span>
        <span>{days[days.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}
