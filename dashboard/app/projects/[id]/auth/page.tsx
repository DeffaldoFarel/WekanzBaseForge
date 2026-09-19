"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  listOAuthProviders,
  upsertOAuthProvider,
  deleteOAuthProvider,
  oauthAuthorizeUrl,
  getToken,
  type OAuthProviderInfo,
  listAuthUsers,
  setAuthUserVerified,
  setAuthUserDisabled,
  deleteAuthUser,
  type AuthUser,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { AuthFieldsEditor } from "@/components/AuthFieldsEditor";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Globe,
  GitFork,
  MessageCircle,
  Apple,
  KeyRound,
  Link2,
  Loader2,
  Save,
  Trash2,
  Check,
  AlertTriangle,
  ExternalLink,
  ArrowRight,
  Database,
  Users,
  Search,
} from "lucide-react";

interface ProviderFormState {
  clientId: string;
  clientSecret: string;
  enabled: boolean;
  callbackUrl: string;
  allowedOrigins: string;
}

const EMPTY_FORM: ProviderFormState = {
  clientId: "",
  clientSecret: "",
  enabled: true,
  callbackUrl: "",
  allowedOrigins: "",
};

const PROVIDER_META: Record<
  string,
  { label: string; icon: typeof Globe; docsUrl: string; note?: string }
