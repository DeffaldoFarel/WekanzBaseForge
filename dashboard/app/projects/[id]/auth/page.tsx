"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

export default function AuthServiceRedirectPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  useEffect(() => {
    // Otomatis arahkan ke Database Studio (Pola 1 PocketBase)
    const timer = setTimeout(() => {
      router.replace(`/projects/${projectId}/database`);
    }, 1200);
    return () => clearTimeout(timer);
  }, [projectId, router]);

  return (
    <div style={{ maxWidth: 640, margin: "3rem auto", padding: "1.5rem" }}>
      <div className="card" style={{ textAlign: "center", padding: "2.5rem 1.5rem" }}>
        <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>👤 ➔ 🗄️</div>
        <h2 style={{ marginBottom: "0.5rem" }}>Auth Kini Terintegrasi di Database Studio</h2>
        <p className="muted" style={{ fontSize: "0.9rem", lineHeight: 1.6, marginBottom: "1.5rem" }}>
          Mengikuti arsitektur PocketBase, pengelolaan akun pengguna kini menjadi <strong>Unified Auth Collections</strong> di Database Studio. Kamu bisa mengelola data user, foto avatar, role, dan kolom profil kustom lainnya secara langsung.
        </p>
        <Link href={`/projects/${projectId}/database`} className="btn btn-primary">
          Buka Database &amp; Collections Studio →
        </Link>
      </div>
    </div>
  );
}
