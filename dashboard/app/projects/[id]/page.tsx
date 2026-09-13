"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import {
  getProject,
  updateServices,
  deleteProject,
  getToken,
  type Project,
} from "@/lib/api";

const SERVICE_INFO: Record<string, { title: string; desc: string }> = {
  database: { title: "Database & Auth", desc: "SQLite database & Unified Auth Collections (PocketBase style)" },
  storage: { title: "Storage", desc: "File storage, media preview & orphaned files cleanup" },
  functions: { title: "Functions", desc: "Serverless functions, triggers & cron scheduler" },
};

const OPEN_SERVICES = [
  {
    key: "database",
    title: "Database & Collections",
    icon: "🗄️",
    desc: "Kelola tabel data, skema, SQL Views, dan akun pengguna (Auth)",
    href: (id: string) => `/projects/${id}/database`,
    serviceKey: "database" as const,
  },
  {
    key: "storage",
    title: "Storage Explorer",
    icon: "📁",
    desc: "Berkas fisik, pratinjau media, dan pembersihan file yatim",
    href: (id: string) => `/projects/${id}/storage`,
    serviceKey: "storage" as const,
  },
  {
    key: "functions",
    title: "Functions & Scheduler",
    icon: "⚡",
    desc: "Serverless execution, event triggers, dan cron scheduler",
    href: (id: string) => `/projects/${id}/functions`,
    serviceKey: "functions" as const,
  },
];

export default function ProjectDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    getProject(id)
      .then(setProject)
      .catch(() => setError("Project tidak ditemukan"));
  }, [id, router]);

  async function toggle(service: string) {
    if (!project || toggling) return;
    setToggling(service);
    try {
      const current = project.services[service as keyof Project["services"]];
      const nextVal = !current;
      const patchData: Record<string, boolean> = { [service]: nextVal };
      if (service === "database") {
        patchData.auth = nextVal;
      }
      const updated = await updateServices(project.id, patchData);
      setProject(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal mengubah layanan");
    } finally {
      setToggling(null);
    }
  }

  async function onDelete() {
    if (!project) return;
    if (!confirm(`Hapus project "${project.name}"? Data tidak bisa dikembalikan.`)) return;
    await deleteProject(project.id);
    router.replace("/projects");
  }

  if (error) {
    return (
      <div className="page">
        <Link href="/projects" className="nav-back">← Kembali ke Projects</Link>
        <p className="error-text">{error}</p>
      </div>
    );
  }
  if (!project) return null;

  return (
    <>
      <div className="topbar">
        <div className="brand">
          Wekanz<span>BaseForge</span> 🛠️
        </div>
      </div>

      <div className="page">
        <Link href="/projects" className="nav-back">← Kembali ke Projects</Link>

        <div className="header-row">
          <h2>{project.name}</h2>
          <button className="btn btn-danger" onClick={onDelete}>
            Delete Project
          </button>
        </div>

        <div className="card" style={{ marginTop: "0.75rem" }}>
          <div className="kv"><span className="k">Project ID</span><span className="v">{project.id}</span></div>
          <div className="kv"><span className="k">API Key</span><span className="v">{project.apiKey ?? '— (coming soon)'}</span></div>
          <div className="kv"><span className="k">Created</span><span className="v">{new Date(project.created).toLocaleString("id-ID")}</span></div>
        </div>

        <h3 style={{ marginTop: "2rem" }}>Layanan</h3>
        <p className="muted" style={{ fontSize: "0.9rem" }}>
          Aktifkan layanan yang dibutuhkan project ini.
        </p>

        <div className="card" style={{ marginTop: "0.75rem" }}>
          {Object.entries(SERVICE_INFO).map(([key, info]) => {
            const on = project.services[key as keyof Project["services"]];
            return (
              <div key={key} className="svc-row">
                <div>
                  <div>{info.title}</div>
                  <div className="desc">{info.desc}</div>
                </div>
                <button
                  className={`toggle ${on ? "on" : ""}`}
                  onClick={() => toggle(key)}
                  disabled={toggling !== null}
                  aria-label={`Toggle ${info.title}`}
                />
              </div>
            );
          })}
        </div>

        <h3 style={{ marginTop: "2rem" }}>Buka Layanan</h3>
        <div className="service-links">
          {OPEN_SERVICES.map((s) => {
            const on = project.services[s.serviceKey];
            return (
              <Link
                key={s.key}
                href={s.href(project.id)}
                className={`service-link ${on ? "" : "disabled"}`}
              >
                <div className="t">
                  <span style={{ marginRight: "0.4rem" }}>{s.icon}</span>
                  {s.title} →
                </div>
                <div className="d">{on ? s.desc : "Nonaktif — aktifkan dulu di atas"}</div>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
