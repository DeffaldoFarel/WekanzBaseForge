"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createRecord,
  updateRecord,
  createRecordWithFiles,
  updateRecordWithFiles,
  type CollectionInfo,
} from "@/lib/api";

interface RecordFormModalProps {
  collection: CollectionInfo;
  initialData: Record<string, unknown> | null;
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function RecordFormModal({
  collection,
  initialData,
  projectId,
  onClose,
  onSuccess,
}: RecordFormModalProps) {
  const isEdit = !!initialData?.id;
  const [formData, setFormData] = useState<Record<string, unknown>>(() => {
    if (initialData) {
      return { ...initialData };
    }
    const empty: Record<string, unknown> = {};
    for (const f of collection.fields) {
      if (f.type === "bool") empty[f.name] = false;
      else if (f.type === "number") empty[f.name] = null;
      else empty[f.name] = "";
    }
    return empty;
  });

  const [files, setFiles] = useState<Record<string, File | File[]>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    try {
      const hasFiles = Object.keys(files).length > 0;
      const payload = { ...formData };
      if (collection.type === "auth" && isEdit && !payload.password) {
        delete payload.password;
      }

      if (hasFiles) {
        if (isEdit) {
          await updateRecordWithFiles(projectId, collection.name, String(initialData!.id), payload, files);
        } else {
          await createRecordWithFiles(projectId, collection.name, payload, files);
        }
      } else {
        if (isEdit) {
          await updateRecord(projectId, collection.name, String(initialData!.id), payload);
        } else {
          await createRecord(projectId, collection.name, payload);
        }
      }

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save record");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit Record (${initialData.id})` : "New Record"}</DialogTitle>
        </DialogHeader>

        {error && (
          <div className="text-destructive text-sm font-medium">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {collection.type === "auth" && (
            <div className="space-y-2">
              <Label htmlFor="password" className="flex justify-between">
                <span>Password {!isEdit && <span className="text-destructive">*</span>}</span>
                <span className="text-xs text-muted-foreground">password</span>
              </Label>
              <Input
                id="password"
                type="password"
                placeholder={isEdit ? "Leave empty to keep the current password" : "Minimum 8 characters"}
                value={String(formData.password ?? "")}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                required={!isEdit}
              />
            </div>
          )}

          {collection.fields.map((f) => (
            <div key={f.name} className="space-y-2">
              <Label htmlFor={f.name} className="flex justify-between">
                <span>{f.name} {f.required && <span className="text-destructive">*</span>}</span>
                <span className="text-xs text-muted-foreground">{f.type}</span>
              </Label>

              {f.type === "bool" ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={formData[f.name] === true}
                    onCheckedChange={(checked: boolean | 'indeterminate') =>
                      setFormData({ ...formData, [f.name]: !!checked })
                    }
                  />
                  <span className="text-sm">{formData[f.name] === true ? "True" : "False"}</span>
                </label>
              ) : f.type === "select" ? (
                <Select
                  value={String(formData[f.name] ?? "")}
                  onValueChange={(v: string) => setFormData({ ...formData, [f.name]: v || null })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="— select an option —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— select an option —</SelectItem>
                    {(f.options?.values || []).map((v: string) => (
                      <SelectItem key={v} value={v}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : f.type === "file" ? (
                <div className="space-y-2">
                  <Input
                    type="file"
                    onChange={(e) => {
                      const fl = e.target.files;
                      if (fl && fl.length > 0) {
                        setFiles({ ...files, [f.name]: fl[0] });
                      }
                    }}
                  />
                  {Boolean(initialData?.[f.name]) && (
                    <div className="text-sm text-muted-foreground">
                      Current file: {String(initialData![f.name])}
                    </div>
                  )}
                </div>
              ) : f.type === "json" ? (
                <Textarea
                  rows={3}
                  value={
                    typeof formData[f.name] === "object"
                      ? JSON.stringify(formData[f.name], null, 2)
                      : String(formData[f.name] ?? "")
                  }
                  onChange={(e) => {
                    try {
                      setFormData({ ...formData, [f.name]: JSON.parse(e.target.value) });
                    } catch {
                      setFormData({ ...formData, [f.name]: e.target.value });
                    }
                  }}
                  className="font-mono text-sm"
                />
              ) : f.type === "autodate" ? (
                <div className="text-sm text-muted-foreground italic">
                  Automatically filled by the system
                </div>
              ) : (
                <Input
                  id={f.name}
                  type={f.type === "number" ? "number" : f.type === "password" ? "password" : "text"}
                  value={formData[f.name] === null || formData[f.name] === undefined ? "" : String(formData[f.name])}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      [f.name]: f.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value,
                    })
                  }
                  required={f.required}
                />
              )}
            </div>
          ))}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Update Record" : "Create Record"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
