"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DocsGroup } from "@/lib/docs";

export function DocsSidebar({ groups }: { groups: DocsGroup[] }) {
  const pathname = usePathname();
  const learningsOpen = pathname?.includes("/docs/learnings/");

  return (
    <aside className="w-[260px] shrink-0 hidden lg:block sticky top-[77px] max-h-[calc(100vh-100px)] overflow-y-auto pr-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground mb-4">
        <BookOpen className="w-4 h-4 text-muted-foreground" />
        <span>Documentation</span>
      </div>

      <nav className="space-y-5">
        {groups.map((group) => {
          const isLearnings = group.label.startsWith("Architecture Journal");
          const collapsed = isLearnings && !learningsOpen;
          const items = collapsed ? group.items.slice(0, 3) : group.items;
          return (
            <div key={group.label}>
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 px-2">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {items.map((item) => {
                  const href = item.slug ? `/docs/${item.slug}` : "/docs";
                  const active = pathname === href;
                  return (
                    <Link
                      key={item.slug || "root"}
                      href={href}
                      className={cn(
                        "block px-2.5 py-1.5 rounded-md text-[13px] transition-colors truncate",
                        active
                          ? "bg-accent text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
                      )}
                      title={item.title}
                    >
                      {item.title}
                    </Link>
                  );
                })}
                {collapsed && (
                  <Link
                    href="/docs/learnings/README"
                    className="block px-2.5 py-1.5 rounded-md text-[13px] text-muted-foreground hover:text-foreground hover:bg-accent/60"
                  >
                    + {group.items.length - 3} lainnya…
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
