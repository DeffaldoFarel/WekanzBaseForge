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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          marginBottom: "0.35rem",
        }}
      >
        <Sigma size={18} strokeWidth={2.4} style={{ color: "#5B86E5" }} />
        <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>Aggregations</h3>
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.82rem", maxWidth: "60ch" }}>
        Computed by SQLite and returned as a single value — rows never leave the server.
      </p>

      {/* ── Query builder ── */}
      <div
        className="card"
        style={{
          padding: "1.1rem 1.25rem",
          display: "grid",
          gap: "0.9rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          alignItems: "end",
        }}
      >
        <div className="field" style={{ margin: 0 }}>
          <label style={{ fontSize: "0.78rem", fontWeight: 600 }}>Function</label>
          <select
            className="input"
            value={fn}
            onChange={(e) => {
              const next = e.target.value as AggregateFunction;
              setFn(next);
              setResult(null);
              setRanQuery(null);
              // A field valid for SUM may be invalid for MIN and vice versa.
              const allowed = next === "sum" || next === "avg" ? NUMERIC_TYPES : ORDERABLE_TYPES;
              if (field && !collection.fields.some((f) => f.name === field && allowed.has(f.type))) {
                setField("");
              }
            }}
            style={{ fontSize: "0.85rem" }}
          >
            {FUNCTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field" style={{ margin: 0 }}>
          <label style={{ fontSize: "0.78rem", fontWeight: 600 }}>
            Field {activeFn.needsField && <span style={{ color: "#EB7167" }}>*</span>}
          </label>
          <select
            className="input"
            value={field}
            disabled={!activeFn.needsField}
            onChange={(e) => {
              setField(e.target.value);
              setResult(null);
              setRanQuery(null);
            }}
            style={{ fontSize: "0.85rem", opacity: activeFn.needsField ? 1 : 0.5 }}
          >
            <option value="">{activeFn.needsField ? "Select a field…" : "Not required"}</option>
            {eligibleFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name} ({f.type})
              </option>
            ))}
          </select>
        </div>

        <div className="field" style={{ margin: 0 }}>
          <label style={{ fontSize: "0.78rem", fontWeight: 600 }}>Group by</label>
          <select
            className="input"
            value={groupBy}
            onChange={(e) => {
              setGroupBy(e.target.value);
              setResult(null);
              setRanQuery(null);
            }}
            style={{ fontSize: "0.85rem" }}
          >
            <option value="">No grouping</option>
            {groupableFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field" style={{ margin: 0 }}>
          <label style={{ fontSize: "0.78rem", fontWeight: 600 }}>Filter (optional)</label>
          <input
            className="input"
            placeholder="amount > 250"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canRun && !running) run();
            }}
            style={{ fontSize: "0.85rem", fontFamily: "var(--font-mono), monospace" }}
          />
        </div>

        <button
          className="btn"
          onClick={run}
          disabled={running || !canRun}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.45rem",
            opacity: running || !canRun ? 0.55 : 1,
          }}
        >
          {running ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
          {running ? "Running…" : "Run"}
        </button>
      </div>

      {/* ── Request preview ── */}
      <div
        style={{
          marginTop: "0.7rem",
          padding: "0.6rem 0.85rem",
          borderRadius: "12px",
          background: "#F1F5F9",
          border: "1px solid #E2E8F0",
          fontFamily: "var(--font-mono), monospace",
          fontSize: "0.72rem",
          color: "#475569",
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        {requestPreview}
      </div>

      {error && (
        <div
          style={{
            marginTop: "0.9rem",
            display: "flex",
            alignItems: "flex-start",
            gap: "0.5rem",
            padding: "0.75rem 0.95rem",
            borderRadius: "14px",
            background: "#FEF2F2",
            border: "1px solid #FECACA",
            color: "#B91C1C",
            fontSize: "0.83rem",
          }}
        >
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      {/* ── Scalar result ── */}
      {result && !result.groups && (
        <div
          className="card"
          style={{
            marginTop: "1rem",
            padding: "1.6rem 1.5rem",
            textAlign: "center",
          }}
        >
          <div
            className="muted"
            style={{ fontSize: "0.72rem", letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            {ranQuery?.fn.toUpperCase()}
            {ranQuery?.field ? ` · ${ranQuery.field}` : ""}
          </div>
          <div
            style={{
              fontSize: "2.6rem",
              fontWeight: 800,
              lineHeight: 1.15,
              marginTop: "0.35rem",
              fontFamily: "var(--font-mono), monospace",
              color: "#0A0B0D",
            }}
          >
            {fmt(result.value)}
          </div>
          {elapsed !== null && (
            <div className="muted" style={{ fontSize: "0.74rem", marginTop: "0.35rem" }}>
              {elapsed} ms round-trip
            </div>
          )}
        </div>
      )}

      {/* ── Grouped result ── */}
      {result?.groups && (
        <div className="card" style={{ marginTop: "1rem", padding: "1.1rem 1.25rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: "0.8rem",
            }}
          >
            <strong style={{ fontSize: "0.88rem" }}>
              {ranQuery?.fn.toUpperCase()}
              {ranQuery?.field ? ` (${ranQuery.field})` : ""} grouped by{" "}
              {ranQuery?.groupBy}
            </strong>
            <span className="muted" style={{ fontSize: "0.74rem" }}>
              {result.groups.length} group{result.groups.length === 1 ? "" : "s"}
              {elapsed !== null ? ` · ${elapsed} ms` : ""}
            </span>
          </div>

          {result.groups.length === 0 ? (
            <p className="muted" style={{ fontSize: "0.83rem", margin: 0 }}>
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
                        <em className="muted">(empty)</em>
                      ) : (
                        String(g.group)
                      )}
                    </span>
                    {/* Proportional bar: reading 12 numbers is slower than seeing them. */}
                    <div
                      style={{
                        height: "9px",
                        borderRadius: "9999px",
                        background: "#E8EDF3",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          borderRadius: "9999px",
                          background: val < 0 ? "#EB7167" : "#5B86E5",
                          transition: "width 260ms ease",
                        }}
                      />
                    </div>
                    <span
                      style={{
                        fontFamily: "var(--font-mono), monospace",
                        fontSize: "0.82rem",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {fmt(g.value)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
