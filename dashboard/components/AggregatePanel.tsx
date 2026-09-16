"use client";

// ============================================================================
// M19: AggregatePanel — server-side aggregations in the Database Studio
//
// Design intent: the browser must NEVER download rows just to reduce them.
// SUM over 100k rows travels back as ~20 bytes. Every control here maps 1:1
// to a query param on GET .../collections/:name/aggregate.
// ============================================================================

import { useState, useMemo } from "react";
import {
  aggregateRecords,
  type AggregateFunction,
  type AggregateResult,
  type CollectionInfo,
} from "@/lib/api";
import { Sigma, Play, AlertCircle, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  projectId: string;
  collection: CollectionInfo;
  /** Filter currently typed in the Records tab, offered as a starting point. */
  initialFilter?: string;
}

const FUNCTIONS: { value: AggregateFunction; label: string; needsField: boolean }[] = [
  { value: "count", label: "COUNT", needsField: false },
  { value: "sum", label: "SUM", needsField: true },
  { value: "avg", label: "AVG", needsField: true },
  { value: "min", label: "MIN", needsField: true },
  { value: "max", label: "MAX", needsField: true },
];

// SUM/AVG only make sense on numeric columns. MIN/MAX also work on dates and
// text, so the eligible set depends on the chosen function.
const NUMERIC_TYPES = new Set(["number"]);
const ORDERABLE_TYPES = new Set(["number", "date", "autodate", "text", "email", "url"]);

