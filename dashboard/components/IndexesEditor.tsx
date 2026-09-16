"use client";

import React from "react";
import type { IndexDef, FieldDef } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
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
          <h4 className="text-base font-semibold m-0">
            📇 Indexes & Unique Constraints ({indexes.length})
          </h4>
          <p className="text-sm text-muted-foreground mt-0.5">
            Kelola Index pencarian & aturan Unique (Single maupun Composite multi-kolom).
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleAddIndex}
        >
          + New Index
        </Button>
      </div>

      {indexes.length === 0 ? (
        <div className="p-4 bg-muted rounded-lg border border-dashed border-border text-sm text-muted-foreground text-center">
          Belum ada custom index. Tabel menggunakan primary key <code>id</code>. Klik <strong>+ New Index</strong> untuk membuat index atau aturan Unique constraint.
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
                    placeholder="nama index (e.g. idx_email)"
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
                    onValueChange={(v) =>
                      handleUpdateIndex(i, { unique: v === "unique" })
                    }
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="index">Index Biasa (B-Tree)</SelectItem>
                      <SelectItem value="unique">UNIQUE INDEX</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Fields selector (multi or comma-separated) */}
                  <Input
                    placeholder="kolom (pisahkan koma jika composite)"
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
                  >
                    ✕
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
