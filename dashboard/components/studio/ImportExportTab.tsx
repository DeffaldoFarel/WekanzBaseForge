"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Download, Upload } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ImportExportTabProps {
  collectionName: string;
  importMode: "create" | "replace" | "merge";
  importJsonText: string;
  importing: boolean;
  ioMessage: string;
  onImportModeChange: (mode: "create" | "replace" | "merge") => void;
  onImportJsonChange: (text: string) => void;
  onExport: () => void;
  onImport: () => void;
}

export function ImportExportTab({
  collectionName,
  importMode,
  importJsonText,
  importing,
  ioMessage,
  onImportModeChange,
  onImportJsonChange,
  onExport,
  onImport,
}: ImportExportTabProps) {
  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-2">Backup & Data Migration (JSON)</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Export full collection schema and record rows to portable JSON format, or import from a previous backup.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Export Box */}
        <div className="bg-muted p-5 rounded-xl border border-border">
          <h4 className="font-semibold mb-2 flex items-center gap-2">
            <Download className="w-4 h-4 text-muted-foreground" />
            <span>Export Collection</span>
          </h4>
          <p className="text-sm text-muted-foreground mb-4">
            Download <code className="text-xs bg-background px-1.5 py-0.5 rounded">{collectionName}-export.json</code> containing all field definitions and data rows.
          </p>
          <Button onClick={onExport} className="gap-1.5">
            <Download className="w-4 h-4" />
            <span>Download Export JSON</span>
          </Button>
        </div>

        {/* Import Box */}
        <div className="bg-muted p-5 rounded-xl border border-border">
          <h4 className="font-semibold mb-2 flex items-center gap-2">
            <Upload className="w-4 h-4 text-muted-foreground" />
            <span>Import JSON Data</span>
          </h4>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="import-mode">Import Mode:</Label>
              <Select value={importMode} onValueChange={onImportModeChange}>
                <SelectTrigger id="import-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="create">create — create new (fails if already exists)</SelectItem>
                  <SelectItem value="replace">replace — drop old collection and replace</SelectItem>
                  <SelectItem value="merge">merge — upsert rows by record ID</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="import-json">Paste Export JSON Payload:</Label>
              <Textarea
                id="import-json"
                rows={4}
                placeholder='{"collection": {"name": "..."}, "records": [...]}'
                value={importJsonText}
                onChange={(e) => onImportJsonChange(e.target.value)}
                className="font-mono text-sm"
              />
            </div>

            {ioMessage && (
              <div
                className={`text-sm font-medium ${
                  ioMessage.includes("Successfully") ? "text-emerald-400" : "text-destructive"
                }`}
              >
                {ioMessage}
              </div>
            )}

            <Button onClick={onImport} disabled={importing || !importJsonText.trim()} className="gap-1.5">
              <Upload className="w-4 h-4" />
              <span>{importing ? "Importing…" : "Start JSON Import"}</span>
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
