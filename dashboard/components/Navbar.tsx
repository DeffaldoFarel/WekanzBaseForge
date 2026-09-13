"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logout } from "@/lib/api";
import {
  Zap,
  LayoutDashboard,
  Database,
  HardDrive,
  Code2,
  FolderDot,
  LogOut,
  FolderGit2,
} from "lucide-react";

interface NavbarProps {
  projectId?: string;
  projectName?: string;
}

export function Navbar({ projectId, projectName }: NavbarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const isDatabase = pathname?.includes("/database");
  const isStorage = pathname?.includes("/storage");
  const isFunctions = pathname?.includes("/functions");
  const isOverview = projectId && !isDatabase && !isStorage && !isFunctions;

  function handleLogout() {
    logout();
    router.replace("/login");
  }

  return (
    <header className="topbar">
      <div className="flex items-center gap-4">
        <Link href="/projects" className="brand flex items-center gap-2.5">
          <div className="brand-icon bg-primary text-white flex items-center justify-center">
            <Zap className="w-4 h-4 fill-white" />
          </div>
          <div className="font-extrabold text-base tracking-tight text-foreground">
            wekanz<span className="text-brand-blue">BaseForge</span>
          </div>
        </Link>

        {projectName && (
          <div className="flex items-center gap-1.5 bg-slate-100/90 px-3 py-1 rounded-full text-xs font-semibold text-muted-foreground border border-border">
            <FolderDot className="w-3.5 h-3.5 text-brand-blue" />
            <span className="text-foreground">{projectName}</span>
          </div>
        )}
      </div>

      {/* Center Navigation Chips (Inspired by SugarCRM reference) */}
      {projectId ? (
        <nav className="nav-chips">
          <Link
            href={`/projects/${projectId}`}
            className={`nav-chip ${isOverview ? "active" : ""}`}
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            <span>Overview</span>
          </Link>
          <Link
            href={`/projects/${projectId}/database`}
            className={`nav-chip ${isDatabase ? "active" : ""}`}
          >
            <Database className="w-3.5 h-3.5" />
            <span>Collections</span>
          </Link>
          <Link
            href={`/projects/${projectId}/storage`}
            className={`nav-chip ${isStorage ? "active" : ""}`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>Storage</span>
          </Link>
          <Link
            href={`/projects/${projectId}/functions`}
            className={`nav-chip ${isFunctions ? "active" : ""}`}
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>Functions</span>
          </Link>
        </nav>
      ) : (
        <nav className="nav-chips">
          <div className="nav-chip active flex items-center gap-1.5">
            <FolderGit2 className="w-3.5 h-3.5" />
            <span>All Projects</span>
          </div>
        </nav>
      )}

      {/* Right Utilities */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 bg-white border border-border rounded-full px-3 py-1 text-xs font-semibold shadow-sm">
          <div className="w-5 h-5 rounded-full bg-primary text-white text-[10px] flex items-center justify-center font-bold">
            A
          </div>
          <span className="text-foreground">Admin</span>
        </div>

        <button
          className="inline-flex items-center gap-1.5 bg-white border border-border text-foreground hover:bg-slate-50 rounded-full px-3.5 py-1.5 text-xs font-semibold shadow-sm transition-all"
          onClick={handleLogout}
        >
          <LogOut className="w-3.5 h-3.5 text-muted-foreground" />
          <span>Sign out</span>
        </button>
      </div>
    </header>
  );
}
