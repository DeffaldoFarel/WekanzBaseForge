import type { ReactNode } from "react";
import { Navbar } from "@/components/Navbar";
import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { listDocs } from "@/lib/docs";

// Dokumen dibaca dari disk pada setiap request (self-hosted: edit .md → refresh)
export const dynamic = "force-dynamic";

export default function DocsLayout({ children }: { children: ReactNode }) {
  const groups = listDocs();

  return (
    <>
      <Navbar />
      <div className="max-w-[1200px] mx-auto px-6 py-6 flex gap-8 items-start">
        <DocsSidebar groups={groups} />
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </>
  );
}
