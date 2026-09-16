"use client";

import { Card } from "@/components/ui/card";
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
import { FieldOptionsEditor } from "@/components/FieldOptionsEditor";
import { IndexesEditor } from "@/components/IndexesEditor";
import type { CollectionInfo, FieldDef, IndexDef } from "@/lib/api";

const FIELD_TYPES = [
  "text", "number", "bool", "email", "date", "json", "relation",
  "select", "url", "autodate", "file", "editor", "geoPoint", "password",
];

interface SchemaTabProps {
  projectId: string;
  collectionName: string;
  collection: CollectionInfo | null;
  collections: CollectionInfo[];
  isView: boolean;
  fieldsDraft: FieldDef[];
  indexesDraft: IndexDef[];
  schemaSaving: boolean;
  schemaError: string;
  onFieldsChange: (fields: FieldDef[]) => void;
  onIndexesChange: (indexes: IndexDef[]) => void;
  onSaveSchema: () => void;
}

export function SchemaTab({
  projectId,
  collectionName,
  collection,
  collections,
  isView,
  fieldsDraft,
  indexesDraft,
  schemaSaving,
  schemaError,
  onFieldsChange,
  onIndexesChange,
  onSaveSchema,
}: SchemaTabProps) {
  return (
    <Card className="p-6">
      {isView ? (
        <div>
          {/* View Query Display */}
          <div className="flex justify-between items-center mb-5">
            <div>
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <span>👁️</span> SQL View Definition — "{collectionName}"
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                This collection is a read-only SQL View compiled and executed directly by SQLite.
              </p>
            </div>
            <Badge variant="secondary" className="px-3 py-1.5 text-sm">
              Read-only View
            </Badge>
          </div>

          <div className="bg-muted p-5 rounded-xl border border-border mb-6">
            <div className="text-xs font-semibold text-accent-foreground uppercase tracking-wider mb-2">
              SQL SELECT Query:
            </div>
            <pre className="bg-background p-4 rounded-lg border border-border font-mono text-sm overflow-x-auto text-foreground leading-relaxed m-0">
              {collection?.viewQuery || "SELECT ..."}
            </pre>
          </div>

          <div>
            <h4 className="text-base font-semibold mb-3">
              Inferred Columns ({collection?.fields.length ?? 0})
            </h4>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
              {collection?.fields.map((f) => (
                <div
                  key={f.name}
                  className="bg-muted border border-border rounded-lg px-3.5 py-2.5 flex justify-between items-center"
                >
                  <span className="font-semibold text-sm">{f.name}</span>
                  <Badge variant="outline" className="text-xs">
                    {f.type}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div>
          {/* Schema Editor Header */}
          <div className="flex justify-between items-center mb-5 flex-wrap gap-2">
            <div>
              <h3 className="text-lg font-semibold">Schema Editor — "{collectionName}"</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Ubah tipe kolom, tambah, atau hapus field. Perubahan dijalankan via SQLite Table Rebuild (data tetap selamat!).
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  onFieldsChange([...fieldsDraft, { name: "", type: "text", required: false }])
                }
              >
                + Add Field
              </Button>
              <Button type="button" onClick={onSaveSchema} disabled={schemaSaving}>
                {schemaSaving ? "Menyimpan Skema…" : "💾 Save Schema Changes"}
              </Button>
            </div>
          </div>

          {schemaError && (
            <div className="text-destructive text-sm font-medium mb-4">{schemaError}</div>
          )}

          {/* Fields Editor */}
          <div className="grid gap-3">
            {fieldsDraft.map((f, i) => (
              <div key={i} className="bg-muted rounded-xl border border-border p-4">
                <div className="flex items-center gap-3 mb-3">
                  <Input
                    placeholder="nama field"
                    value={f.name}
                    onChange={(e) => {
                      const updated = [...fieldsDraft];
                      updated[i].name = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
                      onFieldsChange(updated);
                    }}
                    className="flex-[2] font-semibold"
                  />

                  <Select
                    value={f.type}
                    onValueChange={(v) => {
                      const updated = [...fieldsDraft];
                      updated[i].type = v;
                      onFieldsChange(updated);
                    }}
                  >
                    <SelectTrigger className="flex-[1.5]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <label className="flex items-center gap-1.5 text-sm whitespace-nowrap cursor-pointer">
                    <Checkbox
                      checked={!!f.required}
                      onCheckedChange={(checked) => {
                        const updated = [...fieldsDraft];
                        updated[i].required = !!checked;
                        onFieldsChange(updated);
                      }}
                    />
                    Req
                  </label>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (confirm(`Delete column "${f.name || "new"}"? This column will be dropped when the schema is saved.`)) {
                        onFieldsChange(fieldsDraft.filter((_, idx) => idx !== i));
                      }
                    }}
                    title="Delete column"
                  >
                    ✕
                  </Button>
                </div>

                <FieldOptionsEditor
                  field={f}
                  allCollections={collections}
                  onChange={(patch) => {
                    const updated = [...fieldsDraft];
                    updated[i] = { ...updated[i], ...patch };
                    onFieldsChange(updated);
                  }}
                />
              </div>
            ))}
          </div>

          {/* Indexes Editor */}
          <IndexesEditor
            collectionName={collectionName}
            indexes={indexesDraft}
            fields={fieldsDraft}
            onChange={onIndexesChange}
          />

          <div className="mt-6 flex justify-between items-center">
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                onFieldsChange([...fieldsDraft, { name: "", type: "text", required: false }])
              }
            >
              + Add Field
            </Button>
            <Button type="button" onClick={onSaveSchema} disabled={schemaSaving}>
              {schemaSaving ? "Menyimpan Skema…" : "💾 Save Schema Changes"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
