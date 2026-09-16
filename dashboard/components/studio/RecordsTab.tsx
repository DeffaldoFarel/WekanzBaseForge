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
    <div>
      {/* Search, Filter & Action Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <form onSubmit={onSearchSubmit} className="flex flex-1 gap-2">
          <Input
            placeholder="🔎 Search (?search=... FTS5)"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="text-sm"
          />
          <Input
            placeholder="Filter: status = 'active' && streak > 5"
            value={filterQuery}
            onChange={(e) => onFilterChange(e.target.value)}
            className="text-sm flex-[1.5]"
          />
          <Button type="submit" variant="secondary" className="px-4">
            Filter
          </Button>
          {(searchQuery || filterQuery) && (
            <Button
              type="button"
              variant="secondary"
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

        <div className="flex items-center gap-2">
          <Select value={sortQuery} onValueChange={onSortChange}>
            <SelectTrigger className="w-[200px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {selectedIds.size > 0 && (
            <Button variant="destructive" onClick={onBulkDelete} className="text-sm">
              🗑️ Delete ({selectedIds.size})
            </Button>
          )}

          {isView ? (
            <Badge variant="secondary" className="px-3 py-1.5 text-sm whitespace-nowrap">
              👁️ Read-only View
            </Badge>
          ) : (
            <Button onClick={onNewRecord} className="text-sm whitespace-nowrap">
              + New Record
            </Button>
          )}
        </div>
      </div>

      {/* Records Data Table */}
      <div className="border border-border rounded-2xl overflow-hidden bg-card">
        {loading ? (
          <div className="p-10 space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : !result || result.items.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground">
            <div className="text-4xl mb-2">📄</div>
            <p>Tidak ada record yang cocok.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[36px]">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(checked) => onSelectAll(!!checked)}
                  />
                </TableHead>
                <TableHead className="w-[140px]">ID</TableHead>
                {collection?.fields.map((f) => (
                  <TableHead key={f.name}>
                    <div className="flex items-center gap-1.5">
                      <span>{f.name}</span>
                      <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {f.type}
                      </span>
                    </div>
                  </TableHead>
                ))}
                <TableHead className="w-[150px]">Created</TableHead>
                <TableHead className="w-[90px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((row) => {
                const id = String(row.id);
                const isSelected = selectedIds.has(id);
                return (
                  <TableRow
                    key={id}
                    data-state={isSelected ? "selected" : undefined}
                    className={isSelected ? "bg-orange-50/80" : ""}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => onToggleRow(id)}
                      />
                    </TableCell>
                    <TableCell className="font-semibold text-accent-foreground">
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
                    <TableCell className="text-muted-foreground text-xs">
                      {String(row.created || "").slice(0, 19).replace("T", " ")}
                    </TableCell>
                    <TableCell
                      className="text-right whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {!isView && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 mr-1"
                            onClick={() => onEditRecord(row)}
                            title="Edit record"
                          >
                            ✏️
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 mr-1"
                            onClick={() => onDuplicateRecord(row)}
                            title="Duplicate record"
                          >
                            📑
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 mr-1"
                        onClick={() => onViewJson(row)}
                        title="View Raw JSON"
                      >
                        🔍
                      </Button>
                      {!isView && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => onDeleteRecord(id)}
                          title="Delete record"
                        >
                          ✕
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination Controls */}
      {result && result.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <Button
            variant="secondary"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            ← Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Halaman {page} dari {result.totalPages} ({result.totalItems} records)
          </span>
          <Button
            variant="secondary"
            disabled={page >= result.totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  );
}
