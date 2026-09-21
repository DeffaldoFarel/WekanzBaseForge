"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Search,
  Plus,
  Trash2,
  Eye,
  Pencil,
  Copy,
  Code,
  FileText,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { CollectionInfo, FieldDef, ListResult } from "@/lib/api";

const SORT_OPTIONS = [
  { value: "-created", label: "Created (Newest first)" },
  { value: "created", label: "Created (Oldest first)" },
  { value: "-updated", label: "Updated (Newest first)" },
  { value: "updated", label: "Updated (Oldest first)" },
];

interface RecordsTabProps {
  projectId: string;
  collectionName: string;
  collection: CollectionInfo | null;
  result: ListResult | null;
  loading: boolean;
  error: string;
  searchQuery: string;
  filterQuery: string;
  /** true saat ketikan belum diterapkan ke query (menunggu debounce). */
  queryPending?: boolean;
  sortQuery: string;
  page: number;
  selectedIds: Set<string>;
  isView: boolean;
  onSearchSubmit: (e: React.FormEvent) => void;
  onSearchChange: (v: string) => void;
  onFilterChange: (v: string) => void;
  onSortChange: (v: string) => void;
  onPageChange: (page: number) => void;
  onSelectAll: (checked: boolean) => void;
  onToggleRow: (id: string) => void;
  onNewRecord: () => void;
  onEditRecord: (row: Record<string, unknown>) => void;
  onDuplicateRecord: (row: Record<string, unknown>) => void;
  onDeleteRecord: (id: string) => void;
  onBulkDelete: () => void;
  onViewJson: (row: Record<string, unknown>) => void;
  renderCell: (props: {
    field: FieldDef;
    value: unknown;
    record: Record<string, unknown>;
    projectId: string;
    collectionName: string;
    onViewJson: () => void;
  }) => React.ReactNode;
}

