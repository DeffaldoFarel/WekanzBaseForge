"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logout } from "@/lib/api";
import {
  Zap,
  LayoutDashboard,
  Database,
  HardDrive,
  Code2,
  LogOut,
  FolderGit2,
  Search,
  BookOpen,
  Folder,
  ArrowRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface NavbarProps {
  projectId?: string;
  projectName?: string;
}

export function Navbar({ projectId, projectName }: NavbarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");

  const isDatabase = pathname?.includes("/database");
  const isStorage = pathname?.includes("/storage");
  const isFunctions = pathname?.includes("/functions");
  const isOverview = projectId && !isDatabase && !isStorage && !isFunctions;

  function handleLogout() {
    logout();
    router.replace("/login");
  }

  // Keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const navigationTargets = [
    ...(projectId
      ? [
          {
            title: "Project Overview",
            desc: "View project connection details, API keys, and stats",
            icon: LayoutDashboard,
            href: `/projects/${projectId}`,
          },
          {
            title: "Database & Collections",
            desc: "Manage SQL tables, schema migrations, and Auth records",
            icon: Database,
            href: `/projects/${projectId}/database`,
          },
          {
            title: "Storage Explorer",
            desc: "Manage physical files, image thumbnails, and clean orphans",
            icon: HardDrive,
            href: `/projects/${projectId}/storage`,
          },
          {
            title: "Serverless Functions",
            desc: "Manage isolated JS execution, triggers, and scheduled cron",
            icon: Code2,
            href: `/projects/${projectId}/functions`,
          },
        ]
      : []),
    {
      title: "All Projects Hub",
      desc: "Switch between your platform projects and environments",
      icon: FolderGit2,
      href: "/projects",
    },
  ];

  const filteredCommands = navigationTargets.filter(
    (t) =>
      t.title.toLowerCase().includes(commandQuery.toLowerCase()) ||
      t.desc.toLowerCase().includes(commandQuery.toLowerCase())
  );

  return (
    <>
      <header className="topbar">
        {/* Left: Brand + Slash Separator + Breadcrumb Pill */}
        <div className="flex items-center gap-3">
          <Link href="/projects" className="brand flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-primary text-white flex items-center justify-center shadow-sm">
              <Zap className="w-4 h-4 fill-white" />
            </div>
            <div className="font-extrabold text-base tracking-tight text-foreground">
              wekanz<span className="text-brand-blue">BaseForge</span>
            </div>
          </Link>

          <span className="text-slate-300 font-light select-none text-base">/</span>

          {projectId ? (
            <Link
              href={`/projects/${projectId}`}
              className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200/70 transition-colors px-3 py-1 rounded-full text-xs font-semibold text-slate-700 border border-slate-200/80 shadow-sm"
            >
              <Folder className="w-3.5 h-3.5 text-brand-blue" />
              <span className="truncate max-w-[160px] text-foreground font-semibold">
                {projectName || projectId}
              </span>
            </Link>
          ) : (
            <div className="flex items-center gap-1.5 bg-slate-100 px-3 py-1 rounded-full text-xs font-semibold text-slate-700 border border-slate-200/80 shadow-sm">
              <span>Platform Console</span>
            </div>
          )}
        </div>

        {/* Center Navigation Chips (Signature Soft UI / SugarCRM Pill Style) */}
        {projectId ? (
          <nav className="nav-chips hidden md:flex">
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
          <nav className="nav-chips hidden md:flex">
            <div className="nav-chip active flex items-center gap-1.5">
              <FolderGit2 className="w-3.5 h-3.5" />
              <span>All Projects</span>
            </div>
          </nav>
        )}

        {/* Right Section: Tactile Search Pill + Docs + User + Sign Out */}
        <div className="flex items-center gap-2.5">
          {/* Tactile Inset Search Bar (Cmd+K) */}
          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            className="flex items-center gap-2 bg-slate-100/90 hover:bg-slate-100 border border-border hover:border-slate-300 rounded-full px-3 py-1 text-xs text-muted-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,0.03)] transition-all cursor-pointer"
            title="Search or jump to service (Cmd+K)"
          >
            <Search className="w-3.5 h-3.5 text-slate-400" />
            <span className="hidden sm:inline font-normal">Search...</span>
            <kbd className="font-mono text-[10px] bg-white border border-slate-200 px-1.5 py-0.5 rounded shadow-sm text-slate-500 font-semibold">
              ⌘K
            </kbd>
          </button>

          {/* Documentation Pill Button */}
          <a
            href="https://github.com/DeffaldoFarel/WekanzBaseForge"
            target="_blank"
            rel="noreferrer"
            className="w-8 h-8 rounded-full bg-white hover:bg-slate-50 border border-border shadow-sm text-slate-600 hover:text-slate-900 flex items-center justify-center transition-all"
            title="Documentation"
          >
            <BookOpen className="w-3.5 h-3.5" />
          </a>

          {/* User Profile Pill */}
          <div className="flex items-center gap-2 bg-white border border-border rounded-full pl-1.5 pr-3 py-1 text-xs font-semibold shadow-sm">
            <div className="w-5 h-5 rounded-full bg-primary text-white text-[10px] flex items-center justify-center font-bold">
              A
            </div>
            <span className="text-foreground hidden sm:inline">Admin</span>
          </div>

          {/* Sign out Button */}
          <button
            className="inline-flex items-center gap-1.5 bg-white border border-border text-foreground hover:bg-slate-50 rounded-full px-3 py-1.5 text-xs font-semibold shadow-sm transition-all"
            onClick={handleLogout}
            title="Sign out of console"
          >
            <LogOut className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>

      {/* ─── COMMAND QUICK JUMP MODAL (Cmd+K) ─── */}
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
        <DialogContent className="max-w-lg p-0 overflow-hidden rounded-[26px]">
          <DialogHeader className="p-4 border-b border-border bg-slate-50/50">
            <div className="flex items-center gap-2.5">
              <Search className="w-4 h-4 text-muted-foreground ml-1" />
              <input
                type="text"
                value={commandQuery}
                onChange={(e) => setCommandQuery(e.target.value)}
                placeholder="Jump to collection, storage, functions, or project..."
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none border-none"
                autoFocus
              />
              <kbd className="text-[10px] font-mono bg-white border border-border px-1.5 py-0.5 rounded text-muted-foreground shrink-0">
                ESC
              </kbd>
            </div>
          </DialogHeader>

          <div className="p-2 max-h-[320px] overflow-y-auto space-y-1">
            {filteredCommands.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                No matching navigation target found.
              </div>
            ) : (
              filteredCommands.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.href}
                    onClick={() => {
                      setCommandOpen(false);
                      setCommandQuery("");
                      router.push(item.href);
                    }}
                    className="flex items-center justify-between p-3 rounded-xl hover:bg-slate-100 cursor-pointer transition-colors group"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-white border border-border flex items-center justify-center text-slate-700 shadow-sm group-hover:border-slate-300">
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-xs font-bold text-foreground">
                          {item.title}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {item.desc}
                        </div>
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-brand-blue group-hover:translate-x-0.5 transition-all" />
                  </div>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
