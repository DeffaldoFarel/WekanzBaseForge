"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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
    <div className="max-w-[640px] mx-auto py-12 px-6">
      <Card className="p-10 text-center">
        <div className="text-4xl mb-4">👤 ➔ 🗄️</div>
        <h2 className="text-xl font-bold mb-2">Auth Kini Terintegrasi di Database Studio</h2>
        <p className="text-sm text-muted-foreground leading-relaxed mb-6">
          Mengikuti arsitektur PocketBase, pengelolaan akun pengguna kini menjadi <strong>Unified Auth Collections</strong> di Database Studio. Kamu bisa mengelola data user, foto avatar, role, dan kolom profil kustom lainnya secara langsung.
        </p>
        <Link href={`/projects/${projectId}/database`}>
          <Button>Buka Database &amp; Collections Studio →</Button>
        </Link>
      </Card>
    </div>
  );
}
