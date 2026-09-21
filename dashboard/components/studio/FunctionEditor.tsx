"use client";

import { useEffect, useState, useMemo } from "react";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { LoadError, errorMessage } from "@/components/ui/load-error";
import {
  AlertTriangle,
  GitFork,
  Plus,
  X,
  Globe,
  Clock,
  Package,
  Code2,
  Sliders,
  Database,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectLabel,
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

interface TimezoneGroup {
  group: string;
  items: { value: string; label: string; offset: string }[];
}

const CURATED_TIMEZONES: TimezoneGroup[] = [
  {
    group: "Standard",
    items: [
      { value: "UTC", label: "UTC (Coordinated Universal Time)", offset: "UTC±00:00" },
    ],
  },
  {
    group: "Indonesia",
    items: [
      { value: "Asia/Jakarta", label: "Asia/Jakarta (WIB)", offset: "UTC+07:00" },
      { value: "Asia/Makassar", label: "Asia/Makassar (WITA)", offset: "UTC+08:00" },
      { value: "Asia/Jayapura", label: "Asia/Jayapura (WIT)", offset: "UTC+09:00" },
    ],
  },
  {
    group: "Asia & Pacific",
    items: [
      { value: "Asia/Singapore", label: "Asia/Singapore (SGT)", offset: "UTC+08:00" },
      { value: "Asia/Bangkok", label: "Asia/Bangkok (ICT)", offset: "UTC+07:00" },
      { value: "Asia/Tokyo", label: "Asia/Tokyo (JST)", offset: "UTC+09:00" },
      { value: "Asia/Seoul", label: "Asia/Seoul (KST)", offset: "UTC+09:00" },
      { value: "Asia/Hong_Kong", label: "Asia/Hong_Kong (HKT)", offset: "UTC+08:00" },
      { value: "Asia/Dubai", label: "Asia/Dubai (GST)", offset: "UTC+04:00" },
      { value: "Australia/Sydney", label: "Australia/Sydney (AEST)", offset: "UTC+10:00" },
    ],
  },
  {
    group: "Europe",
    items: [
      { value: "Europe/London", label: "Europe/London (GMT/BST)", offset: "UTC±00:00" },
      { value: "Europe/Paris", label: "Europe/Paris (CET)", offset: "UTC+01:00" },
      { value: "Europe/Berlin", label: "Europe/Berlin (CET)", offset: "UTC+01:00" },
      { value: "Europe/Amsterdam", label: "Europe/Amsterdam (CET)", offset: "UTC+01:00" },
    ],
  },
  {
    group: "Americas",
    items: [
      { value: "America/New_York", label: "America/New_York (EST/EDT)", offset: "UTC-05:00" },
      { value: "America/Chicago", label: "America/Chicago (CST/CDT)", offset: "UTC-06:00" },
      { value: "America/Denver", label: "America/Denver (MST/MDT)", offset: "UTC-07:00" },
      { value: "America/Los_Angeles", label: "America/Los_Angeles (PST/PDT)", offset: "UTC-08:00" },
      { value: "America/Sao_Paulo", label: "America/Sao_Paulo (BRT)", offset: "UTC-03:00" },
    ],
  },
];

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
  const [modulesError, setModulesError] = useState("");
  const [selectedModules, setSelectedModules] = useState<string[]>(existing?.modules ?? []);
  const [memoryMb, setMemoryMb] = useState(String(existing?.memoryMb ?? 32));
  const [activeTab, setActiveTab] = useState<"script" | "triggers">("script");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const allCuratedValues = useMemo(
    () => new Set(CURATED_TIMEZONES.flatMap((g) => g.items.map((i) => i.value))),
    []
  );
  const isCustomTimezone = Boolean(timezone && !allCuratedValues.has(timezone));

  // M43: daftar modul tersedia untuk dipilih sebagai $lib
  useEffect(() => {
    listModules(projectId)
      .then((m) => {
        setModulesAvail(m);
        setModulesError("");
      })
      .catch((e) => {
        // Dulu error dan "project memang tanpa modul" dijadikan satu hasil.
        // Keduanya berbeda: yang pertama berarti daftar $lib di bawah tidak
        // bisa dipercaya, yang kedua fakta.
        setModulesAvail([]);
        setModulesError(errorMessage(e, "Failed to load shared modules"));
      });
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

  function handleCodeKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const val = target.value;
      const nextVal = val.substring(0, start) + "  " + val.substring(end);
      setCode(nextVal);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
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
            <div className="space-y-1.5">
              <Label htmlFor="fn-name" className="text-xs">
                Function Name * <span className="text-muted-foreground text-[11px] font-normal">(lowercase, numbers, underscore)</span>
              </Label>
              <Input
                id="fn-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="calculate_total"
                className="h-9 text-xs font-mono"
                autoFocus
              />
            </div>
          )}

          <Tabs value={activeTab} onValueChange={(v: string) => setActiveTab(v as "script" | "triggers")} className="w-full">
            <TabsList className="grid grid-cols-2 w-full mb-3">
              <TabsTrigger value="script" className="gap-1.5 text-xs">
                <Code2 className="w-3.5 h-3.5" />
                <span>Script &amp; Environment</span>
              </TabsTrigger>
              <TabsTrigger value="triggers" className="gap-1.5 text-xs">
                <Sliders className="w-3.5 h-3.5" />
                <span>Triggers &amp; Resources</span>
                {(triggers.length > 0 || schedule) && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                )}
              </TabsTrigger>
            </TabsList>

            {/* ─── TAB 1: SCRIPT & ENVIRONMENT ─── */}
            <TabsContent value="script" className="space-y-4 mt-0">
              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <Label htmlFor="fn-code" className="text-xs">
                    JavaScript Code * <span className="text-muted-foreground text-[11px] font-normal">(Press Tab to indent)</span>
                  </Label>
                  <span className="text-[11px] text-muted-foreground font-mono">
                    return value → JSON response
                  </span>
                </div>
                <Textarea
                  id="fn-code"
                  rows={12}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={handleCodeKeyDown}
                  spellCheck={false}
                  className="font-mono text-xs leading-relaxed"
                />
              </div>

              {/* M41: $db access toggle */}
              <div className="p-3 bg-secondary/40 border border-border rounded-lg">
                <label htmlFor="fn-dbaccess" className="flex items-start gap-2.5 text-sm cursor-pointer">
                  <Checkbox
                    id="fn-dbaccess"
                    checked={dbAccess}
                    onCheckedChange={(c: boolean | "indeterminate") => setDbAccess(c === true)}
                    className="mt-0.5"
                  />
                  <div>
                    <span className="font-medium text-xs flex items-center gap-1.5">
                      <Database className="w-3.5 h-3.5 text-purple-400" />
                      <span>Enable in-process <code className="bg-secondary px-1 rounded">$db</code> access</span>
                    </span>
                    <span className="text-muted-foreground text-[11px] block mt-0.5">
                      Allow direct database reads and writes. Runs as admin (bypasses API rules).
                    </span>
                  </div>
                </label>
              </div>

              {/* M43: module registry ($lib) */}
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-xs">
                  <Package className="w-3.5 h-3.5" />
                  <span>Shared Modules <span className="text-muted-foreground text-[11px] font-normal">(<code className="bg-secondary px-1 rounded">$lib</code>, loaded in order)</span></span>
                </Label>
                {modulesError ? (
                  <LoadError variant="inline" message={modulesError} />
                ) : modulesAvail.length === 0 ? (
                  <p className="text-xs text-muted-foreground bg-secondary/20 p-2.5 rounded border border-border/50">
                    No shared modules created yet in this project. You can add them in the Shared Modules section below.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {modulesAvail.map((m) => {
                      const idx = selectedModules.indexOf(m.name);
                      return (
                        <label
                          key={m.name}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs cursor-pointer transition-colors ${
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

              {/* M25: $http allowlist */}
              <div className="space-y-1.5">
                <Label htmlFor="fn-http-allow" className="flex items-center gap-1.5 text-xs">
                  <Globe className="w-3.5 h-3.5" />
                  <span>
                    Allowed HTTP Hosts{" "}
                    <span className="text-muted-foreground text-[11px] font-normal">
                      (enables <code className="bg-secondary px-1 rounded">$http.send</code>; empty = no network)
                    </span>
                  </span>
                </Label>
                <Input
                  id="fn-http-allow"
                  value={httpAllow}
                  onChange={(e) => setHttpAllow(e.target.value)}
                  placeholder="e.g. api.stripe.com, *.github.com, *"
                  className="font-mono text-xs h-9"
                />
                <p className="text-[11px] text-muted-foreground">
                  Use <code className="bg-secondary px-1 rounded">*</code> for all public internet hosts. Loopback/private IPs stay blocked.
                </p>
              </div>
            </TabsContent>

            {/* ─── TAB 2: TRIGGERS & RESOURCES ─── */}
            <TabsContent value="triggers" className="space-y-4 mt-0">
              {/* Database Triggers */}
              <div className="space-y-2.5">
                <div className="flex justify-between items-center">
                  <Label className="flex items-center gap-1.5 text-xs font-semibold">
                    <GitFork className="w-3.5 h-3.5" />
                    <span>Database Event Triggers</span>
                  </Label>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="gap-1 h-7 text-xs"
                    onClick={() =>
                      setTriggers([...triggers, { collection: collectionNames[0] ?? "", actions: ["create"] }])
                    }
                    disabled={collectionNames.length === 0}
                  >
                    <Plus className="w-3 h-3" />
                    <span>Add Trigger</span>
                  </Button>
                </div>

                {collectionNames.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Create a collection in the Database section first to use triggers.
                  </p>
                ) : triggers.length === 0 ? (
                  <p className="text-xs text-muted-foreground bg-secondary/30 p-3 rounded-lg border border-border/50">
                    No database triggers attached. This function is callable via API or scheduled cron.
                  </p>
                ) : null}

                {triggers.map((t, idx) => (
                  <div key={idx} className="flex gap-2 items-center flex-wrap bg-secondary/30 p-2.5 rounded-lg border border-border/60">
                    <Select
                      value={t.collection}
                      onValueChange={(v: string) => updateTrigger(idx, { collection: v })}
                    >
                      <SelectTrigger className="w-[180px] h-8 text-xs">
                        <SelectValue placeholder="Select a collection" />
                      </SelectTrigger>
                      <SelectContent>
                        {collectionNames.map((c) => (
                          <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <div className="flex gap-2.5 items-center">
                      {["create", "update", "delete"].map((action) => (
                        <label key={action} className="flex items-center gap-1 text-xs cursor-pointer">
                          <Checkbox
                            checked={t.actions.includes(action)}
                            onCheckedChange={() => toggleAction(idx, action)}
                          />
                          <span className="capitalize">{action}</span>
                        </label>
                      ))}
                    </div>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setTriggers(triggers.filter((_, i) => i !== idx))}
                      title="Delete trigger"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive ml-auto"
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>

              {/* Cron Schedule & Timezone */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-border/60">
                <div className="space-y-1.5">
                  <Label htmlFor="fn-schedule" className="flex items-center gap-1.5 text-xs">
                    <Clock className="w-3.5 h-3.5" />
                    <span>Cron Schedule</span>
                  </Label>
                  <Input
                    id="fn-schedule"
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                    placeholder="e.g. 0 8 * * * (empty = manual)"
                    className="font-mono text-xs h-9"
                  />
                  <p className="text-[11px] text-muted-foreground font-mono">
                    min hour day month weekday
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="fn-timezone" className="flex items-center gap-1.5 text-xs">
                    <Globe className="w-3.5 h-3.5" />
                    <span>IANA Timezone</span>
                  </Label>
                  <Select value={timezone || "UTC"} onValueChange={(v: string) => setTimezone(v)}>
                    <SelectTrigger id="fn-timezone" className="h-9 text-xs">
                      <SelectValue placeholder="Select timezone" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {CURATED_TIMEZONES.map((group) => (
                        <SelectGroup key={group.group}>
                          <SelectLabel className="text-[10px] text-muted-foreground uppercase tracking-wider px-2 py-1 font-semibold">
                            {group.group}
                          </SelectLabel>
                          {group.items.map((tz) => (
                            <SelectItem key={tz.value} value={tz.value} className="text-xs">
                              <span className="font-medium">{tz.label}</span>{" "}
                              <span className="text-[10px] text-muted-foreground font-mono">({tz.offset})</span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                      {isCustomTimezone && (
                        <SelectGroup>
                          <SelectLabel className="text-[10px] text-muted-foreground uppercase tracking-wider px-2 py-1 font-semibold">
                            Custom
                          </SelectLabel>
                          <SelectItem value={timezone} className="text-xs font-mono">
                            {timezone}
                          </SelectItem>
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Timezone for cron schedule evaluation (default: UTC).
                  </p>
                </div>
              </div>

              {/* Limits: Timeout & Memory */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-border/60">
                <div className="space-y-1.5">
                  <Label htmlFor="fn-timeout" className="text-xs">Execution Timeout (ms)</Label>
                  <Input
                    id="fn-timeout"
                    type="number"
                    value={timeoutMs}
                    onChange={(e) => setTimeoutMs(e.target.value)}
                    min={100}
                    max={120000}
                    className="font-mono text-xs h-9"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Max execution duration (100ms - 120,000ms).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="fn-memory" className="text-xs">Memory Cap (MB)</Label>
                  <Input
                    id="fn-memory"
                    type="number"
                    value={memoryMb}
                    onChange={(e) => setMemoryMb(e.target.value)}
                    min={16}
                    max={256}
                    className="font-mono text-xs h-9"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Sandbox isolate ceiling: 16 MB – 256 MB.
                  </p>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving} className="h-8 text-xs">
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving || (!existing && !name.trim())} className="h-8 text-xs">
              {saving ? "Saving…" : "Save Function"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
