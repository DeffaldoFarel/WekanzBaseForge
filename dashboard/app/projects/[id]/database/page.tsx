"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  listCollections,
  type CollectionInfo,
} from "@/lib/api";
import { CreateCollectionModal } from "@/components/CreateCollectionModal";

export default function DatabaseIndexPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    listCollections(projectId)
      .then((cols) => {
        setCollections(cols);
        // Jika sudah ada collection, otomatis redirect ke collection pertama ala studio!
        if (cols.length > 0) {
          router.replace(`/projects/${projectId}/database/${encodeURIComponent(cols[0].name)}`);
        } else {
          setLoading(false);
        }
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Gagal memuat database");
        setLoading(false);
      });
  }, [projectId, router]);

  if (loading) {
    return (
      <div className="container" style={{ padding: "3rem 1rem", textAlign: "center" }}>
        <p className="muted">Memuat database…</p>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: "2rem 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div>
          <h2 style={{ margin: 0 }}>Database Studio</h2>
          <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.9rem" }}>
            Kelola tabel data (Base) & view SQL (View) dalam SQLite
          </p>
        </div>
        <button className="btn" onClick={() => setShowNew(true)}>
          + New Collection
        </button>
      </div>

      {error && (
        <div style={{ padding: "1rem", background: "rgba(239, 68, 68, 0.15)", border: "1px solid var(--red)", borderRadius: "8px", color: "var(--red)", marginBottom: "1.5rem" }}>
          ⚠️ {error}
        </div>
      )}

      {collections.length === 0 ? (
        <div className="card empty-state">
          <div className="big">📦</div>
          <h3>Belum ada collection</h3>
          <p className="muted" style={{ maxWidth: 420, margin: "0.5rem auto 1.5rem" }}>
            Buat collection pertama Anda untuk mulai menyimpan data atau membuat query view.
          </p>
          <button className="btn" onClick={() => setShowNew(true)}>
            + Buat Collection Pertama
          </button>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {collections.map((c) => (
            <Link
              key={c.name}
              href={`/projects/${projectId}/database/${encodeURIComponent(c.name)}`}
              className="collection-item"
              style={{ padding: "1rem 1.25rem", textDecoration: "none", color: "inherit" }}
            >
              <div className="info">
                <div className="name" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span>{c.type === "view" ? "👁️" : "📦"}</span>
                  <span>{c.name}</span>
                  <span className="badge badge-gray">{c.type === "view" ? "View" : "Base"}</span>
                </div>
                <div className="meta">
                  {c.fields.length} fields • {c.recordCount ?? 0} records
                </div>
              </div>
              <div style={{ color: "var(--muted)", fontSize: "0.9rem" }}>Buka Studio →</div>
            </Link>
          ))}
        </div>
      )}

      {showNew && (
        <CreateCollectionModal
          projectId={projectId}
          existingCollections={collections}
          onClose={() => setShowNew(false)}
          onCreated={(created) => {
            setShowNew(false);
            router.push(`/projects/${projectId}/database/${encodeURIComponent(created.name)}`);
          }}
        />
      )}
    </div>
  );
}
