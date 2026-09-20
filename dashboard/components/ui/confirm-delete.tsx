"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";

/**
 * ConfirmDelete — konfirmasi aksi berbahaya yang konsisten di seluruh dashboard.
 *
 * Dua tingkat ketegasan:
 * - `requireTyped` diisi → user WAJIB mengetik teks itu persis (untuk aksi paling
 *   berbahaya: delete collection / project) — sabuk salah-klik.
 * - Tanpa `requireTyped` → konfirmasi biasa (untuk delete record biasa).
 *
 * Menggantikan confirm() native yang primitif & tidak konsisten dengan UI shadcn.
 */
export function ConfirmDelete({
  title,
  description,
  requireTyped,
  confirmLabel = "Delete",
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  description?: string;
  /** Bila diisi, tombol delete hanya aktif setelah user mengetik teks ini persis. */
  requireTyped?: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = React.useState("");
  const armed = !requireTyped || typed.trim() === requireTyped;

  // Reset ketikan saat dibuka untuk target baru
  React.useEffect(() => { setTyped(""); }, [requireTyped, title]);

  return (
    <Card className="p-4 border-destructive/50 bg-destructive/5 mb-4">
      <h4 className="text-sm font-semibold text-destructive flex items-center gap-2 mb-1.5">
        <AlertTriangle className="w-4 h-4" />
        <span>{title}</span>
      </h4>
      {description && (
        <p className="text-xs text-muted-foreground mb-3">{description}</p>
      )}
      {requireTyped && (
        <div className="mb-3">
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Type "${requireTyped}" to confirm`}
            className="font-mono text-sm"
            autoFocus
          />
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive mb-3 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>{error}</span>
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirm}
          disabled={!armed || busy}
          className="gap-1.5"
        >
          {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          <span>{confirmLabel}</span>
        </Button>
      </div>
    </Card>
  );
}
