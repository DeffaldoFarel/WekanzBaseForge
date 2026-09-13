"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import {
  getProject,
  deleteProject,
  getToken,
  type Project,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Database,
  HardDrive,
  Code2,
  Trash2,
  ArrowRight,
  CheckCircle2,
  Calendar,
  Hash,
  Globe,
  ChevronRight,
} from "lucide-react";

const PLATFORM_SERVICES = [
  {
    key: "database",
    title: "Database & Collections",
    icon: Database,
    desc: "Manage relational tables, dynamic schemas, SQL Views, and user authentication accounts.",
    href: (id: string) => `/projects/${id}/database`,
    tag: "PocketBase Parity",
    badgeVariant: "blue" as const,
  },
  {
    key: "storage",
    title: "Storage Explorer",
    icon: HardDrive,
    desc: "Physical file storage, image thumbnail caching, and automated orphaned files cleanup.",
    href: (id: string) => `/projects/${id}/storage`,
    tag: "File Storage",
    badgeVariant: "secondary" as const,
  },
  {
    key: "functions",
    title: "Functions & Scheduler",
    icon: Code2,
    desc: "Isolated JavaScript execution, event-driven CRUD triggers, and cron task scheduler.",
    href: (id: string) => `/projects/${id}/functions`,
    tag: "Serverless Engine",
    badgeVariant: "purple" as const,
  },
];

export default function ProjectDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    getProject(id)
      .then(setProject)
      .catch(() => setError("Project not found"));
  }, [id, router]);

  async function onDelete() {
    if (!project) return;
    if (!confirm(`Permanently delete project "${project.name}"? All database records and storage files will be lost.`)) return;
    await deleteProject(project.id);
    router.replace("/projects");
  }

  if (error) {
    return (
      <div className="page">
        <Link href="/projects" className="nav-back text-sm">← Back to Projects</Link>
        <p className="error-text">{error}</p>
      </div>
    );
  }
  if (!project) return null;

  return (
    <>
      <Navbar projectId={project.id} projectName={project.name} />

      <div className="page">
        {/* Breadcrumb & Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5 font-medium">
              <Link href="/projects" className="hover:text-foreground transition-colors">Projects</Link>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-foreground font-semibold">{project.name}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">
              {project.name}
            </h1>
          </div>

          <Button
            variant="destructive"
            size="sm"
            onClick={onDelete}
            className="rounded-full gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete Project</span>
          </Button>
        </div>

        {/* Project Metadata Card */}
        <Card className="p-6 mb-8 rounded-[24px]">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5 text-slate-400" />
                <span>Project Identifier</span>
              </div>
              <div className="font-mono text-sm font-semibold text-foreground">
                {project.id}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-slate-400" />
                <span>API Endpoint Base</span>
              </div>
              <div className="font-mono text-sm font-semibold text-brand-blue">
                /api/p/{project.id}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                <span>Created Date</span>
              </div>
              <div className="text-sm font-medium text-foreground">
                {new Date(project.created).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}
              </div>
            </div>
          </div>
        </Card>

        {/* Pusat Layanan Section (Hero Shortcuts) */}
        <div>
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4">
            <div>
              <h3 className="text-lg sm:text-xl font-extrabold tracking-tight text-foreground">Service Center</h3>
              <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
                All platform modules are active and ready to use without extra configuration.
              </p>
            </div>
            <div className="inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200/80 px-3.5 py-1 rounded-full text-xs font-semibold shadow-sm">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span>All Services Ready</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {PLATFORM_SERVICES.map((s) => {
              const Icon = s.icon;
              return (
                <Link
                  key={s.key}
                  href={s.href(project.id)}
                  className="group"
                >
                  <Card className="p-6 rounded-[24px] hover:border-slate-300 hover:-translate-y-1 hover:shadow-lg transition-all duration-200 h-full flex flex-col justify-between bg-white">
                    <div>
                      <div className="flex justify-between items-start mb-4">
                        <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center border border-border group-hover:scale-105 transition-transform">
                          <Icon className="w-6 h-6 text-slate-800" />
                        </div>
                        <Badge variant={s.badgeVariant} className="text-[11px] py-0.5 px-2.5">
                          {s.tag}
                        </Badge>
                      </div>

                      <div className="text-base font-bold text-foreground mb-2 flex items-center justify-between group-hover:text-brand-blue transition-colors">
                        <span>{s.title}</span>
                        <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 -translate-x-1 group-hover:translate-x-0 transition-all text-brand-blue" />
                      </div>
                      <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                        {s.desc}
                      </p>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
