"use client";

import React from "react";
import type { IndexDef, FieldDef } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Layers, Plus, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface IndexesEditorProps {
  collectionName: string;
  indexes: IndexDef[];
  fields: FieldDef[];
  onChange: (updated: IndexDef[]) => void;
}

export function IndexesEditor({
  collectionName,
  indexes,
  fields,
  onChange,
}: IndexesEditorProps) {
  const availableFieldNames = [
    ...fields.map((f) => f.name).filter(Boolean),
    "created",
    "updated",
  ];

  function handleAddIndex() {
    const firstField = availableFieldNames[0] || "created";
    const defaultName = `idx_${collectionName}_${firstField}`;
    onChange([
      ...indexes,
      {
        name: defaultName,
        fields: [firstField],
        unique: false,
      },
    ]);
  }

  function handleUpdateIndex(idx: number, patch: Partial<IndexDef>) {
    const updated = [...indexes];
    updated[idx] = { ...updated[idx], ...patch };
    onChange(updated);
  }

  function handleRemoveIndex(idx: number) {
    onChange(indexes.filter((_, i) => i !== idx));
  }

  return (
    <div className="mt-6">
      <div className="flex justify-between items-center mb-3">
        <div>
          <h4 className="text-base font-semibold m-0 flex items-center gap-2">
            <Layers className="w-4 h-4 text-muted-foreground" />
            <span>Indexes & Unique Constraints ({indexes.length})</span>
          </h4>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage search indexes and unique constraints (single or composite multi-column).
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleAddIndex}
          className="gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Index</span>
        </Button>
      </div>

      {indexes.length === 0 ? (
        <div className="p-4 bg-muted rounded-lg border border-dashed border-border text-sm text-muted-foreground text-center">
          No custom indexes yet. The table uses the primary key <code>id</code>. Click <strong>+ New Index</strong> to create an index or a unique constraint.
        </div>
      ) : (
        <div className="grid gap-3">
          {indexes.map((idx, i) => {
            const cols = idx.fields.map((f) => `"${f}"`).join(", ");
            const sqlPreview = `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX "${idx.name || "idx_name"}" ON "${collectionName}" (${cols || "..."});`;

            return (
              <div
                key={i}
                className="bg-muted border border-border rounded-lg p-3"
              >
                <div className="flex gap-2.5 items-center">
                  {/* Name */}
                  <Input
                    placeholder="index name (e.g. idx_email)"
                    value={idx.name}
                    onChange={(e) =>
                      handleUpdateIndex(i, {
                        name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""),
                      })
                    }
                    className="flex-[1.5] font-semibold text-sm"
                  />

                  {/* Type (INDEX vs UNIQUE INDEX) */}
                  <Select
                    value={idx.unique ? "unique" : "index"}
                    onValueChange={(v: string) =>
                      handleUpdateIndex(i, { unique: v === "unique" })
                    }
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="index">Standard Index (B-Tree)</SelectItem>
                      <SelectItem value="unique">UNIQUE INDEX</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Fields selector (multi or comma-separated) */}
                  <Input
                    placeholder="columns (comma separated for composite)"
                    value={idx.fields.join(", ")}
                    onChange={(e) =>
                      handleUpdateIndex(i, {
                        fields: e.target.value
                          .split(",")
                          .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""))
                          .filter(Boolean),
                      })
                    }
                    className="flex-[1.8] text-sm"
                  />

                  {/* Delete */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveIndex(i)}
                    title="Delete Index"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>

                {/* Live SQL Preview */}
                <div className="mt-2 flex justify-between items-center text-xs">
                  <code className={idx.unique ? "text-accent-foreground" : "text-muted-foreground"}>
                    {sqlPreview}
                  </code>
                  {idx.unique && (
                    <Badge variant="secondary" className="text-xs">
                      Enforces Uniqueness
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
