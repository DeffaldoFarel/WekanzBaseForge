"use client";

import { useState, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";

interface RawJsonModalProps {
  data: Record<string, unknown> | null;
  onClose: () => void;
}

export function RawJsonModal({ data, onClose }: RawJsonModalProps) {
  // Feedback lokal di tombol (menggantikan alert() native). Toast global akan
  // terasa lepas dari aksinya; ikon centang tepat di tombol yang diklik lebih
  // jelas dan tidak memblokir apa pun.
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bersihkan timer saat modal ditutup/unmount — pola yang sama yang sudah
  // diterapkan di webhooks & toast.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function handleCopy() {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }

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
              onClick={handleCopy}
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? "Copied" : "Copy JSON"}</span>
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
