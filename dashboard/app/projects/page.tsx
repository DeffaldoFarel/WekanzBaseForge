"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { listProjects, createProject, getToken, type Project } from "@/lib/api";
import { Navbar } from "@/components/Navbar";

const SERVICE_LABELS: Record<string, { label: string; icon: string }> = {
  database: { label: "Database & Auth", icon: "🗄️" },
  storage: { label: "Storage", icon: "📁" },
  functions: { label: "Functions", icon: "⚡" },
};

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    listProjects()
      .then((p) => setProjects(p))
      .catch(() => router.replace("/login"))
      .finally(() => setLoaded(true));
  }, [router]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError("");
    try {
      const p = await createProject(name.trim());
      setProjects([p, ...projects]);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membuat project");
    } finally {
      setCreating(false);
    }
  }

  if (!loaded) return null;

  return (
    <>
      <Navbar />

      <div className="page">
        {/* Header Section */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "1.5rem" }}>
          <div>
            <h1 style={{ fontSize: "1.85rem", fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text)" }}>
              Platform Projects
            </h1>
            <p className="muted" style={{ fontSize: "0.92rem", marginTop: "0.25rem" }}>
              Kelola database, media storage, dan serverless functions per project ekosistem Wekanz.
            </p>
          </div>

          <div
            style={{
              background: "#FFFFFF",
              padding: "0.4rem 1rem",
              borderRadius: "var(--radius-pill)",
              fontSize: "0.85rem",
              fontWeight: 600,
              color: "var(--text)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <span>📦 Total: </span>
            <span style={{ color: "var(--blue)" }}>{projects.length} Projects</span>
          </div>
        </div>

        {/* Create Project Card Form */}
        <div className="card" style={{ padding: "1.25rem 1.5rem", marginBottom: "1.75rem" }}>
          <form onSubmit={onCreate} style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <div style={{ position: "relative", flex: 1 }}>
              <span style={{ position: "absolute", left: "1.1rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                🏷️
              </span>
              <input
                className="input"
                style={{ paddingLeft: "2.6rem" }}
                placeholder="Ketik nama project baru (contoh: wekanz-portal)..."
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <button className="btn" disabled={creating || !name.trim()}>
              {creating ? "Membuat..." : "+ Buat Project"}
            </button>
          </form>
          {error && <p className="error-text" style={{ marginTop: "0.75rem" }}>{error}</p>}
        </div>

        {/* Project Grid */}
        <div className="project-grid">
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="project-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
                <div
                  style={{
                    width: "42px",
                    height: "42px",
                    borderRadius: "12px",
                    background: "#F1F5F9",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "1.25rem",
                    border: "1px solid var(--border)",
                  }}
                >
                  📁
                </div>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "0.72rem",
                    background: "#F1F5F9",
                    padding: "0.2rem 0.6rem",
                    borderRadius: "var(--radius-pill)",
                    color: "var(--text-muted)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {p.id}
                </span>
              </div>

              <h3>{p.name}</h3>
              <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "1rem" }}>
                Dibuat pada {new Date(p.created).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}
              </p>

              {/* Service Capabilities */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                {Object.entries(SERVICE_LABELS).map(([key, item]) => (
                  <span
                    key={key}
                    className="badge badge-gray"
                    style={{ fontSize: "0.72rem" }}
                  >
                    <span style={{ fontSize: "0.75rem" }}>{item.icon}</span>
                    {item.label}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>

        {projects.length === 0 && (
          <div className="card" style={{ textAlign: "center", padding: "3.5rem 1.5rem", marginTop: "2rem" }}>
            <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>🚀</div>
            <h3 style={{ fontSize: "1.2rem", fontWeight: 700 }}>Belum Ada Project</h3>
            <p className="muted" style={{ fontSize: "0.9rem", marginTop: "0.25rem" }}>
              Mulai buat project pertama kamu menggunakan form input di atas.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
