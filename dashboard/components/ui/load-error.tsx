"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * LoadError — pembeda antara "tidak ada data" dan "kami gagal mengambil data".
 *
 * Kenapa komponen ini ada:
 *
 * Pola `catch { setItems([]) }` tersebar di 12 tempat di dashboard ini. Efeknya
 * request yang GAGAL jatuh ke empty state yang berbunyi meyakinkan —
 * monitoring menampilkan "No firing alerts — everything is within thresholds"
 * padahal ia sama sekali tidak tahu keadaan sistem, dan editor API Rules
 * menampilkan "admin only" padahal rule-nya gagal dimuat.
 *
 * Empty state yang salah lebih berbahaya daripada error: user tidak punya
 * alasan untuk curiga. Daftar kosong terlihat seperti fakta.
 *
 * Aturan pakai: state `error` dicek SEBELUM `items.length === 0`, supaya
 * kegagalan tidak pernah bisa menyamar jadi "kosong".
 */
export function LoadError({
  message,
  onRetry,
  retrying = false,
  /** `inline` untuk ruang sempit (panel/sidebar), `card` untuk area utama. */
  variant = "card",
  className = "",
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  variant?: "card" | "inline";
  className?: string;
}) {
  const body = (
    <>
      <AlertTriangle
        aria-hidden="true"
        className={`text-destructive shrink-0 ${variant === "card" ? "w-5 h-5" : "w-4 h-4 mt-0.5"}`}
      />
      <div className="flex-1 min-w-0">
        <p className={`text-foreground font-medium ${variant === "card" ? "text-sm" : "text-xs"}`}>
          Couldn&apos;t load this data
        </p>
        {/* Pesan server ditampilkan apa adanya: "gagal" tanpa sebab memaksa
            user menebak apakah ini masalah jaringan, izin, atau bug. */}
        <p className="text-xs text-muted-foreground mt-0.5 break-words">{message}</p>
      </div>
      {onRetry && (
        <Button
          variant="outline"
          className={variant === "card" ? "h-8 px-3 shrink-0" : "h-7 px-2.5 text-xs shrink-0"}
          onClick={onRetry}
          disabled={retrying}
        >
          <RefreshCw aria-hidden="true" className={`w-3.5 h-3.5 ${retrying ? "animate-spin" : ""}`} />
          <span>{retrying ? "Retrying…" : "Retry"}</span>
        </Button>
      )}
    </>
  );

  return (
    <div
      // role=alert: kegagalan harus diumumkan ke screen reader, bukan hanya
      // berubah diam-diam di DOM.
      role="alert"
      className={
        variant === "card"
          ? `flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 ${className}`
          : `flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 ${className}`
      }
    >
      {body}
    </div>
  );
}

/** Ubah nilai apa pun yang dilempar menjadi pesan yang bisa dibaca manusia. */
export function errorMessage(e: unknown, fallback = "Request failed"): string {
  return e instanceof Error && e.message ? e.message : fallback;
}
