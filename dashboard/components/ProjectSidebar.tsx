"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Database,
  HardDrive,
  Code2,
  ChevronLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ProjectSidebarProps {
  projectId: string;
  projectName?: string;
}

const NAV_ITEMS = [
  {
    key: "overview",
    title: "Overview",
    icon: LayoutDashboard,
    href: (id: string) => `/projects/${id}`,
  },
  {
    key: "database",
    title: "Collections",
    icon: Database,
    href: (id: string) => `/projects/${id}/database`,
  },
  {
    key: "storage",
    title: "Storage",
    icon: HardDrive,
    href: (id: string) => `/projects/${id}/storage`,
  },
  {
    key: "functions",
    title: "Functions",
    icon: Code2,
    href: (id: string) => `/projects/${id}/functions`,
  },
];

export function ProjectSidebar({ projectId, projectName }: ProjectSidebarProps) {
  const pathname = usePathname();

  function isActive(key: string): boolean {
    if (key === "overview") {
      return pathname === `/projects/${projectId}`;
    }
    return pathname?.includes(`/${key}`) ?? false;
  }

  return (
    <aside
      className="w-[240px] shrink-0 hidden lg:flex flex-col gap-1 p-4 rounded-[22px] bg-white border border-border shadow-soft sticky top-[84px] self-start"
      style={{ maxHeight: "calc(100vh - 100px)" }}
    >
      {/* Back to Projects */}
      <Link
        href="/projects"
        className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors mb-3 px-2 py-1.5 rounded-lg hover:bg-slate-50"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
        <span>All Projects</span>
      </Link>

      {/* Project Name Header */}
      <div className="px-2 pb-3 mb-2 border-b border-slate-100">
        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
          Current Project
        </div>
        <div className="text-sm font-bold text-foreground truncate" title={projectName || projectId}>
          {projectName || projectId}
        </div>
      </div>

      {/* Section Label */}
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1.5 mt-1">
        Services
      </div>

      {/* Navigation Items */}
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = isActive(item.key);
        return (
          <Link
            key={item.key}
            href={item.href(projectId)}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-full text-[13px] font-semibold transition-all duration-150",
              active
                ? "bg-primary text-primary-foreground shadow-pill"
                : "text-muted-foreground hover:text-foreground hover:bg-slate-100"
            )}
          >
            <Icon className={cn("w-4 h-4 shrink-0", active ? "text-white" : "text-slate-500")} />
            <span>{item.title}</span>
          </Link>
        );
      })}
    </aside>
  );
}
