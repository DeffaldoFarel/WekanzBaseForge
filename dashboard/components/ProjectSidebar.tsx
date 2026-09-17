"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Database,
  HardDrive,
  Code2,
  KeyRound,
  ChevronLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getCachedProjectName, fetchProjectName } from "@/lib/api";

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
    key: "auth",
    title: "Auth",
    icon: KeyRound,
    href: (id: string) => `/projects/${id}/auth`,
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

  const [resolvedName, setResolvedName] = useState<string>(() => {
    if (projectName) return projectName;
    if (projectId) return getCachedProjectName(projectId) || "";
    return "";
  });

  useEffect(() => {
    if (projectName) {
      setResolvedName(projectName);
    } else if (projectId) {
      const cached = getCachedProjectName(projectId);
      if (cached) {
        setResolvedName(cached);
      } else {
        fetchProjectName(projectId).then((name) => {
          if (name) setResolvedName(name);
        });
      }
    }
  }, [projectId, projectName]);

  function isActive(key: string): boolean {
    if (key === "overview") {
      return pathname === `/projects/${projectId}`;
    }
    return pathname?.includes(`/${key}`) ?? false;
  }

  return (
    <aside
      className="w-[230px] shrink-0 hidden lg:flex flex-col gap-0.5 py-4 pr-4 border-r border-border sticky top-[61px] self-start"
      style={{ maxHeight: "calc(100vh - 61px)" }}
    >
      {/* Back to Projects */}
      <Link
        href="/projects"
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors mb-3 px-2 py-1.5 rounded-md hover:bg-accent"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
        <span>All Projects</span>
      </Link>

      {/* Project Name Header */}
      <div className="px-2 pb-3 mb-2 border-b border-border">
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
          Current Project
        </div>
        <div className="text-sm font-semibold text-foreground truncate" title={resolvedName || projectName || projectId}>
          {resolvedName || projectName || projectId}
        </div>
      </div>

      {/* Section Label */}
      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 mb-1.5 mt-1">
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
              "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
            )}
          >
            <Icon className="w-4 h-4 shrink-0" />
            <span>{item.title}</span>
          </Link>
        );
      })}
    </aside>
  );
}
