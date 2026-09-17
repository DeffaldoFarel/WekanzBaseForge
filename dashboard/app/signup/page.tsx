"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { login } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Eye, EyeOff, Loader2, Info } from "lucide-react";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
          : "Signup failed: please check your details and try again."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthSplitLayout>
      <div className="space-y-1.5 mb-6 text-left">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
          Get started
        </h1>
        <p className="text-sm text-muted-foreground">
          Create a new account
        </p>
      </div>

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
              minLength={8}
              className="pr-11"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
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
          className="w-full h-10 mt-6 rounded-md bg-primary hover:bg-primary/85 text-primary-foreground font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Creating account…</span>
            </>
          ) : (
            <span>Sign up</span>
          )}
        </button>

        {error && (
          <div className="p-3 rounded-md bg-destructive/10 border border-destructive/40 text-destructive text-xs font-medium text-center">
            {error}
          </div>
        )}
      </form>

      <p className="text-center text-sm text-muted-foreground mt-6">
        Already have an account?{" "}
        <Link
          href="/login"
          className="underline underline-offset-4 text-foreground font-medium hover:text-foreground/80 transition-colors"
        >
          Sign in
        </Link>
      </p>

      <div className="mt-6 p-3 rounded-md bg-secondary border border-border text-xs text-muted-foreground flex items-start gap-2">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          Platform accounts are provisioned by the administrator via server
          environment variables. New signups must be enabled on the server first
          (self-hosted single-operator mode).
        </span>
      </div>
    </AuthSplitLayout>
  );
}
