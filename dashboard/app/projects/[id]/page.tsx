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
import { Navbar } from "@/components/Navbar";

const SERVICE_INFO: Record<string, { title: string; desc: string; icon: string }> = {
  database: {
    title: "Database & Auth",
    desc: "SQLite database relasional & Unified Auth Collections (PocketBase style)",
    icon: "🗄️",
  },
  storage: {
    title: "Storage",
    desc: "Penyimpanan berkas fisik, thumbnailing, dan pembersihan file yatim",
    icon: "📁",
  },
  functions: {
    title: "Functions",
    desc: "Serverless isolated code execution, event triggers, dan cron scheduler",
    icon: "⚡",
  },
};

const OPEN_SERVICES = [
  {
    key: "database",
    title: "Database & Collections",
    icon: "🗄️",
    desc: "Kelola tabel data, skema kolom, SQL Views, dan akun pengguna (Auth)",
    href: (id: string) => `/projects/${id}/database`,
    serviceKey: "database" as const,
    tag: "PocketBase Parity",
  },
  {
    key: "storage",
    title: "Storage Explorer",
    icon: "📁",
    desc: "Berkas fisik, pratinjau media resolusi tinggi, dan bersihkan file sampah",
    href: (id: string) => `/projects/${id}/storage`,
    serviceKey: "storage" as const,
    tag: "File Manager",
  },
  {
    key: "functions",
    title: "Functions & Scheduler",
    icon: "⚡",
    desc: "Serverless isolated runtime, event triggers, dan cron scheduler",
    href: (id: string) => `/projects/${id}/functions`,
    serviceKey: "functions" as const,
    tag: "Serverless",
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
      <Navbar projectId={project.id} projectName={project.name} />

      <div className="page">
        {/* Breadcrumb & Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "0.25rem" }}>
              <Link href="/projects" style={{ textDecoration: "none" }}>Projects</Link>
              <span>/</span>
              <span style={{ color: "var(--text)", fontWeight: 600 }}>{project.name}</span>
            </div>
            <h1 style={{ fontSize: "1.85rem", fontWeight: 800, letterSpacing: "-0.03em" }}>
              {project.name}
            </h1>
          </div>

          <button className="btn btn-danger" onClick={onDelete} style={{ fontSize: "0.82rem", padding: "0.45rem 1.1rem" }}>
            🗑️ Hapus Project
          </button>
        </div>

        {/* Project Metadata Card */}
        <div className="card" style={{ padding: "1.25rem 1.75rem", marginBottom: "1.75rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem" }}>
            <div>
              <div className="muted" style={{ fontSize: "0.78rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "0.2rem" }}>
                Project Identifier
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "0.88rem", fontWeight: 600 }}>
                {project.id}
              </div>
            </div>

            <div>
              <div className="muted" style={{ fontSize: "0.78rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "0.2rem" }}>
                API Endpoint Base
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "0.85rem", color: "var(--blue)" }}>
                /api/p/{project.id}
              </div>
            </div>

            <div>
              <div className="muted" style={{ fontSize: "0.78rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "0.2rem" }}>
                Tanggal Dibuat
              </div>
              <div style={{ fontSize: "0.88rem", fontWeight: 500 }}>
                {new Date(project.created).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}
              </div>
            </div>
          </div>
        </div>

        {/* Buka Layanan Section (Hero Shortcuts) */}
        <div style={{ marginBottom: "2rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h3 style={{ fontSize: "1.15rem", fontWeight: 700 }}>Pusat Layanan</h3>
            <span className="muted" style={{ fontSize: "0.82rem" }}>Klik layanan untuk membuka studio</span>
          </div>

          <div className="service-links">
            {OPEN_SERVICES.map((s) => {
              const on = project.services[s.serviceKey];
              return (
                <Link
                  key={s.key}
                  href={s.href(project.id)}
                  className={`service-link ${on ? "" : "disabled"}`}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.6rem" }}>
                    <div
                      style={{
                        width: "44px",
                        height: "44px",
                        borderRadius: "14px",
                        background: "#EFF3F8",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "1.35rem",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {s.icon}
                    </div>
                    <span className="badge badge-gray" style={{ fontSize: "0.68rem" }}>
                      {s.tag}
                    </span>
                  </div>

                  <div className="t">
                    {s.title} <span style={{ marginLeft: "0.3rem", transition: "transform 0.15s" }}>→</span>
                  </div>
                  <div className="d">{on ? s.desc : "Nonaktif — aktifkan tombol switch di bawah"}</div>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Layanan Switch Toggles */}
        <div>
          <h3 style={{ fontSize: "1.15rem", fontWeight: 700, marginBottom: "0.35rem" }}>
            Konfigurasi &amp; Switch Layanan
          </h3>
          <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "1rem" }}>
            Aktifkan atau matikan modul platform untuk menghemat sumber daya sistem.
          </p>

          <div className="card" style={{ padding: "0.5rem 1.5rem" }}>
            {Object.entries(SERVICE_INFO).map(([key, info]) => {
              const on = project.services[key as keyof Project["services"]];
              return (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "1rem 0",
                    borderBottom: key !== "functions" ? "1px solid var(--border-subtle)" : "none",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
                    <span style={{ fontSize: "1.3rem" }}>{info.icon}</span>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{info.title}</div>
                      <div className="muted" style={{ fontSize: "0.82rem", marginTop: "0.15rem" }}>
                        {info.desc}
                      </div>
                    </div>
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
        </div>
      </div>
    </>
  );
}
