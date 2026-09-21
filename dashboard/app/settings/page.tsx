"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  getMailSettings,
  updateMailSettings,
  clearMailSettings,
  sendTestEmail,
  listMailOutbox,
  clearMailOutbox,
  getToken,
  changeAdminPassword,
  type MailSettingsInfo,
  type OutboxMessage,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { StorageBackendSection } from "@/components/StorageBackendSection";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { LoadError, errorMessage } from "@/components/ui/load-error";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import {
  Mail,
  Save,
  Send,
  Loader2,
  Check,
  AlertTriangle,
  Trash2,
  Inbox,
  Unplug,
  RefreshCw,
  Lock,
  KeyRound,
  Eye,
  EyeOff,
  Activity,
  ChevronRight,
} from "lucide-react";

export default function SettingsPage() {
  const router = useRouter();
  const [info, setInfo] = useState<MailSettingsInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // SMTP form
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [from, setFrom] = useState("");

  // Test send
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);

  // Outbox
  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const [outboxError, setOutboxError] = useState("");
  const [clearingOutbox, setClearingOutbox] = useState(false);
  const [confirmClearOutbox, setConfirmClearOutbox] = useState(false);
  const [confirmClearSmtp, setConfirmClearSmtp] = useState(false);
  const [openMessage, setOpenMessage] = useState<string | null>(null);

  // Admin change-password form
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const [pwNotice, setPwNotice] = useState("");
  const [pwError, setPwError] = useState("");

  function reload() {
    getMailSettings()
      .then((i) => {
        setInfo(i);
        if (i.config) {
          setHost(i.config.host);
          setPort(String(i.config.port));
          setSecure(i.config.secure);
          setUser(i.config.user);
          setFrom(i.config.from);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load settings"))
      .finally(() => setLoaded(true));
    listMailOutbox(20)
      .then((m) => {
        setOutbox(m);
        setOutboxError("");
      })
      .catch((e) => {
        // "Outbox is empty" saat fetch gagal itu menyesatkan: di mode DEV
        // outbox inilah satu-satunya tempat link verifikasi & reset password
        // bisa diambil. Admin akan mengira email tidak pernah terkirim.
        setOutbox([]);
        setOutboxError(errorMessage(e, "Failed to load outbox"));
      });
  }

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await updateMailSettings({
        host,
        port: parseInt(port, 10) || 587,
        secure,
        user,
        pass: pass || undefined, // kosong = keep existing
        from: from || undefined,
      });
      setInfo(res);
      setPass("");
      setNotice("SMTP configuration saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await clearMailSettings();
      setInfo({ config: null, mode: res.mode });
      setHost(""); setUser(""); setPass(""); setFrom(""); setPort("587"); setSecure(false);
      setNotice("SMTP configuration cleared — back to dev outbox mode.");
      setConfirmClearSmtp(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clear");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestSend() {
    setTesting(true);
    setError("");
    setNotice("");
    try {
      const res = await sendTestEmail(testTo);
      setNotice(
        res.mode === 'outbox'
          ? 'SMTP is not configured — the test email went to the dev outbox below.'
          : `Test email sent to ${testTo} (message id: ${res.messageId}).`
      );
      const msgs = await listMailOutbox(20);
      setOutbox(msgs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setTesting(false);
    }
  }

  if (!loaded) return null;

  const smtpActive = info?.mode === 'smtp';

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError("");
    setPwNotice("");
    if (newPw !== newPw2) {
      setPwError("New passwords do not match.");
      return;
    }
    setChangingPw(true);
    try {
      await changeAdminPassword(curPw, newPw);
      setPwNotice("Password changed. All other sessions have been signed out.");
      setCurPw(""); setNewPw(""); setNewPw2("");
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setChangingPw(false);
    }
  }

  return (
    <>
      <Navbar />

      <div className="max-w-[900px] mx-auto px-6 py-6">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Mail className="w-6 h-6" />
            <span>Platform Settings</span>
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            SMTP mail service for email verification and password resets across all projects.
          </p>
        </div>

        {notice && (
          <Card className="p-3 mb-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-sm flex items-center gap-2">
            <Check className="w-4 h-4 shrink-0" />
            <span>{notice}</span>
          </Card>
        )}
        {error && (
          <Card className="p-3 mb-4 border-destructive/50 bg-destructive/10 text-destructive text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </Card>
        )}

        {/* ─── STORAGE BACKEND (M30: local disk / S3) ─── */}
        <StorageBackendSection onSuccess={setNotice} onError={setError} />

        {/* ─── MONITORING shortcut (M33: platform alerts) ─── */}
        <Link href="/monitoring" className="block group">
          <Card className="p-4 mb-6 hover:border-foreground/20 transition-colors flex items-center gap-3">
            <div className="w-9 h-9 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0">
              <Activity className="w-4.5 h-4.5 text-muted-foreground group-hover:text-foreground transition-colors" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Platform Monitoring &amp; Alerts</p>
              <p className="text-xs text-muted-foreground">
                Threshold rules (request rate, bandwidth, errors, disk) + alert history with webhook notifications.
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform shrink-0" />
          </Card>
        </Link>

        {/* ─── ADMIN ACCOUNT (change password) ─── */}
        <Card className="p-5 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-md bg-secondary border border-border flex items-center justify-center">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold">Admin Account</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Change the master administrator password. All other sessions will be signed out.
              </p>
            </div>
          </div>

          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cur-pw" className="text-xs">Current Password</Label>
              <div className="relative">
                <Input
                  id="cur-pw"
                  type={showCur ? "text" : "password"}
                  value={curPw}
                  onChange={(e) => setCurPw(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="pr-11 font-mono text-sm"
                />
                <button type="button" onClick={() => setShowCur(!showCur)} tabIndex={-1}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                  title={showCur ? "Hide" : "Show"}>
                  {showCur ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="new-pw" className="text-xs">New Password (min. 8 characters)</Label>
                <div className="relative">
                  <Input
                    id="new-pw"
                    type={showNew ? "text" : "password"}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    className="pr-11 font-mono text-sm"
                  />
                  <button type="button" onClick={() => setShowNew(!showNew)} tabIndex={-1}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                    title={showNew ? "Hide" : "Show"}>
                    {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-pw2" className="text-xs">Confirm New Password</Label>
                <Input
                  id="new-pw2"
                  type={showNew ? "text" : "password"}
                  value={newPw2}
                  onChange={(e) => setNewPw2(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className="font-mono text-sm"
                />
              </div>
            </div>

            {pwError && (
              <div className="p-3 rounded-md bg-destructive/10 border border-destructive/40 text-destructive text-xs flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{pwError}</span>
              </div>
            )}
            {pwNotice && (
              <div className="p-3 rounded-md bg-emerald-500/10 border border-emerald-500/40 text-emerald-400 text-xs flex items-center gap-2">
                <Check className="w-3.5 h-3.5 shrink-0" />
                <span>{pwNotice}</span>
              </div>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={changingPw || !curPw || newPw.length < 8 || newPw !== newPw2} className="gap-1.5">
                {changingPw ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>Changing…</span></>
                ) : (
                  <><Lock className="w-3.5 h-3.5" /><span>Change Password</span></>
                )}
              </Button>
            </div>
          </form>
        </Card>

        {/* ─── SMTP CONFIG ─── */}
        <Card className="p-5 mb-6">
          <div className="flex justify-between items-start mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-md bg-secondary border border-border flex items-center justify-center">
                <Mail className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold">SMTP Transport</h3>
                  {smtpActive ? (
                    <Badge variant="green" className="gap-1 text-[11px]">
                      <Check className="w-3 h-3" />
                      <span>Active</span>
                    </Badge>
                  ) : (
                    <Badge variant="amber" className="gap-1 text-[11px]">
                      <Unplug className="w-3 h-3" />
                      <span>Dev Outbox Mode</span>
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {smtpActive
                    ? `Sending via ${info?.config?.host}:${info?.config?.port}`
                    : 'No SMTP configured — emails are stored in the dev outbox below (verification links remain accessible).'}
                </p>
              </div>
            </div>
            {smtpActive && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
                onClick={() => setConfirmClearSmtp(true)}
                disabled={saving}
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear</span>
              </Button>
            )}
          </div>

          {/* Menghapus config SMTP mengembalikan SEMUA email ke dev outbox di
              seluruh project — dampaknya platform-wide, bukan satu halaman. */}
          {confirmClearSmtp && (
            <div className="mb-4">
              <ConfirmDelete
                title="Clear SMTP configuration?"
                description="Every project will fall back to dev outbox mode — outgoing emails (verification, password reset) will no longer be delivered externally until SMTP is configured again."
                confirmLabel="Clear SMTP"
                busy={saving}
                onConfirm={handleClear}
                onCancel={() => setConfirmClearSmtp(false)}
              />
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-host" className="text-xs">SMTP Host</Label>
              <Input id="smtp-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="e.g. smtp.gmail.com" className="font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-port" className="text-xs">Port</Label>
              <Input id="smtp-port" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="587" className="font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-user" className="text-xs">Username</Label>
              <Input id="smtp-user" value={user} onChange={(e) => setUser(e.target.value)} placeholder="e.g. you@gmail.com" className="font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-pass" className="text-xs flex items-center gap-1">
                <Lock className="w-3 h-3" />
                <span>Password</span>
              </Label>
              <Input id="smtp-pass" type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={info?.config?.hasPassword ? "Keep existing (blank = unchanged)" : "SMTP password / app password"} className="font-mono text-sm" />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="mail-from" className="text-xs">From Address</Label>
              <Input id="mail-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder='e.g. BaseForge <no-reply@mydomain.com>' className="font-mono text-sm" />
            </div>
            <div className="md:col-span-2 flex items-center justify-between flex-wrap gap-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} className="accent-foreground" />
                <span>Use TLS directly (port 465) instead of STARTTLS (587)</span>
              </label>
              <Button onClick={handleSave} disabled={saving || !host.trim()} className="gap-1.5">
                {saving ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>Saving…</span></>
                ) : (
                  <><Save className="w-3.5 h-3.5" /><span>Save Configuration</span></>
                )}
              </Button>
            </div>
          </div>

          {/* Test send */}
          <div className="mt-5 pt-4 border-t border-border flex items-end gap-3 flex-wrap">
            <div className="space-y-1.5 flex-1 min-w-[220px]">
              <Label htmlFor="test-to" className="text-xs">Send a test email to</Label>
              <Input id="test-to" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" className="text-sm" />
            </div>
            <Button variant="secondary" onClick={handleTestSend} disabled={testing || !testTo.trim()} className="gap-1.5">
              {testing ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>Sending…</span></>
              ) : (
                <><Send className="w-3.5 h-3.5" /><span>Send Test</span></>
              )}
            </Button>
          </div>
        </Card>

        {/* ─── DEV OUTBOX ─── */}
        <Card className="p-5">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-md bg-secondary border border-border flex items-center justify-center">
                <Inbox className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold">Dev Outbox</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {/* Dulu `Math.max(outbox.length, 20)` — selalu berbunyi "Last 20"
                      walau hanya ada 3 email. Sebut jumlah yang benar-benar tampil. */}
                  Last {outbox.length} of up to 20 emails while SMTP is not active — verification &amp; reset links live here.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" onClick={reload} title="Refresh outbox" className="text-muted-foreground">
                <RefreshCw className="w-4 h-4" />
              </Button>
              {outbox.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  disabled={clearingOutbox}
                  onClick={() => setConfirmClearOutbox(true)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear</span>
                </Button>
              )}
            </div>
          </div>

          {/* Outbox berisi link verifikasi & reset yang MUNGKIN BELUM DIPAKAI.
              Menghapusnya membuat user yang belum mengklik tidak bisa
              menyelesaikan pendaftaran — satu klik ini merusak alur mereka. */}
          {confirmClearOutbox && (
            <ConfirmDelete
              title={`Clear all ${outbox.length} emails from the outbox?`}
              description="Pending verification and password-reset links inside them will stop working for users who haven't clicked yet. This cannot be undone."
              confirmLabel="Clear Outbox"
              busy={clearingOutbox}
              onConfirm={async () => {
                setClearingOutbox(true);
                try {
                  await clearMailOutbox();
                  setOutbox([]);
                  setOutboxError("");
                  setConfirmClearOutbox(false);
                } catch (e) {
                  setOutboxError(errorMessage(e, "Failed to clear outbox"));
                } finally {
                  setClearingOutbox(false);
                }
              }}
              onCancel={() => setConfirmClearOutbox(false)}
            />
          )}

          {outboxError ? (
            <LoadError message={outboxError} onRetry={reload} className="my-2" />
          ) : outbox.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Outbox is empty — register a user or request a password reset to see emails here.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {outbox.map((m) => {
                const linkMatch = m.text.match(/https?:\/\/[^\s]+token=[a-f0-9]+[^\s]*/);
                const isOpen = openMessage === m.id;
                return (
                  <div key={m.id} className="py-3">
                    <button
                      className="w-full text-left flex items-center justify-between gap-3 group"
                      onClick={() => setOpenMessage(isOpen ? null : m.id)}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">{m.subject}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          to: {m.to} · {new Date(m.created).toLocaleString()}
                        </div>
                      </div>
                      <Badge variant="secondary" className="text-[10px] shrink-0 font-mono">
                        {m.subject.includes('Verify') ? 'verify' : m.subject.includes('Reset') ? 'reset' : m.subject.includes('test') ? 'test' : 'mail'}
                      </Badge>
                    </button>
                    {isOpen && (
                      <div className="mt-2 rounded-md bg-secondary border border-border p-3 space-y-2">
                        <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">{m.text}</pre>
                        {linkMatch && (
                          <a
                            href={linkMatch[0]}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-foreground font-medium hover:underline"
                          >
                            <span>Open action link</span>
                            <Send className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
