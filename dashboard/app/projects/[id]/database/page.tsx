"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  listCollections,
  type CollectionInfo,
} from "@/lib/api";
import { CreateCollectionModal } from "@/components/CreateCollectionModal";
import { Navbar } from "@/components/Navbar";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Box, Eye, Users, Plus, AlertTriangle, ArrowRight } from "lucide-react";

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
        setError(e instanceof Error ? e.message : "Failed to load database");
        setLoading(false);
      });
  }, [projectId, router]);

  return (
    <>
      <Navbar projectId={projectId} />

      <div className="max-w-[1180px] mx-auto px-6 py-6 flex gap-6 items-start">
        <ProjectSidebar projectId={projectId} />

        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Database Studio</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Manage data tables (Base) and SQL views (View) in SQLite
              </p>
            </div>
            <Button onClick={() => setShowNew(true)} className="gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              <span>New Collection</span>
            </Button>
          </div>

          {error && (
            <div className="p-4 bg-destructive/15 border border-destructive rounded-lg text-destructive text-sm mb-6 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <Card className="p-0 overflow-hidden">
              <div className="px-5 py-4 space-y-2">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="px-5 py-4 space-y-2 border-t border-border">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-4 w-28" />
              </div>
            </Card>
          ) : collections.length === 0 ? (
            <Card className="p-12 text-center">
              <Box className="w-12 h-12 mx-auto text-muted-foreground mb-4 opacity-50" />
              <h3 className="text-xl font-semibold">No collections yet</h3>
              <p className="text-sm text-muted-foreground max-w-[420px] mx-auto my-4">
                Create your first collection to start storing data or build a query view.
              </p>
              <Button onClick={() => setShowNew(true)} className="gap-1.5">
                <Plus className="w-3.5 h-3.5" />
                <span>Create First Collection</span>
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
                    <div className="w-9 h-9 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0">
                      {c.type === "view" ? (
                        <Eye className="w-4 h-4 text-purple-400" />
                      ) : c.type === "auth" ? (
                        <Users className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <Box className="w-4 h-4 text-foreground" />
                      )}
                    </div>
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
                  <div className="text-sm text-muted-foreground flex items-center gap-1">
                    <span>Open Studio</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </div>
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
      </div>
    </>
  );
}
