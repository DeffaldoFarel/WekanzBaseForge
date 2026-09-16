"use client";

import Link from "next/link";
import { Database, Eye, Users, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { CollectionInfo } from "@/lib/api";

interface StudioSidebarProps {
  projectId: string;
  collectionName: string;
  collections: CollectionInfo[];
  colFilter: string;
  onColFilterChange: (v: string) => void;
  onNewCollection: () => void;
}

export function StudioSidebar({
  projectId,
  collectionName,
  collections,
  colFilter,
  onColFilterChange,
  onNewCollection,
}: StudioSidebarProps) {
  const filtered = collections.filter((c) =>
    c.name.toLowerCase().includes(colFilter.toLowerCase())
  );

  return (
    <aside className="w-[270px] shrink-0 border border-border rounded-3xl p-5 bg-card flex flex-col shadow-soft sticky top-[84px] max-h-[calc(100vh-100px)] overflow-y-auto">
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-foreground">
            Collections ({collections.length})
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onNewCollection}
            className="h-7 px-2.5 text-xs"
          >
            <Plus className="w-3 h-3 mr-1" />
            New
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Search collections..."
            value={colFilter}
            onChange={(e) => onColFilterChange(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-0.5">
        {filtered.map((c) => {
          const isActive = c.name === collectionName;
          return (
            <Link
              key={c.name}
              href={`/projects/${projectId}/database/${encodeURIComponent(c.name)}`}
              className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-sm transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <div className="flex items-center gap-2 overflow-hidden">
                {c.type === "view" ? (
                  <Eye className={`w-4 h-4 shrink-0 ${isActive ? "text-purple-300" : "text-purple-600"}`} />
                ) : c.type === "auth" ? (
                  <Users className={`w-4 h-4 shrink-0 ${isActive ? "text-emerald-300" : "text-emerald-600"}`} />
                ) : (
                  <Database className={`w-4 h-4 shrink-0 ${isActive ? "text-slate-300" : "text-slate-600"}`} />
                )}
                <span className="truncate">{c.name}</span>
              </div>
              <Badge
                variant={isActive ? "secondary" : "outline"}
                className={`text-[10px] px-1.5 py-0 h-5 ${isActive ? "bg-white/20 text-white border-transparent" : ""}`}
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
