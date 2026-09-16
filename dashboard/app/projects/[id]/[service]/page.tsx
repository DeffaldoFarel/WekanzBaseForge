"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { Card } from "@/components/ui/card";

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
    <div className="max-w-[1180px] mx-auto px-6 py-6">
      <Link href={`/projects/${id}`} className="text-sm text-muted-foreground hover:text-foreground">
        ← Kembali ke Project
      </Link>
      <h2 className="text-2xl font-bold mt-4">{info.title}</h2>
      <Card className="p-6 mt-4">
        <p className="text-muted-foreground">
          🚧 Layanan ini akan dibangun di milestone <strong>{info.milestone}</strong>.
        </p>
        <p className="text-muted-foreground mt-2">
          Ikuti roadmap di README — setiap milestone akan mengisi halaman ini.
        </p>
      </Card>
    </div>
  );
}
