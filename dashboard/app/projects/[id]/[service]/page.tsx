"use client";

import { useParams } from "next/navigation";
import Link from "next/link";

const TITLES: Record<string, { title: string; milestone: string }> = {
  database: { title: "Database", milestone: "M02–M07" },
  auth: { title: "Auth", milestone: "M08–M11" },
  storage: { title: "Storage", milestone: "M14" },
  functions: { title: "Functions", milestone: "M15" },
};

export default function ServicePage() {
  const params = useParams();
  const id = params.id as string;
  const service = params.service as string;
  const info = TITLES[service] ?? { title: service, milestone: "?" };

  return (
    <div className="page">
      <Link href={`/projects/${id}`} className="nav-back">
        ← Kembali ke Project
      </Link>
      <h2>{info.title}</h2>
      <div className="card" style={{ marginTop: "1rem" }}>
        <p className="muted">
          🚧 Layanan ini akan dibangun di milestone <strong>{info.milestone}</strong>.
        </p>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Ikuti roadmap di README — setiap milestone akan mengisi halaman ini.
        </p>
      </div>
    </div>
  );
}
