"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Zap, Mail, Lock, ArrowRight, Loader2 } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      setError(err instanceof Error ? err.message : "Login gagal: periksa kredensial Anda");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="center-screen">
      <Card className="login-box w-full max-w-[420px] p-8 border-border shadow-modal rounded-[28px]">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-primary text-white flex items-center justify-center shadow-md">
            <Zap className="w-5 h-5 fill-white" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-foreground m-0">
              wekanz<span className="text-brand-blue">BaseForge</span>
            </h1>
            <span className="text-xs text-muted-foreground font-medium">Backend Platform Console</span>
          </div>
        </div>

        <p className="text-sm text-muted-foreground mb-6">
          Masuk sebagai administrator platform untuk mengelola project dan layanan.
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Mail className="w-3.5 h-3.5 text-muted-foreground" />
              <span>Email Administrator</span>
            </label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@baseforge.local"
              required
            />
          </div>

          <div className="space-y-1.5 pb-2">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-muted-foreground" />
              <span>Password</span>
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <Button type="submit" className="w-full h-11 text-sm font-semibold" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Memverifikasi...</span>
              </>
            ) : (
              <>
                <span>Sign in ke Console</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </Button>

          {error && (
            <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs font-medium text-center">
              {error}
            </div>
          )}
        </form>
      </Card>
    </div>
  );
}