export function RecordsTab({
  projectId,
  collectionName,
  collection,
  result,
  loading,
  error,
  searchQuery,
  filterQuery,
  queryPending = false,
  sortQuery,
  page,
  selectedIds,
  isView,
  onSearchSubmit,
  onSearchChange,
  onFilterChange,
  onSortChange,
  onPageChange,
  onSelectAll,
  onToggleRow,
  onNewRecord,
  onEditRecord,
  onDuplicateRecord,
  onDeleteRecord,
  onBulkDelete,
  onViewJson,
  renderCell,
}: RecordsTabProps) {
  const allSelected =
    !!result && result.items.length > 0 && selectedIds.size === result.items.length;

  return (
    <div className="flex-1 flex flex-col justify-between min-h-0">
      {/* Search, Filter & Action Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2.5 mb-4 items-stretch sm:items-center">
        <form onSubmit={onSearchSubmit} className="flex flex-1 gap-2 items-center flex-wrap sm:flex-nowrap">
          {/* Full-text Search */}
          <div className="relative flex-1 min-w-[180px]">
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none"
            />
            <Input
              placeholder="Search records…"
              aria-label="Full-text search records"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="text-xs h-9 pl-8 pr-7"
            />
            {queryPending && (
              <Loader2
                aria-hidden="true"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 animate-spin text-muted-foreground"
              />
            )}
          </div>

          {/* Rule Filter Input */}
          <div className="relative flex-[1.4] min-w-[200px]">
            <Input
              placeholder="Filter rule (e.g. status = 'active')"
              aria-label="Filter expression"
              value={filterQuery}
              onChange={(e) => onFilterChange(e.target.value)}
              className="text-xs h-9 font-mono"
            />
          </div>

          <Button
            type="submit"
            variant="secondary"
            className="h-9 px-3.5 text-xs shrink-0"
            title="Apply now without waiting for automatic delay"
          >
            Apply
          </Button>

          {(searchQuery || filterQuery) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 px-2.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
              onClick={() => {
                onSearchChange("");
                onFilterChange("");
                onPageChange(1);
              }}
            >
              Reset
            </Button>
          )}
        </form>

        {/* Sort, Selection Delete, and New Record */}
        <div className="flex items-center gap-2 shrink-0">
          <Select value={sortQuery} onValueChange={onSortChange}>
            <SelectTrigger className="w-[180px] h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {selectedIds.size > 0 && (
            <Button variant="destructive" size="sm" onClick={onBulkDelete} className="h-9 text-xs gap-1.5">
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete ({selectedIds.size})</span>
            </Button>
          )}

          {isView ? (
            <Badge variant="secondary" className="px-2.5 py-1 text-xs whitespace-nowrap gap-1 h-9">
              <Eye className="w-3.5 h-3.5" />
              <span>Read-only View</span>
            </Badge>
          ) : (
            <Button onClick={onNewRecord} size="sm" className="h-9 text-xs whitespace-nowrap gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              <span>New Record</span>
            </Button>
          )}
        </div>
      </div>

      {/* Records Data Table Card — membentang mengisi tinggi sisa layar */}
      <div className="border border-border rounded-lg overflow-hidden bg-card flex-1 flex flex-col justify-between min-h-[380px]">
        {loading ? (
          <div className="p-8 space-y-3">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="h-5 w-3/5" />
          </div>
        ) : !result || result.items.length === 0 ? (
          /* Empty State yang informatif dengan call-to-action */
          <div className="p-16 text-center text-muted-foreground flex flex-col items-center justify-center flex-1">
            <div className="w-12 h-12 rounded-xl bg-secondary border border-border flex items-center justify-center mb-3 text-muted-foreground">
              <FileText className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-foreground mb-1">
              {searchQuery.trim() || filterQuery.trim() ? "No matching records" : "No records in this collection"}
            </h3>
            <p className="text-xs text-muted-foreground max-w-sm mb-4">
              {searchQuery.trim() || filterQuery.trim()
                ? "No records matched your search keywords or filter rule."
                : isView
                ? "This SQL view currently returns 0 rows."
                : "Start by creating the first record using the form above."}
            </p>
            {searchQuery.trim() || filterQuery.trim() ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  onSearchChange("");
                  onFilterChange("");
                  onPageChange(1);
                }}
              >
                Reset search &amp; filter
              </Button>
            ) : !isView ? (
              <Button size="sm" className="h-8 text-xs gap-1.5" onClick={onNewRecord}>
                <Plus className="w-3.5 h-3.5" />
                <span>Create First Record</span>
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="overflow-x-auto flex-1">
            <Table>
              <TableHeader>
                <tr className="border-b border-border bg-secondary/50 text-muted-foreground font-medium uppercase tracking-wider text-[11px]">
                  <TableHead className="w-[36px] pl-3">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(checked: boolean | "indeterminate") => onSelectAll(!!checked)}
                    />
                  </TableHead>
                  <TableHead className="w-[140px] font-mono text-xs">ID</TableHead>
                  {collection?.fields.map((f) => (
                    <TableHead key={f.name}>
                      <div className="flex items-center gap-1.5">
                        <span className="text-foreground">{f.name}</span>
                        <span className="text-[9px] text-muted-foreground bg-secondary border border-border px-1 py-0.2 rounded font-mono font-normal">
                          {f.type}
                        </span>
                      </div>
                    </TableHead>
                  ))}
                  <TableHead className="w-[150px]">Created</TableHead>
                  <TableHead className="w-[110px] text-right pr-4">Actions</TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {result.items.map((row) => {
                  const id = String(row.id);
                  const isSelected = selectedIds.has(id);
                  return (
                    /* Best Practice: Klik di mana saja pada baris membuka modal edit */
                    <TableRow
                      key={id}
                      data-state={isSelected ? "selected" : undefined}
                      className={`cursor-pointer transition-colors hover:bg-accent/40 ${
                        isSelected ? "bg-accent/60" : ""
                      }`}
                      onClick={() => !isView && onEditRecord(row)}
                    >
                      <TableCell className="pl-3" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => onToggleRow(id)}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs text-foreground font-medium">
                        {id}
                      </TableCell>
                      {collection?.fields.map((f) => {
                        const val = row[f.name];
                        return (
                          <TableCell key={f.name}>
                            {renderCell({
                              field: f,
                              value: val,
                              record: row,
                              projectId,
                              collectionName,
                              onViewJson: () => onViewJson(row),
                            })}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-muted-foreground text-xs font-mono">
                        {String(row.created || "").slice(0, 19).replace("T", " ")}
                      </TableCell>
                      <TableCell
                        className="text-right whitespace-nowrap pr-4"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-end gap-0.5">
                          {!isView && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                onClick={() => onEditRecord(row)}
                                title="Edit record"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                onClick={() => onDuplicateRecord(row)}
                                title="Duplicate record"
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </Button>
                            </>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => onViewJson(row)}
                            title="View Raw JSON"
                          >
                            <Code className="w-3.5 h-3.5" />
                          </Button>
                          {!isView && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              onClick={() => onDeleteRecord(id)}
                              title="Delete record"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination Controls — tertata rapi di dasar tabel card */}
        {result && result.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-secondary/30">
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs gap-1"
              disabled={page <= 1}
              onClick={() => onPageChange(Math.max(1, page - 1))}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Previous</span>
            </Button>
            <span className="text-xs text-muted-foreground font-mono">
              Page {page} of {result.totalPages} ({result.totalItems} records)
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs gap-1"
              disabled={page >= result.totalPages}
              onClick={() => onPageChange(page + 1)}
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
