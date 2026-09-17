"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { logout, getCachedProjectName, fetchProjectName } from "@/lib/api";
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
  Settings,
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
  const router = useRouter();
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");

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
      <header className="flex items-center justify-between px-8 py-3 bg-background/80 backdrop-blur-md border-b border-border sticky top-0 z-40">
        {/* Left: Brand + Slash Separator + Breadcrumb */}
        <div className="flex items-center gap-3">
          <Link href="/projects" className="flex items-center gap-2.5 font-semibold text-lg tracking-tight">
            <div className="w-7 h-7 rounded-md bg-brand flex items-center justify-center">
              <Zap className="w-4 h-4 text-background fill-background" />
            </div>
            <span className="text-foreground">
              wekanz<span className="text-muted-foreground">BaseForge</span>
            </span>
          </Link>

          <span className="text-border font-light select-none text-base">/</span>

          {projectId ? (
            <Link
              href={`/projects/${projectId}`}
              className="flex items-center gap-1.5 bg-secondary hover:bg-accent transition-colors px-3 py-1 rounded-md text-xs font-medium text-foreground border border-border"
            >
              <Folder className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="truncate max-w-[160px]">
                {resolvedName || projectName || projectId}
              </span>
            </Link>
          ) : (
            <div className="flex items-center gap-1.5 bg-secondary px-3 py-1 rounded-md text-xs font-medium text-muted-foreground border border-border">
              <span>Platform Console</span>
            </div>
          )}
        </div>

        {/* Right Section: Search + Docs + User + Sign Out */}
        <div className="flex items-center gap-2">
          {/* Search Bar (Cmd+K) */}
          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            className="flex items-center gap-2 bg-secondary hover:bg-accent border border-border rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors cursor-pointer"
            title="Search or jump to service (Cmd+K)"
          >
            <Search className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Search...</span>
            <kbd className="font-mono text-[10px] bg-background border border-border px-1.5 py-0.5 rounded text-muted-foreground">
              ⌘K
            </kbd>
          </button>

          {/* Settings Button (M23: mail/SMTP config) */}
          <Link
            href="/settings"
            className="w-8 h-8 rounded-md bg-transparent hover:bg-accent border border-border text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors"
            title="Platform Settings (SMTP / Mail)"
          >
            <Settings className="w-3.5 h-3.5" />
          </Link>

          {/* Documentation Button → halaman /docs (viewer markdown internal) */}
          <Link
            href="/docs"
            className="w-8 h-8 rounded-md bg-transparent hover:bg-accent border border-border text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors"
            title="Documentation"
          >
            <BookOpen className="w-3.5 h-3.5" />
          </Link>

          {/* User Profile */}
          <div className="flex items-center gap-2 border border-border rounded-md pl-1.5 pr-3 py-1 text-xs font-medium">
            <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center font-semibold">
              A
            </div>
            <span className="text-foreground hidden sm:inline">Admin</span>
          </div>

          {/* Sign out Button */}
          <button
            className="inline-flex items-center gap-1.5 border border-border text-muted-foreground hover:text-foreground hover:bg-accent rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
            onClick={handleLogout}
            title="Sign out of console"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>

      {/* ─── COMMAND QUICK JUMP MODAL (Cmd+K) ─── */}
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
        <DialogContent className="max-w-lg p-0 overflow-hidden">
          <DialogHeader className="p-4 border-b border-border">
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
              <kbd className="text-[10px] font-mono bg-secondary border border-border px-1.5 py-0.5 rounded text-muted-foreground shrink-0">
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
                    className="flex items-center justify-between p-3 rounded-lg hover:bg-accent cursor-pointer transition-colors group"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-md bg-secondary border border-border flex items-center justify-center text-muted-foreground group-hover:text-foreground transition-colors">
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-foreground">
                          {item.title}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {item.desc}
                        </div>
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
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
