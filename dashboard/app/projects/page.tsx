"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { listProjects, createProject, logout, getToken, type Project } from "@/lib/api";

const SERVICE_LABELS: Record<string, string> = {
  database: "Database",
  auth: "Auth",
  storage: "Storage",
  functions: "Functions",
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
      <div className="topbar">
        <div className="brand">
          Wekanz<span>BaseForge</span> 🛠️
        </div>
        <button
          className="btn btn-secondary"
          onClick={() => {
            logout();
            router.replace("/login");
          }}
        >
          Sign out
        </button>
      </div>

      <div className="page">
        <div className="header-row">
          <h2>Projects</h2>
        </div>
        <p className="muted">Pilih project untuk mengelola layanannya — seperti Firebase Console.</p>

        <form onSubmit={onCreate} className="card" style={{ marginTop: "1.25rem", display: "flex", gap: "0.75rem" }}>
          <input
            className="input"
            placeholder="Nama project baru (misal: wekanz)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn" disabled={creating || !name.trim()}>
            {creating ? "Creating..." : "+ New Project"}
          </button>
        </form>
        {error && <p className="error-text">{error}</p>}

        <div className="project-grid">
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="card project-card">
              <h3>{p.name}</h3>
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                {p.id}
              </div>
              <div>
                {Object.entries(p.services).map(([key, on]) => (
                  <span key={key} className={`svc-badge ${on ? "on" : ""}`}>
                    {SERVICE_LABELS[key] ?? key}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>

        {projects.length === 0 && (
          <p className="muted" style={{ marginTop: "2rem", textAlign: "center" }}>
            Belum ada project. Buat yang pertama di atas! 🚀
          </p>
        )}
      </div>
    </>
  );
}
