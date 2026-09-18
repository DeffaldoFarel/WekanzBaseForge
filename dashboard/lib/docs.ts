// ============================================================================
// DOCS VIEWER (server-only) — membaca file .md asli dari repo & me-render HTML
//
// Sumber: ../docs/*.md (panduan), ../docs/learnings/*.md (jurnal),
//         ../packages/client/README.md (SDK), ../COMPARISON.md.
// Aman dari path traversal: segmen slug divalidasi [A-Za-z0-9_-] + tanpa '..'.
// Link antar-dokumen (href="getting-started.md") di-rewrite ke route /docs/…
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

const REPO_ROOT = path.join(process.cwd(), "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");

export interface DocsEntry {
  slug: string; // mis. 'getting-started' | 'learnings/M10-oauth2'
  title: string;
}

export interface DocsGroup {
  label: string;
  items: DocsEntry[];
}

/** Judul = heading H1 pertama file; fallback ke nama file. */
function firstTitle(filePath: string, fallback: string): string {
  try {
    const md = fs.readFileSync(filePath, "utf-8");
    const m = md.match(/^#\s+(.+)$/m);
    if (m) {
      return m[1]
        .replace(/[^\w\s&()—–\-./:]/g, "")
        .trim();
    }
  } catch {}
  return fallback;
}

const MAIN_GUIDES: Array<{ file: string; title: string }> = [
  { file: "README.md", title: "Documentation Portal" },
  { file: "getting-started.md", title: "Getting Started" },
  { file: "api-reference.md", title: "REST API Reference" },
  { file: "api-rules.md", title: "API Rules & Security" },
  { file: "realtime.md", title: "Realtime (SSE)" },
  { file: "functions.md", title: "Serverless Functions" },
  { file: "deployment.md", title: "Deployment Produksi" },
];

const SPECIAL_DOCS: DocsEntry[] = [
  { slug: "sdk", title: "Client SDK (@wekanz/baseforge)" },
  { slug: "comparison", title: "Perbandingan vs Supabase & Appwrite" },
];

/** Daftar dokumen untuk sidebar navigasi (dibaca dari disk setiap request). */
export function listDocs(): DocsGroup[] {
  const guides: DocsEntry[] = MAIN_GUIDES.map((g) => ({
    slug: g.file === "README.md" ? "" : g.file.replace(/\.md$/, ""),
    title: g.title,
  }));

  const learnings: DocsEntry[] = [];
  const learningsDir = path.join(DOCS_DIR, "learnings");
  if (fs.existsSync(learningsDir)) {
    for (const f of fs.readdirSync(learningsDir).sort().reverse()) {
      if (f === "README.md" || !f.endsWith(".md")) continue;
      learnings.push({
        slug: `learnings/${f.replace(/\.md$/, "")}`,
        title: f.replace(/\.md$/, "").replace(/-/g, " — "),
      });
    }
  }

  return [
    { label: "Guides", items: [...guides, ...SPECIAL_DOCS] },
    { label: "Architecture Journal (M00–M44)", items: learnings },
  ];
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Resolve slug (segmen URL) → path file .md absolut. null bila tidak valid/ada. */
export function resolveDocPath(slug: string[]): string | null {
  if (slug.length === 0) return path.join(DOCS_DIR, "README.md");
  if (slug.length === 1 && slug[0] === "sdk") {
    return path.join(REPO_ROOT, "packages", "client", "README.md");
  }
  if (slug.length === 1 && slug[0] === "comparison") {
    return path.join(REPO_ROOT, "COMPARISON.md");
  }
  // Path traversal guard: setiap segmen harus alfanumerik-terselamat
  if (slug.some((s) => !SEGMENT_RE.test(s))) return null;
  const filePath = path.join(DOCS_DIR, ...slug) + ".md";
  if (!filePath.startsWith(DOCS_DIR)) return null;
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

/** Rewrite link antar-dokumen di HTML hasil marked → route /docs/*. */
function rewriteDocLinks(html: string): string {
  return html
    .replace(/href="\.\.\/packages\/client\/README\.md"/g, 'href="/docs/sdk"')
    .replace(/href="\.\.\/\.\.\/COMPARISON\.md"/g, 'href="/docs/comparison"')
    .replace(/href="(\.\/)?((?:learnings\/)?[^"#:]+?)\.md"/g, (_m, _prefix, docPath) => {
      return `href="/docs/${docPath}"`;
    });
}

export interface RenderedDoc {
  title: string;
  html: string;
}

/** Baca + render satu dokumen. null bila tidak ditemukan. */
export function renderDoc(slug: string[]): RenderedDoc | null {
  const filePath = resolveDocPath(slug);
  if (!filePath) return null;

  const md = fs.readFileSync(filePath, "utf-8");
  const title = firstTitle(filePath, "Documentation");
  const html = rewriteDocLinks(marked.parse(md, { async: false }) as string);
  return { title, html };
}
