"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fileUrl, type FieldDef } from "@/lib/api";
import { Check, X, Paperclip } from "lucide-react";

interface RenderTableCellProps {
  field: FieldDef;
  value: unknown;
  record: Record<string, unknown>;
  projectId: string;
  collectionName: string;
  onViewJson: () => void;
}

export function RenderTableCell({
  field,
  value,
  record,
  projectId,
  collectionName,
  onViewJson,
}: RenderTableCellProps) {
  if (value === null || value === undefined) {
    return (
      <span className="text-muted-foreground italic text-sm">null</span>
    );
  }

  if (field.type === "bool") {
    return value ? (
      <Badge variant="green" className="gap-1 text-[11px] py-0">
        <Check className="w-3 h-3" />
        <span>true</span>
      </Badge>
    ) : (
      <Badge variant="secondary" className="gap-1 text-[11px] py-0">
        <X className="w-3 h-3" />
        <span>false</span>
      </Badge>
    );
  }

  if (field.type === "file") {
    const filename = String(value);
    const url = fileUrl(projectId, collectionName, String(record.id), filename);
    const isImg = /\.(png|jpe?g|gif|webp|avif)$/i.test(filename);

    return (
      <div className="flex items-center gap-1.5">
        {isImg && url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${url}?thumb=100x100`}
            alt={filename}
            className="w-7 h-7 rounded object-cover"
          />
        ) : null}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-accent-foreground hover:underline text-sm inline-flex items-center gap-1"
        >
          <Paperclip className="w-3 h-3 text-muted-foreground" />
          <span>{filename.slice(0, 18)}</span>
        </a>
      </div>
    );
  }

  if (field.type === "json") {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onViewJson}
        className="font-mono text-xs h-6 px-2"
      >
        {typeof value === "object" ? JSON.stringify(value).slice(0, 24) + "…" : String(value)}
      </Button>
    );
  }

  if (field.type === "password") {
    return (
      <span className="text-muted-foreground text-sm">•••••••• (hash)</span>
    );
  }

  return <span className="text-sm">{String(value).slice(0, 36)}</span>;
}
