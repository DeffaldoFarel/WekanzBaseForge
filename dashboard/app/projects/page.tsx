"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { listProjects, createProject, getToken, getProjectStats, type Project, type ProjectStats } from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToasts, ToastHost } from "@/components/ui/toast";
import {
  FolderKanban,
  Plus,
  Database,
  HardDrive,
  Code2,
  Calendar,
  Sparkles,
  ArrowRight,
  Layers,
  Check,
  Loader2,
  ShieldCheck,
  Zap,
  Search,
  ArrowUpDown,
  Activity,
} from "lucide-react";

const SERVICE_CAPABILITIES = [
  { key: "database", label: "Database & Auth", icon: Database },
  { key: "storage", label: "Storage", icon: HardDrive },
  { key: "functions", label: "Functions", icon: Code2 },
] as const;

// Nama project bebas (server hanya menolak kosong) — tapi klien tetap
// memberi batas masuk akal agar nama rapi & aman dipakai di URL/label.
const MAX_PROJECT_NAME = 64;

type SortKey = "newest" | "oldest" | "name";

// ─── Kartu project dengan statistik ringkas (lazy-load per kartu) ───────────
// Stats diambil SETELAH daftar project tampil — 407 project dev tidak boleh
// memblokir render awal. Endpoint stats murah (agregat harian tersimpan).
function ProjectCard({ project }: { project: Project }) {
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProjectStats(project.id)
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => { if (!cancelled) setStatsFailed(true); });
    return () => { cancelled = true; };
  }, [project.id]);
  return (
    <Link href={`/projects/${project.id}`} className="group">
      <Card className="p-5 hover:border-foreground/20 transition-colors flex flex-col justify-between h-full">
        <div>
          <div className="flex justify-between items-start mb-4">
            <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center border border-border">
              <FolderKanban className="w-5 h-5 text-muted-foreground group-hover:text-foreground transition-colors" />
            </div>
            <span className="font-mono text-[11px] text-muted-foreground bg-secondary px-2 py-0.5 rounded border border-border">
              {project.id}
            </span>
          </div>

          <h3 className="text-base font-semibold text-foreground mb-1 flex items-center justify-between">
            <span>{project.name}</span>
            <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 -translate-x-1 group-hover:translate-x-0 transition-all text-muted-foreground" />
          </h3>

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
            <Calendar className="w-3.5 h-3.5" />
            <span>Created on {new Date(project.created).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}</span>
          </div>

          {/* Statistik ringkas: requests hari ini + total selama periode monitor */}
          {!statsFailed && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground mb-4 min-h-[20px]">
              {stats ? (
                <>
                  <span className="flex items-center gap-1.5" title="Requests today (all services)">
                    <Activity className="w-3.5 h-3.5 text-brand" />
                    <span className="font-mono text-foreground font-medium">{stats.today.requests.toLocaleString()}</span>
                    <span>today</span>
                  </span>
                  <span className="text-border">·</span>
                  <span className="flex items-center gap-1.5" title="Total requests over the monitoring window (14 days)">
                    <span className="font-mono text-foreground font-medium">{stats.totals.requests.toLocaleString()}</span>
                    <span>total requests</span>
                  </span>
                </>
              ) : (
                <span className="flex items-center gap-2 text-muted-foreground/70">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span className="text-[11px]">Loading stats…</span>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Service badges — data riil dari project, bukan hardcode */}
        <div className="flex flex-wrap gap-1.5 pt-3 border-t border-border">
          {SERVICE_CAPABILITIES.filter((item) => {
            // "Database & Auth" hanya tampil bila keduanya aktif
            if (item.key === "database") return project.services.database && project.services.auth;
            return project.services[item.key];
          }).map((item) => {
            const Icon = item.icon;
            return (
              <Badge
                key={item.key}
                variant="secondary"
                className="text-[11px]"
              >
                <Icon className="w-3 h-3" />
                {item.label}
              </Badge>
            );
          })}
          {!project.services.storage && !project.services.functions && !(project.services.database && project.services.auth) && (
            <span className="text-[11px] text-muted-foreground italic">No services enabled</span>
          )}
        </div>
      </Card>
    </Link>
  );
}

// memo: parent re-render (ketikan di form create / search / sort) tidak boleh
// me-render ulang 400+ kartu yang props-nya tidak berubah.
const MemoProjectCard = memo(ProjectCard);

// Form create dipisah ke komponen sendiri supaya state ketikan `name` TIDAK
// me-render ulang seluruh halaman (akar penyebab lag: 400+ kartu ikut re-render
// di setiap keystroke).
function CreateProjectForm({
  onCreate,
  creating,
  error,
}: {
  onCreate: (name: string) => void;
  creating: boolean;
  error: string;
}) {
  const [name, setName] = useState("");
  return (
    <Card className="p-4 sm:p-5 mb-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(name);
          setName("");
        }}
        className="flex flex-col sm:flex-row gap-3 items-center"
      >
        <div className="relative flex-1 w-full">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
            <Sparkles className="w-4 h-4" />
          </span>
          <Input
            className="pl-10 h-10"
            placeholder="Enter new project name (e.g. ecommerce-api)..."
            value={name}
            maxLength={MAX_PROJECT_NAME}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" className="h-10 px-5 w-full sm:w-auto shrink-0" disabled={creating || !name.trim()}>
          {creating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Creating...</span>
            </>
          ) : (
            <>
              <Plus className="w-4 h-4" />
              <span>New Project</span>
            </>
          )}
        </Button>
      </form>
      {error && <p className="text-destructive text-xs font-medium mt-3">{error}</p>}
    </Card>
  );
}

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [firstProjectName, setFirstProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  // Debounce: jangan filter 400+ kartu di setiap keystroke
  const [searchDebounced, setSearchDebounced] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");

  const { toasts, success: toastSuccess, error: toastError, dismiss } = useToasts();

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    listProjects()
      .then((p) => setProjects(p))
      .catch(() => router.replace("/login"))
      .finally(() => setLoaded(true));
  }, [router]);

  // ─── Search + sort (client-side — daftar project selalu kecil) ───
  const visibleProjects = useMemo(() => {
    const q = searchDebounced.trim().toLowerCase();
    let list = projects;
    if (q) {
      list = list.filter(
        (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
      );
    }
    const sorted = [...list];
    if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "oldest") sorted.sort((a, b) => a.created.localeCompare(b.created));
    else sorted.sort((b, a) => a.created.localeCompare(b.created)); // newest
    return sorted;
  }, [projects, searchDebounced, sort]);

  async function handleCreate(projectName: string) {
    const trimmed = projectName.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_PROJECT_NAME) {
      setError(`Project name is too long (max ${MAX_PROJECT_NAME} characters).`);
      return;
    }
    setCreating(true);
    setError("");
    try {
      const p = await createProject(trimmed);
      // Project pertama: langsung masuk ke studio (guided onboarding)
      if (projects.length === 0) {
        router.push(`/projects/${p.id}`);
        return;
      }
      setProjects([p, ...projects]);
      toastSuccess(`Project "${p.name}" created.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create project";
      setError(msg);
      toastError(msg);
    } finally {
      setCreating(false);
    }
  }

  if (!loaded) {
    // Skeleton loading — bukan blank putih (konsisten dengan halaman lain)
    return (
      <>
        <Navbar />
        <div className="max-w-[1200px] mx-auto px-6 py-6">
          <div className="h-9 w-56 bg-secondary rounded-md animate-pulse mb-6" />
          <div className="h-16 bg-secondary/60 rounded-lg animate-pulse mb-6" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-44 bg-secondary/40 rounded-lg animate-pulse" />
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />

      <div className="max-w-[1200px] mx-auto px-6 py-6">
        {projects.length === 0 ? (
          /* ─── ZERO-STATE GUIDED ONBOARDING (SUPABASE PATTERN) ─── */
          <div className="max-w-2xl mx-auto py-8 sm:py-14 px-4 text-left">
            <div className="border border-border rounded-xl bg-card overflow-hidden">
              {/* Card Header */}
              <div className="p-6 sm:p-8 border-b border-border">
                <div className="w-10 h-10 rounded-md bg-brand text-background flex items-center justify-center mb-4">
                  <Zap className="w-5 h-5 fill-background" />
                </div>
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                  Create your first project
                </h1>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 leading-relaxed">
                  Projects are isolated environments for your SQLite database, user authentication, file storage, and serverless functions.
                </p>
              </div>

              {/* Form Rows */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleCreate(firstProjectName);
                }}
              >
                <div className="divide-y divide-border">
                  {/* Row 1: Name */}
                  <div className="p-6 sm:p-8 grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
                    <div>
                      <label htmlFor="projectName" className="text-sm font-medium text-foreground block">
                        Project Name
                      </label>
                      <span className="text-xs text-muted-foreground font-normal">Required</span>
                    </div>
                    <div className="sm:col-span-2 space-y-1.5">
                      <Input
                        id="projectName"
                        value={firstProjectName}
                        onChange={(e) => setFirstProjectName(e.target.value)}
                        placeholder="e.g. my-first-app"
                        required
                      />
                      <p className="text-xs text-muted-foreground">
                        What is the name of your application? You can change this later.
                      </p>
                    </div>
                  </div>

                  {/* Row 2: Database Engine */}
                  <div className="p-6 sm:p-8 grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
                    <div>
                      <span className="text-sm font-medium text-foreground block">
                        Database Engine
                      </span>
                    </div>
                    <div className="sm:col-span-2 space-y-1.5">
                      <div className="h-10 px-3.5 bg-secondary border border-border rounded-md flex items-center justify-between text-sm font-medium text-foreground">
                        <span>SQLite 3 (WAL Mode)</span>
                        <Badge variant="green" className="text-[11px]">
                          Zero-latency
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        High-performance relational SQL database with full ACID compliance and automatic table rebuild migrations.
                      </p>
                    </div>
                  </div>

                  {/* Row 3: Plan */}
                  <div className="p-6 sm:p-8 grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
                    <div>
                      <span className="text-sm font-medium text-foreground block">
                        Platform Plan
                      </span>
                    </div>
                    <div className="sm:col-span-2 space-y-1.5">
                      <div className="h-10 px-3.5 bg-secondary border border-border rounded-md flex items-center justify-between text-sm font-medium text-foreground">
                        <span>Developer Edition - $0/month</span>
                        <Check className="w-4 h-4 text-emerald-400" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Self-hosted on your local infrastructure with unlimited databases, storage, and serverless functions.
                      </p>
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="mx-6 sm:mx-8 mb-4 p-3 rounded-md bg-destructive/10 border border-destructive/40 text-destructive text-xs font-medium">
                    {error}
                  </div>
                )}

                {/* Footer Buttons */}
                <div className="p-6 sm:p-8 border-t border-border flex justify-end items-center gap-3">
                  <Button
                    type="submit"
                    disabled={creating || !firstProjectName.trim()}
                    className="h-10 px-6 gap-2"
                  >
                    {creating ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Provisioning project...</span>
                      </>
                    ) : (
                      <>
                        <span>Create project</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        ) : (
          /* ─── STANDARD PROJECTS GRID ─── */
          <>
            {/* Header Section */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4 mb-6">
              <div>
                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
                  Platform Projects
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Manage relational databases, physical file storage, and serverless functions across your applications.
                </p>
              </div>

              <div className="bg-secondary px-3.5 py-1.5 rounded-md text-xs font-medium text-muted-foreground border border-border flex items-center gap-1.5 shrink-0">
                <Layers className="w-3.5 h-3.5" />
                <span>Total:</span>
                <span className="text-foreground font-semibold">{projects.length} {projects.length === 1 ? "Project" : "Projects"}</span>
              </div>
            </div>

            {/* Search + sort — daftar project makin panjang, wajib bisa dicari */}
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
              <div className="relative flex-1">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
                  <Search className="w-4 h-4" />
                </span>
                <Input
                  className="pl-10 h-10"
                  placeholder="Search projects by name or id..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="relative shrink-0">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
                  <ArrowUpDown className="w-3.5 h-3.5" />
                </span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="h-10 pl-9 pr-8 rounded-md bg-secondary border border-border text-sm text-foreground appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label="Sort projects"
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="name">Name (A–Z)</option>
                </select>
              </div>
            </div>

            {/* Create Project Card Form — komponen terpisah: ketikan di sini
                tidak me-render ulang 400+ kartu project */}
            <CreateProjectForm onCreate={handleCreate} creating={creating} error={error} />

            {/* Project Grid */}
            {visibleProjects.length === 0 ? (
              <Card className="p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No projects match <code className="font-mono text-foreground">"{search.trim()}"</code>.
                </p>
              </Card>
            ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleProjects.map((p) => (
                <MemoProjectCard key={p.id} project={p} />
              ))}
            </div>
            )}
          </>
        )}
      </div>

      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
