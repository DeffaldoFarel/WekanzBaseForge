"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logout } from "@/lib/api";

interface NavbarProps {
  projectId?: string;
  projectName?: string;
}

export function Navbar({ projectId, projectName }: NavbarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const isDatabase = pathname?.includes("/database");
  const isStorage = pathname?.includes("/storage");
  const isFunctions = pathname?.includes("/functions");
  const isOverview = projectId && !isDatabase && !isStorage && !isFunctions;

  function handleLogout() {
    logout();
    router.replace("/login");
  }

  return (
    <header className="topbar">
      <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
        <Link href="/projects" className="brand">
          <div className="brand-icon">⚡</div>
          <div>
            wekanz<span style={{ color: "var(--blue)" }}>BaseForge</span>
          </div>
        </Link>

        {projectName && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              background: "#EFF3F8",
              padding: "0.3rem 0.8rem",
              borderRadius: "var(--radius-pill)",
              fontSize: "0.82rem",
              fontWeight: 600,
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
            }}
          >
            <span>📁</span>
            <span style={{ color: "var(--text)" }}>{projectName}</span>
          </div>
        )}
      </div>

      {/* Center Navigation Chips (Inspired by SugarCRM reference) */}
      {projectId ? (
        <nav className="nav-chips">
          <Link
            href={`/projects/${projectId}`}
            className={`nav-chip ${isOverview ? "active" : ""}`}
          >
            <span>🏠</span> Overview
          </Link>
          <Link
            href={`/projects/${projectId}/database`}
            className={`nav-chip ${isDatabase ? "active" : ""}`}
          >
            <span>🗄️</span> Collections
          </Link>
          <Link
            href={`/projects/${projectId}/storage`}
            className={`nav-chip ${isStorage ? "active" : ""}`}
          >
            <span>📁</span> Storage
          </Link>
          <Link
            href={`/projects/${projectId}/functions`}
            className={`nav-chip ${isFunctions ? "active" : ""}`}
          >
            <span>⚡</span> Functions
          </Link>
        </nav>
      ) : (
        <nav className="nav-chips">
          <div className="nav-chip active">
            <span>🚀</span> All Projects
          </div>
        </nav>
      )}

      {/* Right Utilities */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            background: "#FFFFFF",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-pill)",
            padding: "0.35rem 0.85rem",
            fontSize: "0.82rem",
            fontWeight: 600,
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <div
            style={{
              width: "22px",
              height: "22px",
              borderRadius: "50%",
              background: "#0A0B0D",
              color: "#FFFFFF",
              fontSize: "0.7rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
            }}
          >
            A
          </div>
          <span style={{ color: "var(--text)" }}>Admin</span>
        </div>

        <button className="btn btn-secondary" onClick={handleLogout} style={{ padding: "0.45rem 1rem", fontSize: "0.82rem" }}>
          Sign out
        </button>
      </div>
    </header>
  );
}