> = {
  google: {
    label: "Google",
    icon: Globe,
    docsUrl: "https://console.cloud.google.com/apis/credentials",
  },
  github: {
    label: "GitHub",
    icon: GitFork,
    docsUrl: "https://github.com/settings/developers",
  },
  microsoft: {
    label: "Microsoft",
    icon: Globe,
    docsUrl: "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  },
  discord: {
    label: "Discord",
    icon: MessageCircle,
    docsUrl: "https://discord.com/developers/applications",
  },
  gitlab: {
    label: "GitLab",
    icon: GitFork,
    docsUrl: "https://gitlab.com/-/profile/applications",
  },
  facebook: {
    label: "Facebook",
    icon: Globe,
    docsUrl: "https://developers.facebook.com/apps",
  },
  apple: {
    label: "Apple",
    icon: Apple,
    docsUrl: "https://developer.apple.com/account/resources/identifiers/list/serviceId",
    note: "Requires ES256-signed client secret JWT (coming soon)",
  },
};

export default function AuthSettingsPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // M47: Auth Users state
  const [authUsers, setAuthUsers] = useState<AuthUser[]>([]);
  const [authUsersTotal, setAuthUsersTotal] = useState(0);
  const [authUsersLoading, setAuthUsersLoading] = useState(false);
  const [authUsersSearch, setAuthUsersSearch] = useState("");
  const [authUsersError, setAuthUsersError] = useState("");
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // draft form per provider
  const [forms, setForms] = useState<Record<string, ProviderFormState>>({});

  useEffect(() => {
    if (!getToken()) {
      window.location.href = "/login";
      return;
    }
    listOAuthProviders(projectId)
      .then((list) => {
        setProviders(list);
        const drafts: Record<string, ProviderFormState> = {};
        for (const p of list) {
          drafts[p.provider] = {
            clientId: p.clientId,
            clientSecret: "",
            enabled: p.enabled,
            callbackUrl: p.callbackUrl ?? "",
            allowedOrigins: p.allowedOrigins.join(", "),
          };
        }
        setForms(drafts);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load providers"))
      .finally(() => setLoaded(true));
  }, [projectId]);

  // M47: load auth users
  const loadAuthUsers = useCallback(async (search?: string) => {
    setAuthUsersLoading(true);
    setAuthUsersError("");
    try {
      const result = await listAuthUsers(projectId, 1, search);
      setAuthUsers(result.items);
      setAuthUsersTotal(result.totalItems);
    } catch (e) {
      setAuthUsersError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setAuthUsersLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (loaded) loadAuthUsers();
  }, [loaded, loadAuthUsers]);

  // M47: auth user actions
  async function handleVerifyUser(userId: string, verified: boolean) {
    setActionLoading(userId + "-verify");
    try {
      await setAuthUserVerified(projectId, userId, verified);
      await loadAuthUsers(authUsersSearch || undefined);
    } catch (e) {
      setAuthUsersError(e instanceof Error ? e.message : "Failed to update user");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDisableUser(userId: string, disabled: boolean) {
    setActionLoading(userId + "-disable");
    try {
      await setAuthUserDisabled(projectId, userId, disabled);
      await loadAuthUsers(authUsersSearch || undefined);
    } catch (e) {
      setAuthUsersError(e instanceof Error ? e.message : "Failed to update user");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDeleteUser(userId: string) {
    setActionLoading(userId + "-delete");
    try {
      await deleteAuthUser(projectId, userId);
      setConfirmDeleteUser(null);
      await loadAuthUsers(authUsersSearch || undefined);
    } catch (e) {
      setAuthUsersError(e instanceof Error ? e.message : "Failed to delete user");
    } finally {
      setActionLoading(null);
    }
  }

  const registerCallbackUrl = (provider: string): string => {
    return `${window.location.protocol}//${window.location.hostname}:5100/api/p/${projectId}/auth/oauth/${provider}/callback`;
  };

  const updateForm = useCallback((provider: string, patch: Partial<ProviderFormState>) => {
    setForms((prev) => ({
      ...prev,
      [provider]: { ...(prev[provider] ?? EMPTY_FORM), ...patch },
    }));
  }, []);

  async function handleSave(provider: string) {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const form = forms[provider] ?? EMPTY_FORM;
      await upsertOAuthProvider(projectId, provider, {
        clientId: form.clientId,
        clientSecret: form.clientSecret || undefined,
        enabled: form.enabled,
        callbackUrl: form.callbackUrl || undefined,
        allowedOrigins: form.allowedOrigins,
      });
      // reload + kosongkan field secret (aman)
      const list = await listOAuthProviders(projectId);
      setProviders(list);
      updateForm(provider, { clientSecret: "" });
      setNotice(`${PROVIDER_META[provider]?.label ?? provider} configuration saved.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save provider");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(provider: string) {
    setLoading(true);
    setError("");
    try {
      await deleteOAuthProvider(projectId, provider);
      const list = await listOAuthProviders(projectId);
      setProviders(list);
      setForms((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
      setConfirmDelete(null);
      setNotice(`${PROVIDER_META[provider]?.label ?? provider} removed.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete provider");
    } finally {
      setLoading(false);
    }
  }

  const isConfigured = (provider: string) =>
    providers.some((p) => p.provider === provider);

  if (!loaded) return null;

  return (
    <>
      <Navbar projectId={projectId} />

      <div className="max-w-[1180px] mx-auto px-6 py-6 flex gap-6 items-start">
        <ProjectSidebar projectId={projectId} />

        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-center flex-wrap gap-2">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
                <KeyRound className="w-6 h-6" />
                <span>Auth Settings</span>
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Enable social login (OAuth2) for end users of this project.
              </p>
            </div>
          </div>

          {/* Info: user management ada di Database Studio */}
          <Card className="p-4 mt-4 mb-6">
            <div className="flex items-start gap-3">
              <Database className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="text-sm">
                <span className="text-foreground font-medium">User management</span>{" "}
                <span className="text-muted-foreground">
                  follows the unified Auth Collections pattern — manage user records directly in Database Studio.
                </span>
                <Link
                  href={`/projects/${projectId}/database`}
                  className="ml-1 inline-flex items-center gap-1 text-foreground font-medium hover:underline"
                >
                  <span>Open Collections</span>
                  <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            </div>
          </Card>

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

          <div className="grid gap-4">
            {(["google", "github", "microsoft", "discord", "gitlab", "facebook", "apple"] as const).map((provider) => {
              const meta = PROVIDER_META[provider];
              const Icon = meta.icon;
              const configured = isConfigured(provider);
              const form = forms[provider] ?? EMPTY_FORM;
              const isApple = provider === "apple";

              return (
                <Card key={provider} className={`p-5 ${isApple ? "opacity-60" : ""}`}>
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-md bg-secondary border border-border flex items-center justify-center">
                        <Icon className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-semibold">{meta.label} OAuth</h3>
                          {configured ? (
                            form.enabled ? (
                              <Badge variant="green" className="gap-1 text-[11px]">
                                <Check className="w-3 h-3" />
                                <span>Active</span>
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[11px]">Disabled</Badge>
                            )
                          ) : (
                            <Badge variant="outline" className="text-[11px]">Not configured</Badge>
                          )}
                        </div>
                        <a
                          href={meta.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mt-0.5"
                        >
                          <span>Get credentials</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                        {meta.note && (
                          <p className="text-[11px] text-amber-400/80 mt-0.5">{meta.note}</p>
                        )}
                      </div>
                    </div>

                    {configured && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => window.open(oauthAuthorizeUrl(projectId, provider), "_blank")}
                          title="Test the authorization flow in a new tab"
                        >
                          <Users className="w-3.5 h-3.5" />
                          <span>Test Flow</span>
                        </Button>
                        {confirmDelete === provider ? (
                          <div className="flex items-center gap-1.5">
                            <Button variant="destructive" size="sm" onClick={() => handleDelete(provider)} disabled={loading}>
                              Confirm
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(null)}>
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setConfirmDelete(provider)}
                            title={`Remove ${meta.label} provider`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="grid gap-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label htmlFor={`${provider}-client-id`} className="text-xs">
                          Client ID
                        </Label>
                        <Input
                          id={`${provider}-client-id`}
                          value={form.clientId}
                          onChange={(e) => updateForm(provider, { clientId: e.target.value })}
                          placeholder={configured ? "Current client ID" : "e.g. 123456789-abc.apps.googleusercontent.com"}
                          className="font-mono text-sm"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${provider}-client-secret`} className="text-xs">
                          Client Secret
                        </Label>
                        <Input
                          id={`${provider}-client-secret`}
                          type="password"
                          value={form.clientSecret}
                          onChange={(e) => updateForm(provider, { clientSecret: e.target.value })}
                          placeholder={configured ? "Keep existing (blank = unchanged)" : "Secret from provider console"}
                          className="font-mono text-sm"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Redirect URI (register this in {meta.label})</Label>
                        <div className="h-9 px-3 bg-secondary border border-border rounded-md flex items-center text-xs font-mono text-muted-foreground truncate">
                          {form.callbackUrl || registerCallbackUrl(provider)}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${provider}-origins`} className="text-xs">
                          Allowed redirect origins (optional, comma separated)
                        </Label>
                        <Input
                          id={`${provider}-origins`}
                          value={form.allowedOrigins}
                          onChange={(e) => updateForm(provider, { allowedOrigins: e.target.value })}
                          placeholder="e.g. https://app.mydomain.com"
                          className="text-xs font-mono"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox
                          checked={form.enabled}
                          onCheckedChange={(c: boolean | 'indeterminate') => updateForm(provider, { enabled: !!c })}
                        />
                        <span className="text-muted-foreground">Enable {meta.label} sign-in</span>
                      </label>

                      <Button
                        onClick={() => handleSave(provider)}
                        disabled={loading || !form.clientId.trim()}
                        className="gap-1.5"
                      >
                        {loading ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Saving…</span>
                          </>
                        ) : (
                          <>
                            <Save className="w-3.5 h-3.5" />
                            <span>{configured ? "Update" : "Save"} Configuration</span>
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          {/* Ops-16: custom profile field — didefinisikan admin, tervalidasi server */}
          <div className="mt-8">
            <AuthFieldsEditor projectId={projectId} />
          </div>

          {/* M47: Auth Users */}

          <div className="mt-8 mb-6">
            <div className="flex justify-between items-center flex-wrap gap-2 mb-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
                  <Users className="w-6 h-6" />
                  <span>Auth Users</span>
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  End users registered in this project ({authUsersTotal} total).
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Search by email…"
                  value={authUsersSearch}
                  onChange={(e) => setAuthUsersSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') loadAuthUsers(authUsersSearch || undefined); }}
                  className="w-56 text-sm"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => loadAuthUsers(authUsersSearch || undefined)}
                  disabled={authUsersLoading}
                >
                  {authUsersLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                </Button>
              </div>
            </div>

            {authUsersError && (
              <Card className="p-3 mb-4 border-destructive/50 bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{authUsersError}</span>
              </Card>
            )}

            {authUsers.length === 0 && !authUsersLoading ? (
              <Card className="p-8 text-center text-sm text-muted-foreground">
                No auth users yet. Users will appear here after they register via your app.
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-secondary/50">
                      <th className="text-left p-3 font-medium text-muted-foreground">Email</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">Name</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">Status</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">MFA</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">Created</th>
                      <th className="text-right p-3 font-medium text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {authUsers.map((u) => (
                      <tr key={u.id} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                        <td className="p-3 font-mono text-xs">{u.email}</td>
                        <td className="p-3">{u.name || "—"}</td>
                        <td className="p-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {u.verified ? (
                              <Badge variant="green" className="text-[10px] gap-0.5"><Check className="w-2.5 h-2.5" />Verified</Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px]">Unverified</Badge>
                            )}
                            {u.disabled && (
                              <Badge variant="destructive" className="text-[10px]">Disabled</Badge>
                            )}
                          </div>
                        </td>
                        <td className="p-3">
                          {u.mfaEnabled ? (
                            <Badge variant="green" className="text-[10px]">On</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Off</span>
                          )}
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">{new Date(u.created).toLocaleDateString()}</td>
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {!u.verified && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={actionLoading === u.id + "-verify"}
                                onClick={() => handleVerifyUser(u.id, true)}
                                title="Mark as verified"
                              >
                                {actionLoading === u.id + "-verify" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              disabled={actionLoading === u.id + "-disable"}
                              onClick={() => handleDisableUser(u.id, !u.disabled)}
                              title={u.disabled ? "Enable user" : "Disable user"}
                            >
                              {actionLoading === u.id + "-disable" ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : u.disabled ? (
                                <Check className="w-3 h-3" />
                              ) : (
                                <AlertTriangle className="w-3 h-3" />
                              )}
                            </Button>
                            {confirmDeleteUser === u.id ? (
                              <div className="flex items-center gap-1">
                                <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" disabled={actionLoading === u.id + "-delete"} onClick={() => handleDeleteUser(u.id)}>
                                  {actionLoading === u.id + "-delete" ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm"}
                                </Button>
                                <Button variant="secondary" size="sm" className="h-7 px-2 text-xs" onClick={() => setConfirmDeleteUser(null)}>
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                                onClick={() => setConfirmDeleteUser(u.id)}
                                title="Delete user"
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </div>

          {/* Integrasi untuk developer end-user app */}
          <Card className="p-5 mt-6">
            <div className="flex items-center gap-2 mb-3">
              <Link2 className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Integrate from your app</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
              Send users to the authorize URL — after consent, BaseForge redirects them back with tokens in the URL fragment (<code className="bg-secondary px-1.5 py-0.5 rounded font-mono">#access_token=…&refresh_token=…</code>).
            </p>
            <div className="bg-secondary border border-border rounded-md p-3 font-mono text-xs text-foreground overflow-x-auto whitespace-nowrap">
              GET {typeof window !== "undefined" ? window.location.protocol : "http:"}//api-host:5100/api/p/{projectId}/auth/oauth/{"{google|github}"}/authorize?redirect_to=https://your-app.com/callback
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
