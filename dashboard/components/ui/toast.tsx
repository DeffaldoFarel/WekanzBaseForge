"use client";

import * as React from "react";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";

export type ToastKind = "success" | "error";
export interface ToastItem { id: number; kind: ToastKind; text: string }

/**
 * useToasts — notifikasi ringan non-blokir pengganti alert() native.
 * Sukses/info/error muncul sebagai toast pojok yang hilang sendiri.
 *
 * Perbaikan timer (temuan audit):
 *
 * Versi lama `setTimeout(() => dismiss(id), 5000)` tanpa menyimpan id timer —
 * setiap toast meninggalkan satu timer menggantung yang tetap hidup setelah
 * komponen unmount. Dua efek buruk: (1) timer memanggil setState pada komponen
 * yang sudah mati (React memperingatkan, dan di fast-refresh dev terlihat
 * aneh), (2) di halaman yang membuka banyak toast, timer menumpuk tak
 * terhitung. Kini setiap timer dilacak dan dibatalkan saat unmount atau saat
 * toast di-dismiss manual sebelum 5 detik.
 */
export function useToasts() {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const idRef = React.useRef(0);
  // id toast → handle timer. Dipakai untuk membatalkan timer yang belum jalan.
  const timersRef = React.useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = React.useCallback((id: number) => {
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
    setToasts((t0) => t0.filter((x) => x.id !== id));
  }, []);

  const push = React.useCallback(
    (kind: ToastKind, text: string) => {
      const id = ++idRef.current;
      setToasts((t) => [...t, { id, kind, text }]);
      const timer = setTimeout(() => dismiss(id), 5000);
      timersRef.current.set(id, timer);
    },
    [dismiss]
  );

  // Unmount: batalkan SEMUA timer yang belum jalan. Tanpa ini, timer yang
  // hidup lebih lama dari komponen memanggil setState pada komponen mati.
  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const success = React.useCallback((text: string) => push("success", text), [push]);
  const error = React.useCallback((text: string) => push("error", text), [push]);

  return { toasts, success, error, dismiss };
}

/** Renderer toast — taruh sekali di dekat root konten halaman. */
export function ToastHost({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2.5 rounded-lg border px-4 py-3 shadow-lg text-sm bg-card ${
            t.kind === "success"
              ? "border-emerald-500/40 text-emerald-400"
              : "border-destructive/50 text-destructive"
          }`}
          role="status"
        >
          {t.kind === "success" ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <span className="flex-1 text-foreground">{t.text}</span>
          <button
            onClick={() => onDismiss(t.id)}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
