"use client";

import { cn } from "@/lib/utils";
import { Table, Columns3, Shield, Sigma, ArrowUpDown, type LucideIcon } from "lucide-react";

export type StudioTabValue = "records" | "schema" | "rules" | "agg" | "io";

interface StudioTabsProps {
  activeTab: StudioTabValue;
  onTabChange: (tab: StudioTabValue) => void;
  recordCount: number;
  fieldCount: number;
}

const TABS: { value: StudioTabValue; label: string; icon: LucideIcon }[] = [
  { value: "records", label: "Records", icon: Table },
  { value: "schema", label: "Schema & Fields", icon: Columns3 },
  { value: "rules", label: "API Rules", icon: Shield },
  { value: "agg", label: "Aggregations", icon: Sigma },
  { value: "io", label: "Export / Import", icon: ArrowUpDown },
];

export function StudioTabs({
  activeTab,
  onTabChange,
  recordCount,
  fieldCount,
}: StudioTabsProps) {
  const counts: Partial<Record<StudioTabValue, number>> = {
    records: recordCount,
    schema: fieldCount,
  };

  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-secondary p-1 border border-border mb-6">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.value;
        const count = counts[tab.value];
        const Icon = tab.icon;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-state={isActive ? "active" : "inactive"}
            onClick={() => onTabChange(tab.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" />
            <span>{tab.label}</span>
            {count !== undefined && <span className="opacity-70 font-mono">({count})</span>}
          </button>
        );
      })}
    </div>
  );
}
