"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";

interface RawJsonModalProps {
  data: Record<string, unknown> | null;
  onClose: () => void;
}

export function RawJsonModal({ data, onClose }: RawJsonModalProps) {
  return (
    <Dialog open={!!data} onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex justify-between items-center">
            <span>Record Raw JSON ({String(data?.id || "")})</span>
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(data, null, 2));
                alert("JSON copied to clipboard!");
              }}
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy JSON</span>
            </Button>
          </DialogTitle>
        </DialogHeader>
        <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm text-foreground font-mono">
          {JSON.stringify(data, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
