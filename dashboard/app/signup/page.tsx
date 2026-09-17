"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getAdminSetupState, setupInitialAdmin } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Eye, EyeOff, Loader2, Info, ShieldCheck, CheckCircle2 } from "lucide-react";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [setupState, setSetupState] = useState<{ needsSetup: boolean; hasAdmin: boolean } | null>(null);
  const [checkingSetup, setCheckingSetup] = useState(true);

  useEffect(() => {
    let active = true;
    getAdminSetupState()
      .then((state) => {
        if (active) {
          setSetupState(state);
          setCheckingSetup(false);
        }
      })
      .catch(() => {
        if (active) {
          // Fallback: assume setup can proceed if error checking
          setSetupState({ needsSetup: true, hasAdmin: false });
          setCheckingSetup(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await setupInitialAdmin(email, password);
      router.replace("/projects");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Setup failed: please check your details and try again."
      );
    } finally {
      setLoading(false);
    }
  }

  if (checkingSetup) {
    return (
      <AuthSplitLayout>
        <div className="flex flex-col items-center justify-center py-16 space-y-3">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Checking platform status…</p>
        </div>
      </AuthSplitLayout>
    );
  }

  // Jika admin sudah ada, kunci pendaftaran dan beri petunjuk jelas
  if (setupState && !setupState.needsSetup) {
    return (
      <AuthSplitLayout>
        <div className="space-y-1.5 mb-6 text-left">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-secondary text-secondary-foreground mb-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            <span>Setup Completed</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
            Admin configured
          </h1>
          <p className="text-sm text-muted-foreground">
            A master administrator account is already active on this platform.
          </p>
        </div>

        <div className="p-4 rounded-lg bg-secondary/60 border border-border text-xs text-muted-foreground space-y-2 text-left mb-6">
          <p>
            Self-hosted registration is restricted to a single master administrator during initial setup.
          </p>
          <p>
            Please sign in with your administrator credentials to manage projects and platform services.
          </p>
        </div>

        <Link
          href="/login"
          className="w-full h-10 rounded-md bg-primary hover:bg-primary/85 text-primary-foreground font-medium text-sm transition-colors flex items-center justify-center gap-2"
        >
          Proceed to Sign In
        </Link>
      </AuthSplitLayout>
    );
  }

  return (
    <AuthSplitLayout>
      <div className="space-y-1.5 mb-6 text-left">
        <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 mb-2 border border-emerald-500/20">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Initial Admin Setup</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
          Create admin account
        </h1>
        <p className="text-sm text-muted-foreground">
          Set up the master administrator for this BaseForge instance
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
            placeholder="admin@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className="text-xs font-medium text-foreground block">
            Password (min. 8 characters)
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
          className="w-full h-10 mt-6 rounded-md bg-primary hover:bg-primary/85 text-primary-foreground font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Configuring administrator…</span>
            </>
          ) : (
            <span>Create Master Admin</span>
          )}
        </button>

        {error && (
          <div className="p-3 rounded-md bg-destructive/10 border border-destructive/40 text-destructive text-xs font-medium text-center">
            {error}
          </div>
        )}
      </form>

      <p className="text-center text-sm text-muted-foreground mt-6">
        Already created an account?{" "}
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
          This initial account holds full administrative access to create projects, configure database schemas, and manage platform services.
        </span>
      </div>
    </AuthSplitLayout>
  );
}
