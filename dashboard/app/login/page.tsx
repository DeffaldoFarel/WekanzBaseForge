"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { login } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BookOpen,
  Eye,
  EyeOff,
  Loader2,
  Zap,
} from "lucide-react";

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("admin@baseforge.local");
  const [password, setPassword] = useState("admin123");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      router.replace("/projects");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Login gagal: pastikan kredensial admin Anda benar."
      );
    } finally {
      setLoading(false);
    }
  }

  function handleGithubClick() {
    // Quick demo action: prefill credentials for instant developer onboarding
    setEmail("admin@baseforge.local");
    setPassword("admin123");
    setError("");
  }

  return (
    <div className="min-h-screen w-full grid grid-cols-1 lg:grid-cols-[460px_1fr] xl:grid-cols-[500px_1fr] bg-white text-zinc-900">
      {/* ─── LEFT COLUMN: AUTH FORM ─── */}
      <aside className="relative flex flex-col justify-between border-r border-zinc-200 px-8 sm:px-12 py-8 min-h-screen bg-white">
        {/* Top Logo */}
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[#3ECF8E] flex items-center justify-center shadow-sm">
            <Zap className="w-4 h-4 text-white fill-white" />
          </div>
          <span className="font-bold text-lg tracking-tight text-zinc-900">
            wekanz<span className="text-[#3ECF8E]">BaseForge</span>
          </span>
        </div>

        {/* Central Form Container */}
        <div className="w-full max-w-sm mx-auto my-auto py-10">
          <div className="space-y-1.5 mb-6 text-left">
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-900">
              {mode === "signup" ? "Get started" : "Welcome back"}
            </h1>
            <p className="text-sm text-zinc-500">
              {mode === "signup"
                ? "Create a new account"
                : "Sign in to your platform account"}
            </p>
          </div>

          {/* Continue with GitHub Button */}
          <button
            type="button"
            onClick={handleGithubClick}
            className="w-full h-10 px-4 rounded-md border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-900 text-sm font-medium flex items-center justify-center gap-2.5 shadow-sm transition-all active:scale-[0.99]"
          >
            <GithubIcon className="w-4 h-4 text-zinc-800" />
            <span>Continue with GitHub</span>
          </button>

          {/* Divider */}
          <div className="relative my-6 text-center text-xs">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-zinc-200" />
            </div>
            <span className="relative bg-white px-3 text-zinc-400 font-normal">
              or
            </span>
          </div>

          {/* Form */}
          <form onSubmit={onSubmit} className="space-y-4 text-left">
            <div className="space-y-1.5">
              <label
                htmlFor="email"
                className="text-xs font-medium text-zinc-900 block"
              >
                Email
              </label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="h-10 bg-[#f9fafb] border-zinc-300 rounded-md text-sm px-3.5 focus-visible:ring-1 focus-visible:ring-zinc-400 focus-visible:border-zinc-400"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="password"
                className="text-xs font-medium text-zinc-900 block"
              >
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
                  className="h-10 bg-[#f9fafb] border-zinc-300 rounded-md text-sm px-3.5 pr-11 focus-visible:ring-1 focus-visible:ring-zinc-400 focus-visible:border-zinc-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-zinc-400 hover:text-zinc-700 transition-colors"
                  tabIndex={-1}
                  title={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Mint Green Sign Up / Sign In Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 mt-6 rounded-md bg-[#A7F3D0] hover:bg-[#86efac] text-[#065F46] font-medium text-sm transition-all flex items-center justify-center gap-2 active:scale-[0.99] disabled:opacity-50 shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-[#065F46]" />
                  <span>Memproses...</span>
                </>
              ) : (
                <span>{mode === "signup" ? "Sign up" : "Sign in"}</span>
              )}
            </button>

            {error && (
              <div className="p-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs font-medium text-center">
                {error}
              </div>
            )}
          </form>

          {/* Toggle Sign in / Sign up Mode */}
          <p className="text-center text-sm text-zinc-500 mt-6">
            {mode === "signup" ? (
              <>
                Have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signin");
                    setError("");
                  }}
                  className="underline underline-offset-4 text-zinc-900 font-medium hover:text-black transition-colors"
                >
                  Sign in
                </button>
              </>
            ) : (
              <>
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signup");
                    setError("");
                  }}
                  className="underline underline-offset-4 text-zinc-900 font-medium hover:text-black transition-colors"
                >
                  Sign up
                </button>
              </>
            )}
          </p>
        </div>

        {/* Bottom Legal Disclaimer */}
        <p className="text-[11px] leading-relaxed text-zinc-500 text-center sm:text-left max-w-sm mx-auto">
          By continuing, you agree to WekanzBaseForge&apos;s{" "}
          <Link href="#" className="underline underline-offset-2 hover:text-zinc-800">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="#" className="underline underline-offset-2 hover:text-zinc-800">
            Privacy Policy
          </Link>
          , and to receive periodic emails with platform updates.
        </p>
      </aside>

      {/* ─── RIGHT COLUMN: DOCUMENTATION & TESTIMONIAL ─── */}
      <main className="hidden lg:flex flex-col justify-between p-10 xl:p-14 bg-white relative">
        {/* Top-Right Documentation Button */}
        <div className="flex justify-end">
          <a
            href="https://github.com/DeffaldoFarel/WekanzBaseForge"
            target="_blank"
            rel="noreferrer"
          >
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-zinc-700 border-zinc-200 rounded-md font-normal hover:bg-zinc-50 shadow-sm text-xs px-3.5 h-9"
            >
              <BookOpen className="w-4 h-4 text-zinc-500" />
              <span>Documentation</span>
            </Button>
          </a>
        </div>

        {/* Testimonial Section */}
        <div className="max-w-xl mx-auto my-auto px-6 text-left">
          {/* Big Quotation Mark Watermark */}
          <span className="text-8xl font-serif text-zinc-200 select-none block -mb-8 leading-none">
            “
          </span>
          <blockquote className="text-2xl xl:text-3xl font-medium tracking-tight text-zinc-900 leading-snug">
            Love BaseForge unified collections &amp; edge functions. Cursor + BaseForge + SQLite is all I need to build anything
          </blockquote>

          {/* Author Row */}
          <div className="flex items-center gap-3.5 mt-8">
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-amber-200 via-rose-300 to-teal-200 flex items-center justify-center text-zinc-800 font-bold text-xs shadow-sm ring-2 ring-white">
              DF
            </div>
            <div>
              <span className="text-sm font-medium text-zinc-900 block">
                @deffaldo
              </span>
              <span className="text-xs text-zinc-500 font-normal">
                Lead Architect • Wekanz Ecosystem
              </span>
            </div>
          </div>
        </div>

        {/* Empty bottom spacer to keep center vertically centered */}
        <div className="h-9" />
      </main>
    </div>
  );
}
