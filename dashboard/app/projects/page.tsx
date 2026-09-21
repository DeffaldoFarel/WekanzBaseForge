"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  listProjectsPage,
  createProject,
  getToken,
  getProjectsStatsBatch,
  type Project,
  type ProjectStatsSummary,
  type ProjectSort,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToasts, ToastHost } from "@/components/ui/toast";
import { errorMessage } from "@/components/ui/load-error";
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
  Loader2,
  Search,
  ArrowUpDown,
  Activity,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

const SERVICE_CAPABILITIES = [
  { key: "database", label: "Database & Auth", icon: Database },
  { key: "storage", label: "Storage", icon: HardDrive },
  { key: "functions", label: "Functions", icon: Code2 },
] as const;

// Nama project bebas (server hanya menolak kosong) — tapi klien tetap
// memberi batas masuk akal agar nama rapi & aman dipakai di URL/label.
const MAX_PROJECT_NAME = 64;

// Ukuran halaman. Angka ini menentukan JUMLAH NODE DOM sekaligus jumlah id
// yang dikirim ke endpoint stats batch — 24 habis dibagi grid 1/2/3 kolom
// sehingga baris terakhir tidak pernah timpang.
const PER_PAGE = 24;

// ─── Kartu project ───────────────────────────────────────────────────────────
// Murni presentasional: stats DITERIMA dari parent, tidak di-fetch sendiri.
// Versi lama memanggil satu endpoint /stats per kartu — 400 kartu = 400
// request HTTP yang diantre browser 6-per-host, jadi kartu terakhir baru
// terisi belasan detik kemudian.
function ProjectCard({
  project,
  stats,
  statsPending,
  statsError,
}: {
  project: Project;
  stats: ProjectStatsSummary | null;
  statsPending: boolean;
  statsError?: string;
}) {
  return (
    <Link
      href={`/projects/${project.id}`}
      className="group rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
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
            <ArrowRight
              aria-hidden="true"
              className="w-4 h-4 opacity-0 group-hover:opacity-100 -translate-x-1 group-hover:translate-x-0 transition-all text-muted-foreground"
            />
          </h3>

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
            <Calendar aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Created on {new Date(project.created).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}</span>
          </div>

          {/* Statistik ringkas: requests hari ini + total 14 hari terakhir */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground mb-4 min-h-[20px]">
            {stats ? (
              <>
                <span className="flex items-center gap-1.5" title="Requests today (all services)">
                  <Activity aria-hidden="true" className="w-3.5 h-3.5 text-brand" />
                  <span className="font-mono text-foreground font-medium">{stats.today.requests.toLocaleString()}</span>
                  <span>today</span>
                </span>
                <span aria-hidden="true" className="text-border">·</span>
                <span className="flex items-center gap-1.5" title="Total requests recorded over the monitoring window (14 days)">
                  <span className="font-mono text-foreground font-medium">{stats.totals.requests.toLocaleString()}</span>
                  <span>total requests</span>
                </span>
              </>
            ) : statsPending ? (
              <span className="flex items-center gap-2 text-muted-foreground/70">
                <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin" />
                <span className="text-[11px]">Loading stats…</span>
              </span>
            ) : (
              /* Sebab ditampilkan, bukan sekadar "unavailable" — user tahu
                 apakah ini masalah jaringan, izin, atau server mati. */
              <span className="text-[11px] text-destructive/80" title={statsError || undefined}>
                {statsError ? `Usage stats unavailable — ${statsError}` : "Usage stats unavailable"}
              </span>
            )}
          </div>
        </div>

        {/* Service badges — data riil dari project, bukan hardcode */}
        <div className="flex flex-wrap gap-1.5 pt-3 border-t border-border">
          {(() => {
            // Satu sumber kebenaran: daftar layanan aktif dihitung SEKALI,
            // lalu dipakai untuk badge maupun pesan kosong. Versi lama
            // mengulang aturan yang sama di dua tempat dan bisa drift.
            const active = SERVICE_CAPABILITIES.filter((item) =>
              // "Database & Auth" hanya tampil bila keduanya aktif
              item.key === "database"
                ? project.services.database && project.services.auth
                : project.services[item.key]
            );
            if (active.length === 0) {
              return <span className="text-[11px] text-muted-foreground italic">No services enabled</span>;
            }
            return active.map((item) => {
              const Icon = item.icon;
              return (
                <Badge key={item.key} variant="secondary" className="text-[11px]">
                  <Icon aria-hidden="true" className="w-3 h-3" />
                  {item.label}
                </Badge>
              );
            });
          })()}
        </div>
      </Card>
    </Link>
  );
}

// memo: mengetik di form create / search tidak boleh me-render ulang kartu
// yang props-nya tidak berubah.
const MemoProjectCard = memo(ProjectCard);

// Form create dipisah ke komponen sendiri supaya state ketikan `name` TIDAK
// me-render ulang seluruh halaman (akar penyebab lag: kartu project ikut
// re-render di setiap keystroke).
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
          <span aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
            <Sparkles className="w-4 h-4" />
          </span>
          <Input
            className="pl-10 h-10"
            aria-label="New project name"
            placeholder="Enter new project name (e.g. ecommerce-api)..."
            value={name}
            maxLength={MAX_PROJECT_NAME}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" className="h-10 px-5 w-full sm:w-auto shrink-0" disabled={creating || !name.trim()}>
          {creating ? (
            <>
              <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />
              <span>Creating...</span>
            </>
          ) : (
            <>
              <Plus aria-hidden="true" className="w-4 h-4" />
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
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [listPending, setListPending] = useState(false);
  const [search, setSearch] = useState("");
  // Debounce: setiap keystroke tidak boleh jadi satu request ke server
  const [searchDebounced, setSearchDebounced] = useState("");
  const [sort, setSort] = useState<ProjectSort>("newest");

  const [stats, setStats] = useState<Record<string, ProjectStatsSummary>>({});
  const [statsPending, setStatsPending] = useState(false);
  const [statsError, setStatsError] = useState("");

  const { toasts, success: toastSuccess, error: toastError, dismiss } = useToasts();

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Search/sort berubah -> selalu balik ke halaman 1, kalau tidak user bisa
  // terdampar di halaman 7 dari hasil yang cuma punya 2 halaman.
  useEffect(() => {
    setPage(1);
  }, [searchDebounced, sort]);

  // ─── Muat satu halaman project ────────────────────────────────────────────
  // AbortController: ketikan cepat menghasilkan beberapa request; tanpa ini
  // respons yang datang terlambat bisa menimpa hasil yang lebih baru.
  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    const ac = new AbortController();
    setListPending(true);
    listProjectsPage({ page, perPage: PER_PAGE, search: searchDebounced, sort, signal: ac.signal })
      .then((res) => {
        setProjects(res.projects);
        setTotal(res.total);
        setTotalPages(res.totalPages);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        toastError(err instanceof Error ? err.message : "Failed to load projects");
      })
      .finally(() => {
        if (!ac.signal.aborted) {
          setListPending(false);
          setLoaded(true);
        }
      });
    return () => ac.abort();
  }, [page, searchDebounced, sort, router, toastError]);

  // ─── Stats untuk kartu yang TAMPIL — satu request untuk seluruh halaman ───
  const visibleIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const visibleIdsKey = visibleIds.join(",");

  useEffect(() => {
    if (!visibleIdsKey) {
      setStatsPending(false);
      return;
    }
    const ids = visibleIdsKey.split(",");
    const ac = new AbortController();
    setStatsPending(true);
    getProjectsStatsBatch(ids, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        // Merge, bukan replace: stats halaman sebelumnya tetap hangat kalau
        // user bolak-balik antar halaman.
        setStats((prev) => ({ ...prev, ...res }));
        setStatsError("");
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        // Stats bersifat pelengkap — kegagalannya TIDAK boleh merusak daftar
        // project. Tapi tetap harus terlihat: kartu menampilkan sebabnya
        // alih-alih hanya "unavailable" tanpa keterangan.
        setStatsError(errorMessage(e, "Usage stats unavailable"));
      })
      .finally(() => {
        if (!ac.signal.aborted) setStatsPending(false);
      });
    return () => ac.abort();
  }, [visibleIdsKey]);

  const resetToFirstPage = useCallback(() => {
    setPage(1);
    setSearch("");
    setSearchDebounced("");
  }, []);

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
      if (total === 0) {
        router.push(`/projects/${p.id}`);
        return;
      }
      toastSuccess(`Project "${p.name}" created.`);
      // Sumber kebenaran urutan & total ada di server. Kalau user sedang
      // berada di halaman 1 tanpa filter dengan sort "newest", project baru
      // memang seharusnya muncul paling atas — sisipkan langsung. Di kondisi
      // lain (terfilter / halaman N / sort lain) posisinya belum tentu di
      // sini, jadi minta server menghitung ulang.
      if (page === 1 && !searchDebounced && sort === "newest") {
        setProjects((prev) => [p, ...prev].slice(0, PER_PAGE));
        setTotal((t) => t + 1);
      } else {
        setSort("newest");
        resetToFirstPage();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create project";
      // Satu pesan di satu tempat: inline untuk konteks form, tanpa toast
      // duplikat yang mengatakan hal yang sama.
      setError(msg);
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
            <Layers aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Total:</span>
            <span className="text-foreground font-semibold">{total} {total === 1 ? "Project" : "Projects"}</span>
          </div>
        </div>

        {/* Search + sort — dikerjakan SERVER, jadi tetap akurat lintas halaman */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="relative flex-1">
            <span aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Search className="w-4 h-4" />
            </span>
            <Input
              className="pl-10 pr-9 h-10"
              aria-label="Search projects by name or id"
              placeholder="Search projects by name or id..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                &times;
              </button>
            )}
          </div>
          <div className="relative shrink-0">
            <span aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
              <ArrowUpDown className="w-3.5 h-3.5" />
            </span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as ProjectSort)}
              className="h-10 pl-9 pr-8 rounded-md bg-secondary border border-border text-sm text-foreground appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label="Sort projects"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name (A-Z)</option>
            </select>
          </div>
        </div>

        {/* Create Project Card Form — komponen terpisah: ketikan di sini
            tidak me-render ulang kartu project */}
        <CreateProjectForm onCreate={handleCreate} creating={creating} error={error} />

        {/* Status hasil untuk screen reader — jumlah yang berubah tanpa
            pengumuman adalah kegagalan a11y umum di list terfilter */}
        <p aria-live="polite" className="sr-only">
          {listPending
            ? "Loading projects"
            : `${total} project${total === 1 ? "" : "s"} found${searchDebounced ? ` for ${searchDebounced}` : ""}`}
        </p>

        {/* Project Grid / Empty State */}
        {projects.length === 0 ? (
          search.trim() ? (
            /* Kasus A: User mencari kata tertentu, tetapi tidak ada hasil yang cocok */
            <Card className="p-12 text-center border-dashed">
              <div className="w-12 h-12 rounded-full bg-secondary border border-border flex items-center justify-center mx-auto mb-3 text-muted-foreground">
                <Search aria-hidden="true" className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-1">
                No matching projects
              </h3>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto mb-4">
                No projects match <code className="font-mono text-foreground font-medium">&quot;{search.trim()}&quot;</code>.
              </p>
              <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={() => setSearch("")}>
                Clear search
              </Button>
            </Card>
          ) : (
            /* Kasus B: Registry project memang kosong (0 project, bukan hasil search) */
            <Card className="p-12 text-center border-dashed">
              <div className="w-12 h-12 rounded-xl bg-secondary border border-border flex items-center justify-center mx-auto mb-3 text-muted-foreground">
                <FolderKanban aria-hidden="true" className="w-6 h-6" />
              </div>
              <h3 className="text-base font-semibold text-foreground mb-1">
                No projects yet
              </h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Projects are isolated environments for your SQLite database, user authentication, file storage, and serverless functions.
                Enter a project name above and click <span className="text-foreground font-medium">New Project</span> to get started.
              </p>
            </Card>
          )
        ) : (
          <div
            className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 transition-opacity ${
              listPending ? "opacity-60" : "opacity-100"
            }`}
          >
            {projects.map((p) => (
              <MemoProjectCard
                key={p.id}
                project={p}
                stats={stats[p.id] ?? null}
                statsPending={statsPending}
                statsError={statsError}
              />
            ))}
          </div>
        )}

        {/* ─── Paginasi ─── */}
        {totalPages > 1 && (
          <nav
            aria-label="Projects pagination"
            className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-6"
          >
            <p className="text-xs text-muted-foreground">
              Showing{" "}
              <span className="text-foreground font-medium">
                {(page - 1) * PER_PAGE + 1}-{Math.min(page * PER_PAGE, total)}
              </span>{" "}
              of <span className="text-foreground font-medium">{total}</span>
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="h-9 px-3"
                disabled={page <= 1 || listPending}
                onClick={() => setPage((p) => Math.max(p - 1, 1))}
              >
                <ChevronLeft aria-hidden="true" className="w-4 h-4" />
                <span>Previous</span>
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums px-1">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                className="h-9 px-3"
                disabled={page >= totalPages || listPending}
                onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
              >
                <span>Next</span>
                <ChevronRight aria-hidden="true" className="w-4 h-4" />
              </Button>
            </div>
          </nav>
        )}
      </div>

      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
