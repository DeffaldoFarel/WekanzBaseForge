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
  Check,
  Loader2,
  ShieldCheck,
  Zap,
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
  const [firstProjectName, setFirstProjectName] = useState("my-first-app");
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

  async function handleCreate(projectName: string) {
    if (!projectName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const p = await createProject(projectName.trim());
      // If first project, redirect directly into the project studio!
      if (projects.length === 0) {
        router.push(`/projects/${p.id}`);
        return;
      }
      setProjects([p, ...projects]);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  if (!loaded) return null;

  return (
    <>
      <Navbar />

      <div className="page" style={{ maxWidth: "1200px" }}>
        {projects.length === 0 ? (
          /* ─── ZERO-STATE GUIDED ONBOARDING (SUPABASE PATTERN) ─── */
          <div className="max-w-2xl mx-auto py-8 sm:py-14 px-4 text-left">
            <div className="border border-zinc-200 rounded-2xl bg-white shadow-sm overflow-hidden">
              {/* Card Header */}
              <div className="p-6 sm:p-8 border-b border-zinc-100">
                <div className="w-10 h-10 rounded-xl bg-[#3ECF8E] text-white flex items-center justify-center mb-4 shadow-sm">
                  <Zap className="w-5 h-5 fill-white" />
                </div>
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-zinc-900">
                  Create your first project
                </h1>
                <p className="text-xs sm:text-sm text-zinc-500 mt-1.5 leading-relaxed">
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
                <div className="divide-y divide-zinc-100">
                  {/* Row 1: Name */}
                  <div className="p-6 sm:p-8 grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
                    <div>
                      <label htmlFor="projectName" className="text-sm font-semibold text-zinc-900 block">
                        Project Name
                      </label>
                      <span className="text-xs text-zinc-400 font-normal">Required</span>
                    </div>
                    <div className="sm:col-span-2 space-y-1.5">
                      <Input
                        id="projectName"
                        value={firstProjectName}
                        onChange={(e) => setFirstProjectName(e.target.value)}
                        placeholder="e.g. my-first-app"
                        required
                        className="h-10 bg-[#f9fafb] border-zinc-300 rounded-md text-sm px-3.5 focus-visible:ring-1 focus-visible:ring-zinc-400"
                      />
                      <p className="text-xs text-zinc-500">
                        What is the name of your application? You can change this later.
                      </p>
                    </div>
                  </div>

                  {/* Row 2: Database Engine */}
                  <div className="p-6 sm:p-8 grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
                    <div>
                      <span className="text-sm font-semibold text-zinc-900 block">
                        Database Engine
                      </span>
                    </div>
                    <div className="sm:col-span-2 space-y-1.5">
                      <div className="h-10 px-3.5 bg-zinc-50 border border-zinc-200 rounded-md flex items-center justify-between text-sm font-medium text-zinc-800">
                        <span>SQLite 3 (WAL Mode)</span>
                        <span className="text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full">
                          Zero-latency
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500">
                        High-performance relational SQL database with full ACID compliance and automatic table rebuild migrations.
                      </p>
                    </div>
                  </div>

                  {/* Row 3: Plan */}
                  <div className="p-6 sm:p-8 grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
                    <div>
                      <span className="text-sm font-semibold text-zinc-900 block">
                        Platform Plan
                      </span>
                    </div>
                    <div className="sm:col-span-2 space-y-1.5">
                      <div className="h-10 px-3.5 bg-zinc-50 border border-zinc-200 rounded-md flex items-center justify-between text-sm font-medium text-zinc-800">
                        <span>Developer Edition - $0/month</span>
                        <Check className="w-4 h-4 text-emerald-600" />
                      </div>
                      <p className="text-xs text-zinc-500">
                        Self-hosted on your local infrastructure with unlimited databases, storage, and serverless functions.
                      </p>
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="mx-6 sm:mx-8 mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs font-medium">
                    {error}
                  </div>
                )}

                {/* Footer Buttons */}
                <div className="p-6 sm:p-8 bg-zinc-50/70 border-t border-zinc-200 flex justify-end items-center gap-3">
                  <Button
                    type="submit"
                    disabled={creating || !firstProjectName.trim()}
                    className="h-10 px-6 bg-[#3ECF8E] hover:bg-[#34b27b] text-zinc-900 font-semibold rounded-md border-0 gap-2 shadow-sm transition-all"
                  >
                    {creating ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-zinc-900" />
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
                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">
                  Platform Projects
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Manage relational databases, physical file storage, and serverless functions across your applications.
                </p>
              </div>

              <div className="bg-white px-4 py-1.5 rounded-full text-xs font-semibold text-foreground border border-border shadow-sm flex items-center gap-1.5 shrink-0">
                <Layers className="w-3.5 h-3.5 text-brand-blue" />
                <span>Total: </span>
                <span className="text-brand-blue font-bold">{projects.length} {projects.length === 1 ? "Project" : "Projects"}</span>
              </div>
            </div>

            {/* Create Project Card Form */}
            <Card className="p-4 sm:p-5 mb-6 rounded-[24px]">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleCreate(name);
                }}
                className="flex flex-col sm:flex-row gap-3 items-center"
              >
                <div className="relative flex-1 w-full">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground">
                    <Sparkles className="w-4 h-4 text-brand-blue" />
                  </span>
                  <Input
                    className="pl-11 h-11"
                    placeholder="Enter new project name (e.g. ecommerce-api)..."
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <Button type="submit" className="h-11 px-6 w-full sm:w-auto shrink-0" disabled={creating || !name.trim()}>
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
                        <span>Created on {new Date(p.created).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}</span>
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
          </>
        )}
      </div>
    </>
  );
}
