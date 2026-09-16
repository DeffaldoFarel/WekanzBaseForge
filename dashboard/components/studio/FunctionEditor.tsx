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
  createFunction,
  updateFunction,
  type StoredFunction,
  type FunctionTrigger,
} from "@/lib/api";

const DEFAULT_CODE = `// req = { body, query, auth } untuk callable
// return apapun → JSON response
return { hello: "dunia", dari: req.auth?.email ?? "anon" };`;

interface FunctionEditorProps {
  projectId: string;
  existing: StoredFunction | null;
  collectionNames: string[];
  onClose: () => void;
  onSaved: () => void;
}

export function FunctionEditor({
  projectId,
  existing,
  collectionNames,
  onClose,
  onSaved,
}: FunctionEditorProps) {
  const [name, setName] = useState(existing?.name ?? "");
  const [code, setCode] = useState(existing?.code ?? DEFAULT_CODE);
  const [timeoutMs, setTimeoutMs] = useState(String(existing?.timeoutMs ?? 2000));
  const [schedule, setSchedule] = useState(existing?.schedule ?? "");
  const [triggers, setTriggers] = useState<FunctionTrigger[]>(existing?.triggers ?? []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  function updateTrigger(idx: number, patch: Partial<FunctionTrigger>) {
    setTriggers(triggers.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  }

  function toggleAction(idx: number, action: string) {
    const t = triggers[idx];
    const has = t.actions.includes(action);
    updateTrigger(idx, {
      actions: has ? t.actions.filter((a) => a !== action) : [...t.actions, action],
    });
  }

  async function handleSave() {
    setSaving(true);
    setErr("");
    try {
      const payload = {
        code,
        timeoutMs: parseInt(timeoutMs, 10) || 2000,
        schedule: schedule.trim() === "" ? null : schedule.trim(),
        triggers,
      };
      if (existing) {
        await updateFunction(projectId, existing.name, payload);
      } else {
        await createFunction(projectId, { name, ...payload });
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Gagal menyimpan");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit: ${existing.name}` : "Function baru"}</DialogTitle>
        </DialogHeader>

        {err && (
          <div className="p-3 bg-destructive/15 border border-destructive rounded-lg text-destructive text-sm">
            ⚠️ {err}
          </div>
        )}

        <div className="space-y-4">
          {!existing && (
            <div className="space-y-2">
              <Label htmlFor="fn-name">
                Nama function * <span className="text-muted-foreground text-xs">(a-z, 0-9, _, diawali huruf)</span>
              </Label>
              <Input
                id="fn-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="hitung_total"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="fn-code">
              Kode * <span className="text-muted-foreground text-xs">(return value → JSON response)</span>
            </Label>
            <Textarea
              id="fn-code"
              rows={10}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              className="font-mono text-sm"
            />
          </div>

          <div className="flex gap-4 flex-wrap">
            <div className="flex-1 min-w-[140px] space-y-2">
              <Label htmlFor="fn-timeout">Timeout (ms)</Label>
              <Input
                id="fn-timeout"
                type="number"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
                min={100}
                max={30000}
              />
            </div>
            <div className="flex-[2] min-w-[200px] space-y-2">
              <Label htmlFor="fn-schedule">
                Schedule (cron, kosongkan jika bukan scheduled){" "}
                <span className="text-muted-foreground text-xs">mis. 0 1 * * * = harian 01:00</span>
              </Label>
              <Input
                id="fn-schedule"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="* * * * *"
              />
            </div>
          </div>

          {/* Triggers */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <Label>🔗 Triggers</Label>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() =>
                  setTriggers([...triggers, { collection: collectionNames[0] ?? "", actions: ["create"] }])
                }
                disabled={collectionNames.length === 0}
              >
                + Trigger
              </Button>
            </div>
            {collectionNames.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Buat collection dulu di menu Database untuk memakai trigger.
              </p>
            )}
            {triggers.map((t, idx) => (
              <div key={idx} className="flex gap-2 items-center flex-wrap">
                <Select
                  value={t.collection}
                  onValueChange={(v) => updateTrigger(idx, { collection: v })}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Pilih collection" />
                  </SelectTrigger>
                  <SelectContent>
                    {collectionNames.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex gap-2 items-center">
                  {["create", "update", "delete"].map((action) => (
                    <label key={action} className="flex items-center gap-1 text-sm cursor-pointer">
                      <Checkbox
                        checked={t.actions.includes(action)}
                        onCheckedChange={() => toggleAction(idx, action)}
                      />
                      {action}
                    </label>
                  ))}
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setTriggers(triggers.filter((_, i) => i !== idx))}
                  title="Hapus trigger"
                >
                  ✕
                </Button>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t border-border">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Batal
            </Button>
            <Button onClick={handleSave} disabled={saving || (!existing && !name.trim())}>
              {saving ? "Menyimpan…" : "Simpan Function"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
