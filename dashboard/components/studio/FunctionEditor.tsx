"use client";

import { useEffect, useState } from "react";
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
import { AlertTriangle, GitFork, Plus, X, Globe, Clock, Package } from "lucide-react";
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
  listModules,
  type StoredFunction,
  type FunctionTrigger,
  type ModuleMeta,
} from "@/lib/api";

const DEFAULT_CODE = `// req = { body, query, auth } for callable functions
// any return value → JSON response
return { hello: "world", from: req.auth?.email ?? "anon" };`;

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
  // M25: allowlist host untuk $http (comma-separated → array saat save)
  const [httpAllow, setHttpAllow] = useState((existing?.httpAllow ?? []).join(", "));
  // M39/M41/M43/M44: setting lanjutan yang dulu hanya bisa disetel via API
  const [timezone, setTimezone] = useState(existing?.timezone ?? "UTC");
  const [dbAccess, setDbAccess] = useState(existing?.dbAccess ?? false);
  const [modulesAvail, setModulesAvail] = useState<ModuleMeta[]>([]);
  const [selectedModules, setSelectedModules] = useState<string[]>(existing?.modules ?? []);
  const [memoryMb, setMemoryMb] = useState(String(existing?.memoryMb ?? 32));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // M43: daftar modul tersedia untuk dipilih sebagai $lib
  useEffect(() => {
    listModules(projectId)
      .then(setModulesAvail)
      .catch(() => setModulesAvail([])); // project tanpa modul / error → kosong
  }, [projectId]);

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
      const allowList = httpAllow
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const payload = {
        code,
        timeoutMs: parseInt(timeoutMs, 10) || 2000,
        schedule: schedule.trim() === "" ? null : schedule.trim(),
        triggers,
        httpAllow: allowList,
        timezone: timezone.trim() === "" ? "UTC" : timezone.trim(),
        dbAccess,
        modules: selectedModules,
        memoryMb: parseInt(memoryMb, 10) || 32,
      };
      if (existing) {
        await updateFunction(projectId, existing.name, payload);
      } else {
        await createFunction(projectId, { name, ...payload });
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit: ${existing.name}` : "New Function"}</DialogTitle>
        </DialogHeader>

        {err && (
          <div className="p-3 bg-destructive/15 border border-destructive rounded-lg text-destructive text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <div className="space-y-4">
          {!existing && (
            <div className="space-y-2">
              <Label htmlFor="fn-name">
                Function name * <span className="text-muted-foreground text-xs">(a-z, 0-9, _, must start with a letter)</span>
              </Label>
              <Input
                id="fn-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="calculate_total"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="fn-code">
              Code * <span className="text-muted-foreground text-xs">(return value → JSON response)</span>
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
                Schedule (cron, leave empty if not scheduled){" "}
                <span className="text-muted-foreground text-xs">e.g. 0 1 * * * = daily at 01:00</span>
              </Label>
              <Input
                id="fn-schedule"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="* * * * *"
              />
            </div>
            <div className="flex-1 min-w-[150px] space-y-2">
              <Label htmlFor="fn-timezone" className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                Timezone
              </Label>
              <Input
                id="fn-timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Asia/Jakarta"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                IANA timezone for the cron schedule (default UTC).
              </p>
            </div>
            <div className="flex-1 min-w-[120px] space-y-2">
              <Label htmlFor="fn-memory">Memory (MB)</Label>
              <Input
                id="fn-memory"
                type="number"
                value={memoryMb}
                onChange={(e) => setMemoryMb(e.target.value)}
                min={16}
                max={256}
              />
              <p className="text-xs text-muted-foreground">Isolate cap: 16–256 MB.</p>
            </div>
          </div>

          {/* M25: $http allowlist */}
          <div className="space-y-2">
            <Label htmlFor="fn-http-allow" className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" />
              <span>
                Allowed HTTP Hosts{" "}
                <span className="text-muted-foreground text-xs font-normal">
                  (comma separated — enables <code className="bg-secondary px-1 rounded">$http.send</code>; empty = no network)
                </span>
              </span>
            </Label>
            <Input
              id="fn-http-allow"
              value={httpAllow}
              onChange={(e) => setHttpAllow(e.target.value)}
              placeholder="e.g. api.stripe.com, *.github.com, *"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground leading-relaxed">
              <code className="bg-secondary px-1 rounded">*</code> allows all public internet hosts (private/loopback
              IPs stay blocked). An exact hostname (e.g. <code className="bg-secondary px-1 rounded">192.168.1.10</code>)
              explicitly opts in to internal access.
            </p>
          </div>

          {/* M41: $db access toggle */}
          <div className="space-y-2">
            <label htmlFor="fn-dbaccess" className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                id="fn-dbaccess"
                checked={dbAccess}
                onCheckedChange={(c: boolean | "indeterminate") => setDbAccess(c === true)}
              />
              <span>
                Enable <code className="bg-secondary px-1 rounded">$db</code> access
                <span className="text-muted-foreground text-xs block mt-0.5">
                  Allow in-process database access. Runs as admin — API rules do NOT apply.
                </span>
              </span>
            </label>
          </div>

          {/* M43: module registry ($lib) */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Package className="w-3.5 h-3.5" />
              <span>Modules <span className="text-muted-foreground text-xs font-normal">(<code className="bg-secondary px-1 rounded">$lib</code>, loaded in order)</span></span>
            </Label>
            {modulesAvail.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No modules registered in this project yet.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {modulesAvail.map((m) => {
                  const idx = selectedModules.indexOf(m.name);
                  return (
                    <label
                      key={m.name}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-sm cursor-pointer transition-colors ${
                        idx >= 0
                          ? "border-accent bg-accent text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground"
                      }`}
                      title={`${m.sizeBytes} bytes · updated ${m.updated}`}
                    >
                      <Checkbox
                        checked={idx >= 0}
                        onCheckedChange={() =>
                          setSelectedModules(
                            idx >= 0
                              ? selectedModules.filter((x) => x !== m.name)
                              : [...selectedModules, m.name]
                          )
                        }
                      />
                      <span className="font-mono text-xs">{m.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Triggers */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <Label className="flex items-center gap-1.5">
                <GitFork className="w-3.5 h-3.5" />
                <span>Triggers</span>
              </Label>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="gap-1"
                onClick={() =>
                  setTriggers([...triggers, { collection: collectionNames[0] ?? "", actions: ["create"] }])
                }
                disabled={collectionNames.length === 0}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Trigger</span>
              </Button>
            </div>
            {collectionNames.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Create a collection in the Database section first to use triggers.
              </p>
            )}
            {triggers.map((t, idx) => (
              <div key={idx} className="flex gap-2 items-center flex-wrap">
                <Select
                  value={t.collection}
                  onValueChange={(v: string) => updateTrigger(idx, { collection: v })}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Select a collection" />
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
                  title="Delete trigger"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t border-border">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || (!existing && !name.trim())}>
              {saving ? "Saving…" : "Save Function"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
