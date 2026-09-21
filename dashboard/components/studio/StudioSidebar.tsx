"use client";

import Link from "next/link";
import {
  Database,
  Eye,
  Users,
  Plus,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { CollectionInfo } from "@/lib/api";

interface StudioSidebarProps {
  projectId: string;
  collectionName: string;
  collections: CollectionInfo[];
  colFilter: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onColFilterChange: (v: string) => void;
  onNewCollection: () => void;
}

export function StudioSidebar({
  projectId,
  collectionName,
  collections,
  colFilter,
  collapsed = false,
  onToggleCollapse,
  onColFilterChange,
  onNewCollection,
}: StudioSidebarProps) {
  const filtered = collections.filter((c) =>
    c.name.toLowerCase().includes(colFilter.toLowerCase())
  );

  // ─── Mode Collapsed (Rail Ramping 52px) ──────────────────────────────────
  // Menghemat ruang horizontal ~200px saat admin ingin fokus membaca banyak
  // kolom data di tabel tanpa gangguan visual.
  if (collapsed) {
    return (
      <aside className="w-[52px] shrink-0 border border-border rounded-xl p-2 bg-card flex flex-col items-center sticky top-[81px] h-[calc(100vh-101px)] min-h-[calc(100vh-101px)] transition-all duration-200">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          className="h-8 w-8 text-muted-foreground hover:text-foreground mb-2"
          title="Expand collections sidebar"
          aria-label="Expand collections sidebar"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onNewCollection}
          className="h-8 w-8 text-muted-foreground hover:text-foreground mb-3"
          title="New Collection"
          aria-label="Create new collection"
        >
          <Plus className="w-4 h-4" />
        </Button>
        <div className="w-full h-px bg-border mb-2" />
        <div className="flex-1 overflow-y-auto space-y-1 w-full flex flex-col items-center pr-0.5">
          {collections.map((c) => {
            const isActive = c.name === collectionName;
            return (
              <Link
                key={c.name}
                href={`/projects/${projectId}/database/${encodeURIComponent(c.name)}`}
                title={`${c.name} (${c.recordCount ?? 0} records)`}
                className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
                  isActive
                    ? "bg-accent text-foreground border border-border"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
              >
                {c.type === "view" ? (
                  <Eye className={`w-4 h-4 ${isActive ? "text-purple-300" : "text-purple-400/80"}`} />
                ) : c.type === "auth" ? (
                  <Users className={`w-4 h-4 ${isActive ? "text-emerald-300" : "text-emerald-400/80"}`} />
                ) : (
                  <Database className={`w-4 h-4 ${isActive ? "text-foreground" : "text-muted-foreground"}`} />
                )}
              </Link>
            );
          })}
        </div>
      </aside>
    );
  }

  // ─── Mode Expanded (Sidebar Penuh 240px) ──────────────────────────────────
  // h-[calc(100vh-101px)] memastikan card background membentang penuh ke bawah
  // sejajar dengan card tabel utama, menghilangkan ruang kosong hitam menggantung.
  return (
    <aside className="w-[240px] shrink-0 border border-border rounded-xl p-3.5 bg-card flex flex-col sticky top-[81px] h-[calc(100vh-101px)] min-h-[calc(100vh-101px)] transition-all duration-200">
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Collections ({collections.length})
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={onNewCollection}
              className="h-6 px-2 text-[11px] gap-1"
            >
              <Plus className="w-3 h-3" />
              <span>New</span>
            </Button>
            {onToggleCollapse && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleCollapse}
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                title="Collapse sidebar"
                aria-label="Collapse collections sidebar"
              >
                <PanelLeftClose className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search collections…"
            value={colFilter}
            onChange={(e) => onColFilterChange(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5">
        {filtered.map((c) => {
          const isActive = c.name === collectionName;
          return (
            <Link
              key={c.name}
              href={`/projects/${projectId}/database/${encodeURIComponent(c.name)}`}
              className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                isActive
                  ? "bg-accent text-foreground font-medium border border-border/50"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              <div className="flex items-center gap-2 overflow-hidden">
                {c.type === "view" ? (
                  <Eye className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-purple-300" : "text-purple-400/80"}`} />
                ) : c.type === "auth" ? (
                  <Users className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-emerald-300" : "text-emerald-400/80"}`} />
                ) : (
                  <Database className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-foreground" : "text-muted-foreground"}`} />
                )}
                <span className="truncate">{c.name}</span>
              </div>
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 py-0 h-4 font-mono ${isActive ? "border-foreground/20 text-foreground" : ""}`}
              >
                {c.recordCount ?? 0}
              </Badge>
            </Link>
          );
        })}
      </div>
    </aside>
  );
}
