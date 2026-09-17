"use client";

import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldOptionsEditor } from "@/components/FieldOptionsEditor";
import { IndexesEditor } from "@/components/IndexesEditor";
import {
  Box,
  Eye,
  Users,
  Shield,
  Lock,
  Globe,
  AlertTriangle,
  Lightbulb,
  Mail,
  Check,
  Calendar,
  Plus,
  X,
} from "lucide-react";
import {
  createCollection,
  type CollectionInfo,
  type FieldDef,
  type IndexDef,
  type CollectionRules as Rules,
} from "@/lib/api";

interface CreateCollectionModalProps {
  projectId: string;
  existingCollections: CollectionInfo[];
  onClose: () => void;
  onCreated: (col: CollectionInfo) => void;
}

const FIELD_TYPES = [
  "text", "number", "bool", "email", "date", "json", "relation",
  "select", "url", "autodate", "file", "editor", "geoPoint", "password", "vector",
];

const DEFAULT_RULES: Rules = {
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
};

export function CreateCollectionModal({
  projectId,
  existingCollections,
  onClose,
  onCreated,
}: CreateCollectionModalProps) {
  const [name, setName] = useState("");
  const [colType, setColType] = useState<"base" | "view" | "auth">("base");
  const [activeTab, setActiveTab] = useState<"fields" | "rules">("fields");

  // Base & Auth Collection State
  const [fields, setFields] = useState<FieldDef[]>([
    { name: "title", type: "text", required: true },
  ]);
  const [indexes, setIndexes] = useState<IndexDef[]>([]);

  // View Collection State
  const [viewQuery, setViewQuery] = useState("");

  // Rules State
  const [rules, setRules] = useState<Rules>({ ...DEFAULT_RULES });

  // Status
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Collection name is required");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      if (colType === "view") {
        if (!viewQuery.trim()) {
          throw new Error("A SQL SELECT query is required for view collections");
        }
        const created = await createCollection(projectId, {
          name: name.trim().toLowerCase(),
          type: "view",
          viewQuery: viewQuery.trim(),
          rules: {
            listRule: rules.listRule,
            viewRule: rules.viewRule,
          },
        });
        onCreated(created);
      } else {
        const validFields = fields.filter((f) => f.name.trim().length > 0);
        if (colType === "base" && validFields.length === 0) {
          throw new Error("Add at least 1 custom field for base collections");
        }
        const created = await createCollection(projectId, {
          name: name.trim().toLowerCase(),
          type: colType,
          fields: validFields,
          indexes: indexes.length > 0 ? indexes : undefined,
          rules,
        });
        onCreated(created);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create collection");
      setSubmitting(false);
    }
  }

  function handleAddField() {
    setFields([
      ...fields,
      { name: "", type: "text", required: false },
    ]);
  }

  function handleRemoveField(idx: number) {
    setFields(fields.filter((_, i) => i !== idx));
  }

  function handleUpdateField(idx: number, patch: Partial<FieldDef>) {
    const updated = [...fields];
    updated[idx] = { ...updated[idx], ...patch };
    setFields(updated);
  }

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {colType === "base" ? (
              <Box className="w-5 h-5 text-foreground" />
            ) : colType === "auth" ? (
              <Users className="w-5 h-5 text-emerald-400" />
            ) : (
              <Eye className="w-5 h-5 text-purple-400" />
            )}
            <span>Create collection</span>
          </DialogTitle>
        </DialogHeader>

        {error && (
          <div className="p-3 bg-destructive/15 border border-destructive rounded-lg text-destructive text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Name & Type */}
          <div className="flex gap-4 items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="col-name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="col-name"
                placeholder={colType === "base" ? "e.g. posts, orders, articles" : "e.g. posts_summary, active_users"}
                value={name}
                onChange={(e) =>
                  setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))
                }
                autoFocus
                required
                className="font-semibold"
              />
            </div>

            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={colType} onValueChange={(v: string) => {
                setColType(v as "base" | "view" | "auth");
                if (v === "auth" && fields.length === 1 && fields[0].name === "title") {
                  setFields([
                    { name: "name", type: "text" },
                    { name: "avatar", type: "file" },
                  ]);
                }
              }}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="base">Base</SelectItem>
                  <SelectItem value="view">View</SelectItem>
                  <SelectItem value="auth">Auth</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Tabs: Fields vs Rules */}
          <div className="flex gap-1 border-b border-border">
            <button
              type="button"
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors flex items-center gap-1.5 ${
                activeTab === "fields"
                  ? "bg-secondary text-foreground border-t border-x border-border"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab("fields")}
            >
              {colType === "view" ? "SQL Query" : `Fields (${fields.length})`}
            </button>
            <button
              type="button"
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors flex items-center gap-1.5 ${
                activeTab === "rules"
                  ? "bg-secondary text-foreground border-t border-x border-border"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab("rules")}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>API Rules</span>
            </button>
          </div>

          {/* TAB 1: FIELDS (BASE / AUTH) or SQL QUERY (VIEW) */}
          {activeTab === "fields" && (
            <div>
              {colType !== "view" ? (
                <div>
                  {/* System Fields Bar */}
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted rounded-lg border border-dashed border-border text-xs text-muted-foreground mb-3 flex-wrap">
                    <span className="font-semibold">System Fields:</span>
                    <Badge variant="outline" className="text-xs font-mono">id (PK)</Badge>
                    {colType === "auth" && (
                      <>
                        <Badge variant="secondary" className="text-xs font-mono gap-1">
                          <Mail className="w-3 h-3" /> email
                        </Badge>
                        <Badge variant="secondary" className="text-xs font-mono gap-1">
                          <Lock className="w-3 h-3" /> password
                        </Badge>
                        <Badge variant="outline" className="text-xs font-mono gap-1">
                          <Check className="w-3 h-3" /> verified
                        </Badge>
                      </>
                    )}
                    <Badge variant="outline" className="text-xs font-mono gap-1">
                      <Calendar className="w-3 h-3" /> created
                    </Badge>
                    <Badge variant="outline" className="text-xs font-mono gap-1">
                      <Calendar className="w-3 h-3" /> updated
                    </Badge>
                  </div>

                  {/* Custom Fields List */}
                  <div className="grid gap-3">
                    {fields.map((f, i) => (
                      <div key={i} className="bg-muted rounded-xl border border-border p-4">
                        <div className="flex items-center gap-3 mb-3">
                          <Input
                            placeholder="field name (e.g. title, price)"
                            value={f.name}
                            onChange={(e) =>
                              handleUpdateField(i, {
                                name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""),
                              })
                            }
                            className="flex-[2] font-semibold"
                            required
                          />
                          <Select
                            value={f.type}
                            onValueChange={(v: string) => handleUpdateField(i, { type: v })}
                          >
                            <SelectTrigger className="flex-[1.5]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {FIELD_TYPES.map((t) => (
                                <SelectItem key={t} value={t}>{t}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                            <Checkbox
                              checked={!!f.required}
                              onCheckedChange={(checked: boolean | 'indeterminate') => handleUpdateField(i, { required: !!checked })}
                            />
                            Req
                          </label>
                          {fields.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => handleRemoveField(i)}
                              title="Delete field"
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          )}
                        </div>

                        <FieldOptionsEditor
                          field={f}
                          allCollections={existingCollections}
                          onChange={(patch) => handleUpdateField(i, patch)}
                        />
                      </div>
                    ))}
                  </div>

                  <div className="mt-3">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleAddField}
                      className="gap-1.5"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Field</span>
                    </Button>
                  </div>

                  <IndexesEditor
                    collectionName={name || "collection"}
                    indexes={indexes}
                    fields={fields}
                    onChange={setIndexes}
                  />
                </div>
              ) : (
                /* VIEW COLLECTION SQL QUERY EDITOR */
                <div className="bg-muted p-5 rounded-xl border border-border">
                  <div className="flex justify-between items-center mb-2">
                    <Label className="font-semibold">
                      SQL SELECT Query <span className="text-destructive">*</span>
                    </Label>
                    <Badge variant="secondary" className="text-xs gap-1">
                      <Eye className="w-3 h-3" />
                      <span>Read-only View</span>
                    </Badge>
                  </div>
                  <Textarea
                    rows={6}
                    placeholder={`SELECT\n  h.id,\n  h.title,\n  h.created,\n  h.updated,\n  COUNT(*) AS total_items\nFROM habits h\nGROUP BY h.id`}
                    value={viewQuery}
                    onChange={(e) => setViewQuery(e.target.value)}
                    required
                    className="font-mono text-sm leading-relaxed"
                  />
                  <div className="text-xs text-muted-foreground mt-2 leading-relaxed flex items-start gap-1.5">
                    <Lightbulb className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground" />
                    <div>
                      <strong>View Collection Tips:</strong>
                      <br />
                      • Query must start with <code>SELECT</code> and include a unique <code>id</code> column.
                      <br />
                      • Column schema will be dynamically inferred by the BaseForge query engine.
                      <br />
                      • Views are strictly read-only (mutations like Create, Update, and Delete are rejected).
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: API RULES */}
          {activeTab === "rules" && (
            <div className="grid gap-3">
              <div className="text-sm text-muted-foreground mb-1">
                Configure access control rules for this collection. Leave empty / click <code>Lock</code> for Admin Only, or click <code>Public</code> for unauthenticated access.
              </div>

              {[
                { key: "listRule", label: "List/Search Rule", desc: "GET records list access" },
                { key: "viewRule", label: "View Rule", desc: "GET single record by ID access" },
                ...(colType === "base"
                  ? [
                      { key: "createRule", label: "Create Rule", desc: "POST new record access" },
                      { key: "updateRule", label: "Update Rule", desc: "PATCH/PUT edit record access" },
                      { key: "deleteRule", label: "Delete Rule", desc: "DELETE record access" },
                    ]
                  : []),
              ].map(({ key, label, desc }) => {
                const ruleKey = key as keyof Rules;
                const val = rules[ruleKey];

                return (
                  <div key={key} className="bg-muted p-4 rounded-lg border border-border">
                    <div className="flex justify-between items-center mb-1.5">
                      <div>
                        <span className="font-semibold text-sm">{label}</span>
                        <span className="text-xs text-muted-foreground ml-2">({desc})</span>
                      </div>
                      <div className="flex gap-1.5">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2.5 text-xs gap-1"
                          onClick={() => setRules({ ...rules, [ruleKey]: null })}
                        >
                          <Lock className="w-3 h-3" />
                          <span>Lock (null)</span>
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2.5 text-xs gap-1"
                          onClick={() => setRules({ ...rules, [ruleKey]: "" })}
                        >
                          <Globe className="w-3 h-3" />
                          <span>Public ("")</span>
                        </Button>
                      </div>
                    </div>

                    <Input
                      className="font-mono text-sm"
                      placeholder="null (admin only), or expression: user = @request.auth.id"
                      value={val === null ? "" : val}
                      onChange={(e) =>
                        setRules({
                          ...rules,
                          [ruleKey]: e.target.value === "" ? "" : e.target.value,
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? "Creating Collection…" : `Create ${colType === "view" ? "View" : "Collection"}`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
