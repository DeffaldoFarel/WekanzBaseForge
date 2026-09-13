"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/api";

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
      <div className="card login-box">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1.25rem" }}>
          <div className="brand-icon" style={{ width: "40px", height: "40px", fontSize: "1.25rem" }}>
            ⚡
          </div>
          <div>
            <h1 style={{ fontSize: "1.35rem", fontWeight: 800, margin: 0 }}>
              wekanz<span style={{ color: "var(--blue)" }}>BaseForge</span>
            </h1>
            <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Backend Platform Console</span>
          </div>
        </div>

        <p className="sub">Masuk sebagai administrator platform</p>

        <form onSubmit={onSubmit}>
          <div className="field">
            <label>
              <span>Email Administrator</span>
            </label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@baseforge.local"
              required
            />
          </div>

          <div className="field" style={{ marginBottom: "1.5rem" }}>
            <label>
              <span>Password</span>
            </label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <button className="btn" style={{ width: "100%", padding: "0.75rem 1.5rem", fontSize: "0.92rem" }} disabled={loading}>
            {loading ? "Memverifikasi..." : "Sign in ke Console →"}
          </button>

          {error && <p className="error-text" style={{ marginTop: "1rem", textAlign: "center" }}>{error}</p>}
        </form>
      </div>
    </div>
  );
}
