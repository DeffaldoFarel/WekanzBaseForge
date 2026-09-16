"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  listCollections,
  type CollectionInfo,
} from "@/lib/api";
import { CreateCollectionModal } from "@/components/CreateCollectionModal";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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
      <div className="max-w-[1180px] mx-auto px-6 py-12 text-center">
        <p className="text-muted-foreground">Memuat database…</p>
      </div>
    );
  }

  return (
    <div className="max-w-[1180px] mx-auto px-6 py-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold">Database Studio</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Kelola tabel data (Base) & view SQL (View) dalam SQLite
          </p>
        </div>
        <Button onClick={() => setShowNew(true)}>
          + New Collection
        </Button>
      </div>

      {error && (
        <div className="p-4 bg-destructive/15 border border-destructive rounded-lg text-destructive text-sm mb-6">
          ⚠️ {error}
        </div>
      )}

      {collections.length === 0 ? (
        <Card className="p-12 text-center">
          <div className="text-4xl mb-4">📦</div>
          <h3 className="text-xl font-bold">Belum ada collection</h3>
          <p className="text-sm text-muted-foreground max-w-[420px] mx-auto my-4">
            Buat collection pertama Anda untuk mulai menyimpan data atau membuat query view.
          </p>
          <Button onClick={() => setShowNew(true)}>
            + Buat Collection Pertama
          </Button>
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          {collections.map((c) => (
            <Link
              key={c.name}
              href={`/projects/${projectId}/database/${encodeURIComponent(c.name)}`}
              className="flex items-center justify-between px-5 py-4 border-b border-border last:border-0 hover:bg-accent transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="text-lg">
                  {c.type === "view" ? "👁️" : c.type === "auth" ? "👤" : "📦"}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{c.name}</span>
                    <Badge variant="secondary" className="text-xs">
                      {c.type === "view" ? "View" : c.type === "auth" ? "Auth" : "Base"}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {c.fields.length} fields • {c.recordCount ?? 0} records
                  </div>
                </div>
              </div>
              <div className="text-sm text-muted-foreground">Buka Studio →</div>
            </Link>
          ))}
        </Card>
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
