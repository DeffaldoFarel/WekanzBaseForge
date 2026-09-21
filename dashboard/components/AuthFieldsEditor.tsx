"use client";

// ============================================================================
// Ops-16: editor custom profile field untuk auth users.
//
// `_auth_users` adalah tabel SISTEM — tidak terdaftar di `_collections`, jadi
// tidak muncul di Database Studio. Editor ini satu-satunya UI untuk
// mendefinisikan field profil.
//
// Copy UI memakai bahasa Inggris profesional (standar repo), sementara
// komentar kode tetap bahasa Indonesia.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Lock, AlertCircle } from "lucide-react";
import {
  listAuthFields,
  createAuthField,
  deleteAuthField,
  type AuthFieldDefinition,
} from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
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

/** Tipe yang diizinkan server (authFields.ts ALLOWED_PROFILE_TYPES). */
const FIELD_TYPES = [
  "text",
  "number",
  "bool",
  "email",
  "url",
  "date",
  "select",
  "json",
] as const;

export function AuthFieldsEditor({ projectId }: { projectId: string }) {
  const [fields, setFields] = useState<AuthFieldDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Konfirmasi hapus inline (menggantikan confirm() native yang memblokir
  // thread, berhenti di fast-refresh, dan berbeda gaya dari UI shadcn).
  const [confirmDeleteField, setConfirmDeleteField] = useState<string | null>(null);
  const [deletingField, setDeletingField] = useState<string | null>(null);

  // form state
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("text");
  const [required, setRequired] = useState(false);
  const [userEditable, setUserEditable] = useState(true);
  const [selectValues, setSelectValues] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setFields(await listAuthFields(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load fields");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd() {
    if (!name.trim()) return;
    try {
      setAdding(true);
      setError(null);
      await createAuthField(projectId, {
        name: name.trim(),
        type,
        required,
        userEditable,
        // `select` tanpa daftar nilai membuat validasi server menolak setiap
        // nilai — kirim options hanya bila tipenya memang select.
        options:
          type === "select" && selectValues.trim()
            ? { values: selectValues.split(",").map((v) => v.trim()).filter(Boolean) }
            : undefined,
      });
      setName("");
      setType("text");
      setRequired(false);
      setUserEditable(true);
      setSelectValues("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create field");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(fieldName: string) {
    setDeletingField(fieldName);
    try {
      await deleteAuthField(projectId, fieldName);
      setConfirmDeleteField(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete field");
    } finally {
      setDeletingField(null);
    }
  }

  return (
    <Card className="p-6 space-y-5">
      <div>
        <h3 className="text-base font-semibold">Custom Profile Fields</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Add validated fields to every user profile. Values are stored as real
          columns, so they can be indexed and used in API rules.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Daftar field */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : fields.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            No custom fields yet. Auth responses keep their default shape.
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Constraints</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((f) => (
              <TableRow key={f.name}>
                <TableCell className="font-mono text-xs">{f.name}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{f.type}</Badge>
                </TableCell>
                <TableCell className="space-x-1.5">
                  {f.required && <Badge variant="outline">Required</Badge>}
                  {!f.userEditable && (
                    <Badge variant="outline" className="gap-1">
                      <Lock className="h-3 w-3" />
                      Admin only
                    </Badge>
                  )}
                  {!f.required && f.userEditable && (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setConfirmDeleteField(f.name)}
                    aria-label={`Delete ${f.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Konfirmasi hapus field profil — nilai field ini dihapus dari SEMUA
          user sekaligus, tidak bisa dikembalikan. */}
      {confirmDeleteField && (
        <ConfirmDelete
          title={`Delete field "${confirmDeleteField}"?`}
          description="Existing values for this field will be removed from every user. This cannot be undone."
          confirmLabel="Delete Field"
          busy={deletingField === confirmDeleteField}
          onConfirm={() => void handleDelete(confirmDeleteField)}
          onCancel={() => setConfirmDeleteField(null)}
        />
      )}

      {/* Form tambah */}
      <div className="rounded-xl border bg-muted/30 p-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="af-name">Field name</Label>
            <Input
              id="af-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="bio"
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="af-type">Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="af-type">
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
          </div>
        </div>

        {type === "select" && (
          <div className="space-y-1.5">
            <Label htmlFor="af-values">Allowed values</Label>
            <Input
              id="af-values"
              value={selectValues}
              onChange={(e) => setSelectValues(e.target.value)}
              placeholder="free, pro, enterprise"
            />
            <p className="text-xs text-muted-foreground">Comma separated.</p>
          </div>
        )}

        <div className="space-y-2.5">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <Checkbox
              checked={required}
              onCheckedChange={(c: boolean | "indeterminate") => setRequired(c === true)}
              className="mt-0.5"
            />
            <span className="text-sm">
              Required
              <span className="block text-xs text-muted-foreground">
                Enforced on sign-up only. Existing users are never locked out of
                their own profile.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <Checkbox
              checked={!userEditable}
              onCheckedChange={(c: boolean | "indeterminate") => setUserEditable(c !== true)}
              className="mt-0.5"
            />
            <span className="text-sm">
              Admin only
              <span className="block text-xs text-muted-foreground">
                Users cannot change this field themselves. Use for roles, tiers
                and quotas.
              </span>
            </span>
          </label>
        </div>

        <Button onClick={() => void handleAdd()} disabled={adding || !name.trim()}>
          <Plus className="h-4 w-4 mr-1.5" />
          {adding ? "Adding…" : "Add field"}
        </Button>
      </div>
    </Card>
  );
}
