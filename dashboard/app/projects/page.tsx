"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { listProjects, createProject, getToken, type Project } from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
} from "lucide-react";

const SERVICE_CAPABILITIES = [
  { key: "database", label: "Database & Auth", icon: Database },
  { key: "storage", label: "Storage", icon: HardDrive },
  { key: "functions", label: "Functions", icon: Code2 },
];

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

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

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError("");
    try {
      const p = await createProject(name.trim());
      setProjects([p, ...projects]);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membuat project");
    } finally {
      setCreating(false);
    }
  }

  if (!loaded) return null;

  return (
    <>
      <Navbar />

      <div className="page">
        {/* Header Section */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">
              Platform Projects
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Kelola database relasional, penyimpanan berkas fisik, dan serverless functions per project ekosistem Wekanz.
            </p>
          </div>

          <div className="bg-white px-4 py-1.5 rounded-full text-xs font-semibold text-foreground border border-border shadow-sm flex items-center gap-1.5 shrink-0">
            <Layers className="w-3.5 h-3.5 text-brand-blue" />
            <span>Total: </span>
            <span className="text-brand-blue font-bold">{projects.length} Projects</span>
          </div>
        </div>

        {/* Create Project Card Form */}
        <Card className="p-4 sm:p-5 mb-6 rounded-[24px]">
          <form onSubmit={onCreate} className="flex flex-col sm:flex-row gap-3 items-center">
            <div className="relative flex-1 w-full">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground">
                <Sparkles className="w-4 h-4 text-brand-blue" />
              </span>
              <Input
                className="pl-11 h-11"
                placeholder="Ketik nama project baru (contoh: wekanz-portal)..."
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="submit" className="h-11 px-6 w-full sm:w-auto shrink-0" disabled={creating || !name.trim()}>
              <Plus className="w-4 h-4" />
              <span>{creating ? "Membuat..." : "Buat Project Baru"}</span>
            </Button>
          </form>
          {error && <p className="error-text mt-3 text-xs">{error}</p>}
        </Card>

        {/* Project Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="group">
              <Card className="p-6 rounded-[24px] hover:border-slate-300 hover:-translate-y-1 hover:shadow-lg transition-all duration-200 flex flex-col justify-between h-full bg-white">
                <div>
                  <div className="flex justify-between items-start mb-4">
                    <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center border border-border group-hover:scale-105 transition-transform">
                      <FolderKanban className="w-6 h-6 text-slate-700" />
                    </div>
                    <span className="font-mono text-[11px] font-semibold bg-slate-100 text-slate-600 px-3 py-1 rounded-full border border-border">
                      {p.id}
                    </span>
                  </div>

                  <h3 className="text-lg font-bold text-foreground mb-1 group-hover:text-brand-blue transition-colors flex items-center justify-between">
                    <span>{p.name}</span>
                    <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 -translate-x-1 group-hover:translate-x-0 transition-all text-brand-blue" />
                  </h3>

                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4 font-medium">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>Dibuat {new Date(p.created).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}</span>
                  </div>
                </div>

                {/* Service Capability Badges */}
                <div className="flex flex-wrap gap-1.5 pt-3 border-t border-slate-100">
                  {SERVICE_CAPABILITIES.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Badge
                        key={item.key}
                        variant="secondary"
                        className="text-[11px] py-0.5 px-2.5 bg-slate-100/90 text-slate-600 font-medium"
                      >
                        <Icon className="w-3 h-3 text-slate-500 mr-1" />
                        {item.label}
                      </Badge>
                    );
                  })}
                </div>
              </Card>
            </Link>
          ))}
        </div>

        {projects.length === 0 && (
          <Card className="text-center py-16 px-6 mt-8 rounded-[28px]">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-slate-100 flex items-center justify-center mb-4 border border-border">
              <Sparkles className="w-8 h-8 text-brand-blue" />
            </div>
            <h3 className="text-lg font-bold text-foreground">Belum Ada Project</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto mt-1">
              Mulai buat project pertama kamu menggunakan form input di atas untuk mengelola database dan aset media.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