export default function AggregatePanel({ projectId, collection, initialFilter }: Props) {
  const [fn, setFn] = useState<AggregateFunction>("count");
  const [field, setField] = useState("");
  const [groupBy, setGroupBy] = useState("");
  const [filter, setFilter] = useState(initialFilter ?? "");
  const [result, setResult] = useState<AggregateResult | null>(null);
  // The server returns only `{ value }` / `{ groups }` — it does not echo the
  // query back. Labels must come from what WE sent, captured at run time so a
  // later dropdown change cannot mislabel an older result.
  const [ranQuery, setRanQuery] = useState<{
    fn: AggregateFunction;
    field: string;
    groupBy: string;
  } | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeFn = FUNCTIONS.find((f) => f.value === fn)!;

  const eligibleFields = useMemo(() => {
    const allowed = fn === "sum" || fn === "avg" ? NUMERIC_TYPES : ORDERABLE_TYPES;
    return collection.fields.filter((f) => allowed.has(f.type));
  }, [collection.fields, fn]);

  // Grouping by a huge-cardinality column produces an unreadable wall of rows;
  // low-cardinality types are the realistic candidates.
  const groupableFields = useMemo(
    () =>
      collection.fields.filter((f) =>
        ["text", "select", "bool", "relation", "email", "date", "autodate", "number"].includes(f.type)
      ),
    [collection.fields]
  );

  const canRun = !activeFn.needsField || Boolean(field);

  async function run() {
    if (!canRun) {
      setError(`${activeFn.label} requires a field.`);
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    setRanQuery(null);
    const started = performance.now();
    try {
      const res = await aggregateRecords(projectId, collection.name, {
        function: fn,
        field: activeFn.needsField ? field : undefined,
        filter: filter.trim() || undefined,
        groupBy: groupBy || undefined,
      });
      setResult(res);
      setRanQuery({ fn, field: activeFn.needsField ? field : "", groupBy });
      setElapsed(Math.round(performance.now() - started));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  // Mirrors exactly what the server receives — makes the panel a teaching tool
  // rather than a black box, and doubles as a copyable curl/SDK snippet.
  const requestPreview = useMemo(() => {
    const p = new URLSearchParams();
    p.set("function", fn);
    if (activeFn.needsField && field) p.set("field", field);
    if (filter.trim()) p.set("filter", filter.trim());
    if (groupBy) p.set("groupBy", groupBy);
    return `GET /api/admin/projects/${projectId}/collections/${collection.name}/aggregate?${p.toString()}`;
  }, [fn, field, filter, groupBy, projectId, collection.name, activeFn.needsField]);

  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString("en-US") : String(v);

  const maxGroupValue = useMemo(() => {
    if (!result?.groups?.length) return 0;
    return Math.max(...result.groups.map((g) => Math.abs(Number(g.value ?? 0))));
  }, [result]);

  return (
    <div>
      <div className="flex items-center gap-2.5 mb-1.5">
        <Sigma size={18} strokeWidth={2.4} className="text-brand-blue" />
        <h3 className="text-base font-bold m-0">Aggregations</h3>
      </div>
      <p className="text-sm text-muted-foreground mt-0 max-w-[60ch]">
        Computed by SQLite and returned as a single value — rows never leave the server.
      </p>

      {/* ── Query builder ── */}
      <Card className="p-5 grid gap-4 grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-end">
        <div className="space-y-2">
          <Label className="text-xs font-semibold">Function</Label>
          <Select
            value={fn}
            onValueChange={(v) => {
              const next = v as AggregateFunction;
              setFn(next);
              setResult(null);
              setRanQuery(null);
              // A field valid for SUM may be invalid for MIN and vice versa.
              const allowed = next === "sum" || next === "avg" ? NUMERIC_TYPES : ORDERABLE_TYPES;
              if (field && !collection.fields.some((f) => f.name === field && allowed.has(f.type))) {
                setField("");
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FUNCTIONS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-semibold">
            Field {activeFn.needsField && <span className="text-destructive">*</span>}
          </Label>
          <Select
            value={field}
            onValueChange={(v) => {
              setField(v);
              setResult(null);
              setRanQuery(null);
            }}
            disabled={!activeFn.needsField}
          >
            <SelectTrigger className={!activeFn.needsField ? "opacity-50" : ""}>
              <SelectValue placeholder={activeFn.needsField ? "Select a field…" : "Not required"} />
            </SelectTrigger>
            <SelectContent>
              {eligibleFields.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.name} ({f.type})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-semibold">Group by</Label>
          <Select
            value={groupBy}
            onValueChange={(v) => {
              setGroupBy(v);
              setResult(null);
              setRanQuery(null);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="No grouping" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">No grouping</SelectItem>
              {groupableFields.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-semibold">Filter (optional)</Label>
          <Input
            placeholder="amount > 250"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canRun && !running) run();
            }}
            className="font-mono text-sm"
          />
        </div>

        <Button
          onClick={run}
          disabled={running || !canRun}
          className="inline-flex items-center justify-center gap-1.5"
        >
          {running ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
          {running ? "Running…" : "Run"}
        </Button>
      </Card>

      {/* ── Request preview ── */}
      <div className="mt-3 px-3.5 py-2.5 rounded-xl bg-muted border border-border font-mono text-xs text-muted-foreground overflow-x-auto whitespace-nowrap">
        {requestPreview}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/30 text-destructive text-sm">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Scalar result ── */}
      {result && !result.groups && (
        <Card className="mt-4 p-6 text-center">
          <div className="text-xs text-muted-foreground uppercase tracking-widest">
            {ranQuery?.fn.toUpperCase()}
            {ranQuery?.field ? ` · ${ranQuery.field}` : ""}
          </div>
          <div className="text-4xl font-extrabold leading-tight mt-1.5 font-mono text-foreground">
            {fmt(result.value)}
          </div>
          {elapsed !== null && (
            <div className="text-xs text-muted-foreground mt-1.5">
              {elapsed} ms round-trip
            </div>
          )}
        </Card>
      )}

      {/* ── Grouped result ── */}
      {result?.groups && (
        <Card className="mt-4 p-5">
          <div className="flex justify-between items-baseline mb-3">
            <strong className="text-sm">
              {ranQuery?.fn.toUpperCase()}
              {ranQuery?.field ? ` (${ranQuery.field})` : ""} grouped by{" "}
              {ranQuery?.groupBy}
            </strong>
            <span className="text-xs text-muted-foreground">
              {result.groups.length} group{result.groups.length === 1 ? "" : "s"}
              {elapsed !== null ? ` · ${elapsed} ms` : ""}
            </span>
          </div>

          {result.groups.length === 0 ? (
            <p className="text-sm text-muted-foreground m-0">
              No rows matched.
            </p>
          ) : (
            <div style={{ display: "grid", gap: "0.45rem" }}>
              {result.groups.map((g, i) => {
                const val = Number(g.value ?? 0);
                const pct = maxGroupValue > 0 ? (Math.abs(val) / maxGroupValue) * 100 : 0;
                return (
                  <div
                    key={`${String(g.group)}-${i}`}
                    style={{ display: "grid", gridTemplateColumns: "minmax(90px, 26%) 1fr auto", gap: "0.75rem", alignItems: "center" }}
                  >
                    <span
                      style={{
                        fontSize: "0.82rem",
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={g.group === null ? "(null)" : String(g.group)}
                    >
                      {g.group === null || g.group === "" ? (
                        <em className="text-muted-foreground">(empty)</em>
                      ) : (
                        String(g.group)
                      )}
                    </span>
                    {/* Proportional bar: reading 12 numbers is slower than seeing them. */}
                    <div className="h-2 rounded-full bg-secondary overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          val < 0 ? "bg-destructive" : "bg-brand-blue"
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="font-mono text-sm font-semibold whitespace-nowrap">
                      {fmt(g.value)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
