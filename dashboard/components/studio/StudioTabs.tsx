"use client";

import { cn } from "@/lib/utils";

export type StudioTabValue = "records" | "schema" | "rules" | "agg" | "io";

interface StudioTabsProps {
  activeTab: StudioTabValue;
  onTabChange: (tab: StudioTabValue) => void;
  recordCount: number;
  fieldCount: number;
}

const TABS: { value: StudioTabValue; label: string }[] = [
  { value: "records", label: "📊 Records" },
  { value: "schema", label: "📐 Schema & Fields" },
  { value: "rules", label: "🔒 API Rules" },
  { value: "agg", label: "🧮 Aggregations" },
  { value: "io", label: "💾 Export / Import" },
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
    <div className="inline-flex items-center gap-1 rounded-full bg-secondary p-1 border border-border mb-6">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.value;
        const count = counts[tab.value];
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-state={isActive ? "active" : "inactive"}
            onClick={() => onTabChange(tab.value)}
            className={cn(
              "inline-flex items-center justify-center whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-semibold transition-all",
              isActive
                ? "bg-primary text-primary-foreground shadow-pill"
                : "text-muted-foreground hover:text-foreground hover:bg-white/60"
            )}
          >
            {tab.label}
            {count !== undefined && ` (${count})`}
          </button>
        );
      })}
    </div>
  );
}
