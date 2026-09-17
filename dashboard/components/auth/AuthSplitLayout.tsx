"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { BookOpen, Zap } from "lucide-react";

interface AuthSplitLayoutProps {
  /** Konten kolom kiri (form auth) */
  children: ReactNode;
}

/**
 * Split-screen shell bersama untuk halaman auth (/login, /signup):
 * kolom kiri = form (children), kolom kanan = dokumentasi + testimonial.
 */
export function AuthSplitLayout({ children }: AuthSplitLayoutProps) {
  return (
    <div className="min-h-screen w-full grid grid-cols-1 lg:grid-cols-[460px_1fr] xl:grid-cols-[500px_1fr] bg-background text-foreground">
      {/* ─── LEFT COLUMN: AUTH FORM ─── */}
      <aside className="relative flex flex-col justify-between border-r border-border px-8 sm:px-12 py-8 min-h-screen">
        {/* Top Logo */}
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-brand flex items-center justify-center">
            <Zap className="w-4 h-4 text-background fill-background" />
          </div>
          <span className="font-semibold text-lg tracking-tight text-foreground">
            wekanz<span className="text-muted-foreground">BaseForge</span>
          </span>
        </div>

        {/* Central Form Container */}
        <div className="w-full max-w-sm mx-auto my-auto py-10">{children}</div>

        {/* Bottom Legal Disclaimer */}
        <p className="text-[11px] leading-relaxed text-muted-foreground text-center sm:text-left max-w-sm mx-auto">
          By continuing, you agree to WekanzBaseForge&apos;s{" "}
          <Link href="#" className="underline underline-offset-2 hover:text-foreground">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="#" className="underline underline-offset-2 hover:text-foreground">
            Privacy Policy
          </Link>
          , and to receive periodic emails with platform updates.
        </p>
      </aside>

      {/* ─── RIGHT COLUMN: DOCUMENTATION & TESTIMONIAL ─── */}
      <main className="hidden lg:flex flex-col justify-between p-10 xl:p-14 relative">
        {/* Top-Right Documentation Button */}
        <div className="flex justify-end">
          <a
            href="https://github.com/DeffaldoFarel/WekanzBaseForge"
            target="_blank"
            rel="noreferrer"
          >
            <Button variant="outline" size="sm" className="gap-2">
              <BookOpen className="w-4 h-4 text-muted-foreground" />
              <span>Documentation</span>
            </Button>
          </a>
        </div>

        {/* Testimonial Section */}
        <div className="max-w-xl mx-auto my-auto px-6 text-left">
          <span className="text-8xl font-serif text-accent select-none block -mb-8 leading-none">
            “
          </span>
          <blockquote className="text-2xl xl:text-3xl font-medium tracking-tight text-foreground leading-snug">
            Love BaseForge unified collections &amp; edge functions. Cursor + BaseForge + SQLite is all I need to build anything
          </blockquote>

          <div className="flex items-center gap-3.5 mt-8">
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-neutral-600 via-neutral-400 to-neutral-700 flex items-center justify-center text-background font-bold text-xs ring-2 ring-border">
              DF
            </div>
            <div>
              <span className="text-sm font-medium text-foreground block">
                @deffaldo
              </span>
              <span className="text-xs text-muted-foreground font-normal">
                Lead Architect • Wekanz Ecosystem
              </span>
            </div>
          </div>
        </div>

        <div className="h-9" />
      </main>
    </div>
  );
}
