"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import {
  getProject,
  deleteProject,
  getToken,
  type Project,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";

const PLATFORM_SERVICES = [
  {
    key: "database",
    title: "Database & Collections",
    icon: "🗄️",
    desc: "Kelola tabel data relasional, skema kolom dinamis, SQL Views, dan akun pengguna (Auth).",
    href: (id: string) => `/projects/${id}/database`,
    tag: "PocketBase Parity",
  },
  {
    key: "storage",
    title: "Storage Explorer",
    icon: "📁",
    desc: "Penyimpanan berkas fisik, thumbnail image caching, dan pembersihan otomatis file yatim.",
    href: (id: string) => `/projects/${id}/storage`,
    tag: "File Storage",
  },
  {
    key: "functions",
    title: "Functions & Scheduler",
    icon: "⚡",
    desc: "Eksekusi kode JavaScript terisolasi, event-driven CRUD triggers, dan cron task scheduler.",
    href: (id: string) => `/projects/${id}/functions`,
    tag: "Serverless Engine",
  },
];

export default function ProjectDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
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

  async function onDelete() {
    if (!project) return;
    if (!confirm(`Hapus project "${project.name}"? Data dan file storage tidak bisa dikembalikan.`)) return;
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
        <div className="card" style={{ padding: "1.25rem 1.75rem", marginBottom: "2rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1.25rem" }}>
            <div>
              <div className="muted" style={{ fontSize: "0.78rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "0.25rem" }}>
                Project Identifier
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "0.9rem", fontWeight: 600 }}>
                {project.id}
              </div>
            </div>

            <div>
              <div className="muted" style={{ fontSize: "0.78rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "0.25rem" }}>
                API Endpoint Base
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "0.86rem", color: "var(--blue)" }}>
                /api/p/{project.id}
              </div>
            </div>

            <div>
              <div className="muted" style={{ fontSize: "0.78rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "0.25rem" }}>
                Tanggal Dibuat
              </div>
              <div style={{ fontSize: "0.88rem", fontWeight: 500 }}>
                {new Date(project.created).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}
              </div>
            </div>
          </div>
        </div>

        {/* Pusat Layanan Section (Hero Shortcuts) */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
            <div>
              <h3 style={{ fontSize: "1.2rem", fontWeight: 800, letterSpacing: "-0.02em" }}>Pusat Layanan</h3>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.15rem" }}>
                Semua layanan aktif dan siap digunakan langsung tanpa konfigurasi tambahan.
              </p>
            </div>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                background: "rgba(62, 174, 125, 0.12)",
                color: "#218456",
                padding: "0.3rem 0.85rem",
                borderRadius: "var(--radius-pill)",
                fontSize: "0.78rem",
                fontWeight: 600,
                border: "1px solid rgba(62, 174, 125, 0.25)",
              }}
            >
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#218456" }}></span>
              Semua Layanan Siap
            </span>
          </div>

          <div className="service-links" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {PLATFORM_SERVICES.map((s) => (
              <Link
                key={s.key}
                href={s.href(project.id)}
                className="service-link"
                style={{ padding: "1.5rem" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.85rem" }}>
                  <div
                    style={{
                      width: "48px",
                      height: "48px",
                      borderRadius: "14px",
                      background: "#EFF3F8",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "1.5rem",
                      border: "1px solid var(--border)",
                      boxShadow: "var(--shadow-sm)",
                    }}
                  >
                    {s.icon}
                  </div>
                  <span className="badge badge-gray" style={{ fontSize: "0.72rem" }}>
                    {s.tag}
                  </span>
                </div>

                <div className="t" style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "0.4rem" }}>
                  {s.title} <span style={{ marginLeft: "0.35rem", transition: "transform 0.15s" }}>→</span>
                </div>
                <div className="d" style={{ fontSize: "0.84rem", lineHeight: 1.5 }}>
                  {s.desc}
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
