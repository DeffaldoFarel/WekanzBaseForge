"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { login, getAdminSetupState } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Eye, EyeOff, Loader2, Sparkles } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    let active = true;
    getAdminSetupState()
      .then((state) => {
        if (!active) return;
        // Jika belum ada admin di database, langsung arahkan ke First-Time Setup
        // (PocketBase pattern) agar operator membuat master admin pertama.
        if (state.needsSetup) {
          router.replace("/signup");
          return;
        }
      })
      .catch(() => {
        // Sengaja diabaikan, DAN ini aman — berbeda dari `catch {}` lain yang
        // sudah diperbaiki. Banner setup hanyalah jalan pintas; instalasi baru
        // tetap bisa dicapai lewat /signup, dan kegagalan login sendiri sudah
        // melapor lewat `setError` di onSubmit. Menampilkan error jaringan di
        // halaman login sebelum user melakukan apa pun justru membingungkan.
      });
    return () => {
      active = false;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      const redirectParam =
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("redirect")
          : null;
      const destination =
        redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//")
          ? redirectParam
          : "/projects";
      router.replace(destination);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Invalid credentials: please check your email and password."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthSplitLayout>
      <div className="space-y-1.5 mb-6 text-left">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
          Welcome back
        </h1>
        <p className="text-sm text-muted-foreground">
          Sign in to your platform account
        </p>
      </div>

      {needsSetup && (
        <div className="mb-5 p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-foreground flex items-center justify-between gap-3 text-left">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="font-medium text-emerald-950 dark:text-emerald-200">
              No administrator found. Setup is required.
            </span>
          </div>
          <Link
            href="/signup"
            className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs shrink-0 transition-colors"
          >
            Start Setup
          </Link>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4 text-left">
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-xs font-medium text-foreground block">
            Email
          </label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className="text-xs font-medium text-foreground block">
            Password
          </label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="pr-11"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              tabIndex={-1}
              title={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full h-10 mt-6 rounded-md bg-primary hover:bg-primary/85 text-primary-foreground font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Signing in…</span>
            </>
          ) : (
            <span>Sign in</span>
          )}
        </button>

        {error && (
          <div className="p-3 rounded-md bg-destructive/10 border border-destructive/40 text-destructive text-xs font-medium text-center">
            {error}
          </div>
        )}
      </form>

      {needsSetup && (
        <p className="text-center text-sm text-muted-foreground mt-6">
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="underline underline-offset-4 text-foreground font-medium hover:text-foreground/80 transition-colors"
          >
            Sign up
          </Link>
        </p>
      )}
    </AuthSplitLayout>
  );
}
