"use client";

// ============================================================================
// M30: STORAGE BACKEND SECTION — pilih local disk atau S3-compatible
//
// Sebelumnya seluruh fitur M30 (endpoint, bucket, credentials, health check,
// reset) hanya bisa via curl. Storage backend bersifat PLATFORM-WIDE: semua
// project ikut backend yang sama.
//
// Catatan kejujuran: server menyimpan secretAccessKey PLAINTEXT di
// platform.db (lihat TODO "encrypt at-rest" di storageAdapter.ts). UI harus
// menyatakan itu, bukan menyembunyikannya.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  getStorageBackend,
  setStorageBackendS3,
  setStorageBackendLocal,
  testStorageBackend,
  type StorageBackendInfo,
} from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import {
  HardDrive,
  Cloud,
  Loader2,
  Save,
  Plug,
  AlertTriangle,
  Check,
  X,
  Unplug,
  Eye,
  EyeOff,
} from "lucide-react";

interface Props {
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

export function StorageBackendSection({ onSuccess, onError }: Props) {
  const [info, setInfo] = useState<StorageBackendInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // form S3
  const [showForm, setShowForm] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [prefix, setPrefix] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getStorageBackend();
      setInfo(data);
      if (data.backend === "s3" && data.s3) {
        setEndpoint(data.s3.endpoint ?? "");
        setRegion(data.s3.region ?? "us-east-1");
        setBucket(data.s3.bucket ?? "");
        setPrefix(data.s3.prefix ?? "");
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load storage backend");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSaveS3() {
    if (!endpoint.trim() || !bucket.trim() || !accessKeyId.trim() || !secretAccessKey.trim()) {
      onError("Endpoint, bucket, access key ID, and secret access key are all required.");
      return;
    }
    if (!/^https?:\/\//i.test(endpoint.trim())) {
      onError("Endpoint must start with http:// or https://");
      return;
    }
    setSaving(true);
    setTestResult(null);
    try {
      await setStorageBackendS3({
        endpoint: endpoint.trim(),
        region: region.trim() || "us-east-1",
        bucket: bucket.trim(),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        prefix: prefix.trim() || undefined,
      });
      onSuccess("Storage backend switched to S3. Run a connection test to confirm it works.");
      setSecretAccessKey("");
      setAccessKeyId("");
      setShowForm(false);
      load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save S3 config");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testStorageBackend();
      setTestResult({ ok: res.ok, message: res.message });
    } catch (e) {
      // server balas 502 saat health check gagal — tetap tampilkan pesannya
      setTestResult({ ok: false, message: e instanceof Error ? e.message : "Health check failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleReset() {
    setResetting(true);
    try {
      await setStorageBackendLocal();
      onSuccess("Storage backend reset to local disk.");
      setConfirmReset(false);
      setTestResult(null);
      setAccessKeyId("");
      setSecretAccessKey("");
      load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to reset");
    } finally {
      setResetting(false);
    }
  }

  const isS3 = info?.backend === "s3";

  return (
    <Card className="p-5 mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <h3 className="text-base font-semibold flex items-center gap-2">
          {isS3 ? <Cloud className="w-4 h-4 text-muted-foreground" /> : <HardDrive className="w-4 h-4 text-muted-foreground" />}
          <span>Storage Backend</span>
        </h3>
        {!loading && info && (
          <Badge variant={isS3 ? "default" : "secondary"} className="gap-1.5">
            {isS3 ? <Cloud className="w-3 h-3" /> : <HardDrive className="w-3 h-3" />}
            <span>{isS3 ? "S3-compatible" : "Local disk"}</span>
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Where uploaded files live. This is platform-wide — every project uses the same backend.
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading storage backend…</p>
      ) : (
        <>
          {/* Status backend aktif */}
          <div className="bg-muted rounded-lg p-3 mb-4 text-xs space-y-1">
            {isS3 && info?.s3 ? (
              <>
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">Endpoint</span>
                  <span className="font-mono text-foreground break-all">{info.s3.endpoint}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">Bucket</span>
                  <span className="font-mono text-foreground">{info.s3.bucket}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">Region</span>
                  <span className="font-mono text-foreground">{info.s3.region}</span>
                </div>
                {info.s3.prefix && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Prefix</span>
                    <span className="font-mono text-foreground">{info.s3.prefix}</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">Credentials</span>
                  <span className="text-foreground">
                    {info.s3.hasCredentials ? "configured (never shown)" : "missing"}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">
                Files are stored on the server&apos;s local disk under <span className="font-mono text-foreground">data/storage/&lt;projectId&gt;/</span>.
                Fine for a single server; switch to S3 if you need durability or multiple app servers.
              </p>
            )}
          </div>

          {/* Hasil test */}
          {testResult && (
            <div
              className={`rounded-md p-3 mb-4 text-xs flex items-start gap-2 border ${
                testResult.ok
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-destructive/50 bg-destructive/10 text-destructive"
              }`}
            >
              {testResult.ok ? <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <X className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
              <span className="break-all">{testResult.message}</span>
            </div>
          )}

          {/* Form S3 */}
          {showForm && (
            <div className="border border-border rounded-lg p-4 mb-4 space-y-3">
              <div className="flex items-start gap-2 text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md p-2.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  The secret access key is stored <strong>unencrypted</strong> in the platform database
                  (<span className="font-mono">platform.db</span>). Use a scoped key limited to this bucket,
                  and keep the database file protected.
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="s3-endpoint" className="text-xs">Endpoint *</Label>
                  <Input
                    id="s3-endpoint"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    placeholder="https://s3.amazonaws.com  ·  https://<account>.r2.cloudflarestorage.com"
                    className="h-9 font-mono text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="s3-bucket" className="text-xs">Bucket *</Label>
                  <Input
                    id="s3-bucket"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="my-app-files"
                    className="h-9 font-mono text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="s3-region" className="text-xs">Region</Label>
                  <Input
                    id="s3-region"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="us-east-1"
                    className="h-9 font-mono text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="s3-key" className="text-xs">Access Key ID *</Label>
                  <Input
                    id="s3-key"
                    value={accessKeyId}
                    onChange={(e) => setAccessKeyId(e.target.value)}
                    placeholder="AKIA…"
                    className="h-9 font-mono text-sm"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="s3-secret" className="text-xs">Secret Access Key *</Label>
                  <div className="relative">
                    <Input
                      id="s3-secret"
                      type={showSecret ? "text" : "password"}
                      value={secretAccessKey}
                      onChange={(e) => setSecretAccessKey(e.target.value)}
                      className="h-9 font-mono text-sm pr-9"
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret((s) => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      title={showSecret ? "Hide" : "Show"}
                    >
                      {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="s3-prefix" className="text-xs">Key prefix (optional)</Label>
                  <Input
                    id="s3-prefix"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    placeholder="baseforge/"
                    className="h-9 font-mono text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button onClick={handleSaveS3} disabled={saving} className="gap-1.5">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span>{saving ? "Saving…" : "Save & Switch to S3"}</span>
                </Button>
                <Button variant="ghost" onClick={() => setShowForm(false)} disabled={saving}>
                  Cancel
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Existing files already on local disk are <strong>not</strong> migrated automatically — copy them to the bucket yourself before switching in production.
              </p>
            </div>
          )}

          {/* Aksi */}
          {!showForm && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="secondary" onClick={handleTest} disabled={testing} className="gap-1.5">
                {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                <span>{testing ? "Testing…" : "Test Connection"}</span>
              </Button>
              <Button variant="secondary" onClick={() => setShowForm(true)} className="gap-1.5">
                <Cloud className="w-3.5 h-3.5" />
                <span>{isS3 ? "Update S3 Config" : "Configure S3"}</span>
              </Button>
              {isS3 && (
                <Button variant="ghost" onClick={() => setConfirmReset(true)} className="gap-1.5 text-muted-foreground">
                  <Unplug className="w-3.5 h-3.5" />
                  <span>Reset to local disk</span>
                </Button>
              )}
            </div>
          )}

          {confirmReset && (
            <div className="mt-4">
              <ConfirmDelete
                title="Reset storage backend to local disk?"
                description="New uploads will go to the server's local disk. Files already stored in the S3 bucket will no longer be reachable through BaseForge until you switch back."
                confirmLabel="Reset to local disk"
                busy={resetting}
                onConfirm={handleReset}
                onCancel={() => setConfirmReset(false)}
              />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
