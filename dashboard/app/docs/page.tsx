import { notFound } from "next/navigation";
import { renderDoc } from "@/lib/docs";

export const dynamic = "force-dynamic";

export default function DocsIndexPage() {
  const doc = renderDoc([]);
  if (!doc) notFound();

  return (
    <article
      className="prose prose-invert max-w-none
        prose-headings:tracking-tight
        prose-a:text-foreground prose-a:underline prose-a:decoration-foreground/30 hover:prose-a:decoration-foreground
        prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none
        prose-pre:bg-secondary prose-pre:border prose-pre:border-border prose-pre:rounded-lg
        prose-th:text-foreground prose-td:text-muted-foreground
        prose-strong:text-foreground
        prose-blockquote:border-foreground/30"
      dangerouslySetInnerHTML={{ __html: doc.html }}
    />
  );
}
