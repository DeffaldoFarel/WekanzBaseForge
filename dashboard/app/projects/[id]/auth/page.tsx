"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import {
  listOAuthProviders,
  upsertOAuthProvider,
  deleteOAuthProvider,
  getToken,
  PUBLIC_API_URL,
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import { LoadError, errorMessage } from "@/components/ui/load-error";
import { useToasts, ToastHost } from "@/components/ui/toast";
import {
  Globe,
  GitFork,
  MessageCircle,
  Apple,
  KeyRound,
  Loader2,
  Save,
  Trash2,
  Check,
  AlertTriangle,
  ExternalLink,
  Users,
  Search,
  SlidersHorizontal,
  Code,
  Settings,
  Copy,
  FolderKanban,
  CheckCircle2,
  ShieldCheck,
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
    note: "Server support in progress (requires ES256-signed client secret JWT)",
  },
};

const ALL_PROVIDERS = [
  "google",
  "github",
  "microsoft",
  "discord",
  "gitlab",
  "facebook",
  "apple",
] as const;

export default function AuthSettingsPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [providersError, setProvidersError] = useState("");

  // Modal konfigurasi provider individual
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState<string | null>(null);
  const [copiedUri, setCopiedUri] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // M47: Auth Users state
  const [authUsers, setAuthUsers] = useState<AuthUser[]>([]);
  const [authUsersTotal, setAuthUsersTotal] = useState(0);
  const [authUsersTotalPages, setAuthUsersTotalPages] = useState(1);
  const [authUsersPage, setAuthUsersPage] = useState(1);
  const [authUsersLoading, setAuthUsersLoading] = useState(false);
  const [authUsersSearch, setAuthUsersSearch] = useState("");
  const [authUsersError, setAuthUsersError] = useState("");
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Draft form per provider
  const [forms, setForms] = useState<Record<string, ProviderFormState>>({});

  const { toasts, success: toastSuccess, error: toastError, dismiss } = useToasts();

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const loadProviders = useCallback(async () => {
    setProvidersError("");
    try {
      const list = await listOAuthProviders(projectId);
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
    } catch (e) {
      setProvidersError(errorMessage(e, "Failed to load OAuth providers"));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    if (!getToken()) {
      window.location.href = "/login";
      return;
    }
    void loadProviders();
  }, [loadProviders]);

  // M47: load auth users
  const loadAuthUsers = useCallback(
    async (search?: string, page: number = 1) => {
      setAuthUsersLoading(true);
      setAuthUsersError("");
      try {
        const result = await listAuthUsers(projectId, page, search);
        setAuthUsers(result.items);
        setAuthUsersTotal(result.totalItems);
        setAuthUsersTotalPages(result.totalPages ?? 1);
        setAuthUsersPage(result.page ?? page);
      } catch (e) {
        setAuthUsersError(errorMessage(e, "Failed to load auth users"));
      } finally {
        setAuthUsersLoading(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    if (loaded) void loadAuthUsers();
  }, [loaded, loadAuthUsers]);

  // M47: auth user actions (optimistik)
  async function handleVerifyUser(userId: string, verified: boolean) {
    setActionLoading(userId + "-verify");
    try {
      await setAuthUserVerified(projectId, userId, verified);
      setAuthUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, verified } : u)));
      toastSuccess(verified ? "User marked as verified." : "User marked as unverified.");
    } catch (e) {
      toastError(errorMessage(e, "Failed to update user"));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDisableUser(userId: string, disabled: boolean) {
    setActionLoading(userId + "-disable");
    try {
      await setAuthUserDisabled(projectId, userId, disabled);
      setAuthUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, disabled } : u)));
      toastSuccess(disabled ? "User disabled." : "User enabled.");
    } catch (e) {
      toastError(errorMessage(e, "Failed to update user"));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDeleteUser(userId: string) {
    setActionLoading(userId + "-delete");
    try {
      await deleteAuthUser(projectId, userId);
      setConfirmDeleteUser(null);
      toastSuccess("User deleted.");
      await loadAuthUsers(authUsersSearch || undefined, authUsersPage);
    } catch (e) {
      toastError(errorMessage(e, "Failed to delete user"));
    } finally {
      setActionLoading(null);
    }
  }

  const registerCallbackUrl = (provider: string): string => {
    return `${PUBLIC_API_URL}/api/p/${projectId}/auth/oauth/${provider}/callback`;
  };

  const updateForm = useCallback((provider: string, patch: Partial<ProviderFormState>) => {
    setForms((prev) => ({
      ...prev,
      [provider]: { ...(prev[provider] ?? EMPTY_FORM), ...patch },
    }));
  }, []);

  async function handleSaveProvider(provider: string) {
    setSavingProvider(true);
    try {
      const form = forms[provider] ?? EMPTY_FORM;
      await upsertOAuthProvider(projectId, provider, {
        clientId: form.clientId,
        clientSecret: form.clientSecret || undefined,
        enabled: form.enabled,
        callbackUrl: form.callbackUrl || undefined,
        allowedOrigins: form.allowedOrigins,
      });
      await loadProviders();
      updateForm(provider, { clientSecret: "" });
      setSelectedProvider(null);
      toastSuccess(`${PROVIDER_META[provider]?.label ?? provider} configuration saved.`);
    } catch (e) {
      toastError(errorMessage(e, "Failed to save provider"));
    } finally {
      setSavingProvider(false);
    }
  }

  async function handleDeleteProvider(provider: string) {
    setSavingProvider(true);
    try {
      await deleteOAuthProvider(projectId, provider);
      await loadProviders();
      setForms((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
      setConfirmDeleteProvider(null);
      setSelectedProvider(null);
      toastSuccess(`${PROVIDER_META[provider]?.label ?? provider} configuration removed.`);
    } catch (e) {
      toastError(errorMessage(e, "Failed to delete provider"));
    } finally {
      setSavingProvider(false);
    }
  }

  function handleCopyUri(url: string) {
    navigator.clipboard.writeText(url);
    setCopiedUri(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedUri(false), 1500);
  }

  const isConfigured = (provider: string) =>
    providers.some((p) => p.provider === provider);

  if (!loaded) return null;

  const activeProviderMeta = selectedProvider ? PROVIDER_META[selectedProvider] : null;
  const activeForm = selectedProvider ? forms[selectedProvider] ?? EMPTY_FORM : EMPTY_FORM;
  const activeConfigured = selectedProvider ? isConfigured(selectedProvider) : false;

  return (
    <>
      <Navbar projectId={projectId} />

      <div className="max-w-[1180px] mx-auto px-6 py-6 flex gap-6 items-start">
        <ProjectSidebar projectId={projectId} />

        <div className="flex-1 min-w-0">
          {/* Header Section */}
          <div className="flex justify-between items-center flex-wrap gap-2 mb-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
                <KeyRound className="w-6 h-6" />
                <span>Authentication &amp; Users</span>
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Manage registered end users, social OAuth providers, and custom profile fields.
              </p>
            </div>
          </div>

          {/* Navigation Tabs (Best Practice Architecture) */}
          <Tabs defaultValue="users" className="w-full">
            <TabsList className="mb-6">
              <TabsTrigger value="users" className="gap-2">
                <Users className="w-3.5 h-3.5" />
                <span>Users</span>
                {authUsersTotal > 0 && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px] h-4 font-mono">
                    {authUsersTotal}
                  </Badge>
                )}
              </TabsTrigger>

              <TabsTrigger value="providers" className="gap-2">
                <Globe className="w-3.5 h-3.5" />
                <span>OAuth Providers</span>
                {providers.filter((p) => p.enabled).length > 0 && (
                  <Badge variant="green" className="px-1.5 py-0 text-[10px] h-4">
                    {providers.filter((p) => p.enabled).length} active
                  </Badge>
                )}
              </TabsTrigger>

              <TabsTrigger value="fields" className="gap-2">
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>Profile Fields</span>
              </TabsTrigger>

              <TabsTrigger value="integration" className="gap-2">
                <Code className="w-3.5 h-3.5" />
                <span>API &amp; Integration</span>
              </TabsTrigger>
            </TabsList>

            {/* ════════════════════════════════════════════════════════════════ */}
            {/* TAB 1: USERS (Fokus Utama Admin) */}
            {/* ════════════════════════════════════════════════════════════════ */}
            <TabsContent value="users">
              <div className="space-y-4">
                {/* Search & Action Bar */}
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">Registered Users</h2>
                    <p className="text-xs text-muted-foreground">
                      End-user accounts registered through your app ({authUsersTotal} total).
                    </p>
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void loadAuthUsers(authUsersSearch || undefined, 1);
                    }}
                    className="flex items-center gap-2 w-full sm:w-auto"
                  >
                    <div className="relative flex-1 sm:w-64">
                      <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                      <Input
                        placeholder="Search by email…"
                        value={authUsersSearch}
                        onChange={(e) => setAuthUsersSearch(e.target.value)}
                        className="pl-9 h-9 text-xs"
                      />
                      {authUsersSearch && (
                        <button
                          type="button"
                          onClick={() => {
                            setAuthUsersSearch("");
                            void loadAuthUsers(undefined, 1);
                          }}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                        >
                          &times;
                        </button>
                      )}
                    </div>
                    <Button
                      type="submit"
                      variant="secondary"
                      size="sm"
                      className="h-9 px-3 text-xs shrink-0"
                      disabled={authUsersLoading}
                    >
                      {authUsersLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Search"}
                    </Button>
                  </form>
                </div>

                {/* State: Error */}
                {authUsersError ? (
                  <LoadError
                    message={authUsersError}
                    onRetry={() => void loadAuthUsers(authUsersSearch || undefined, authUsersPage)}
                    retrying={authUsersLoading}
                  />
                ) : authUsers.length === 0 ? (
                  /* State: Kosong */
                  authUsersSearch.trim() ? (
                    <Card className="p-12 text-center border-dashed">
                      <div className="w-12 h-12 rounded-full bg-secondary border border-border flex items-center justify-center mx-auto mb-3 text-muted-foreground">
                        <Search className="w-5 h-5" />
                      </div>
                      <h3 className="text-sm font-semibold text-foreground mb-1">No matching users</h3>
                      <p className="text-xs text-muted-foreground max-w-sm mx-auto mb-4">
                        No user account matches <code className="font-mono text-foreground font-medium">&quot;{authUsersSearch}&quot;</code>.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-3 text-xs"
                        onClick={() => {
                          setAuthUsersSearch("");
                          void loadAuthUsers(undefined, 1);
                        }}
                      >
                        Clear search
                      </Button>
                    </Card>
                  ) : (
                    <Card className="p-12 text-center border-dashed">
                      <div className="w-12 h-12 rounded-xl bg-secondary border border-border flex items-center justify-center mx-auto mb-3 text-muted-foreground">
                        <Users className="w-6 h-6" />
                      </div>
                      <h3 className="text-base font-semibold text-foreground mb-1">No users yet</h3>
                      <p className="text-sm text-muted-foreground max-w-md mx-auto">
                        Your application doesn&apos;t have any registered users yet. Users will appear here after they sign up via your API.
                      </p>
                    </Card>
                  )
                ) : (
                  /* State: Tabel User */
                  <Card className="overflow-hidden border-border">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left">
                        <thead>
                          <tr className="border-b border-border bg-secondary/50 text-muted-foreground font-medium uppercase tracking-wider">
                            <th className="p-3 pl-4">Email</th>
                            <th className="p-3">Name</th>
                            <th className="p-3">Status</th>
                            <th className="p-3">MFA</th>
                            <th className="p-3">Joined Date</th>
                            <th className="p-3 pr-4 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {authUsers.map((u) => (
                            <tr key={u.id} className="hover:bg-secondary/30 transition-colors">
                              <td className="p-3 pl-4 font-mono text-xs text-foreground font-medium">
                                {u.email}
                              </td>
                              <td className="p-3 text-muted-foreground">{u.name || "—"}</td>
                              <td className="p-3">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {u.verified ? (
                                    <Badge variant="green" className="text-[10px] gap-0.5">
                                      <Check className="w-2.5 h-2.5" />
                                      Verified
                                    </Badge>
                                  ) : (
                                    <Badge variant="secondary" className="text-[10px]">
                                      Unverified
                                    </Badge>
                                  )}
                                  {u.disabled && (
                                    <Badge variant="destructive" className="text-[10px]">
                                      Disabled
                                    </Badge>
                                  )}
                                </div>
                              </td>
                              <td className="p-3">
                                {u.mfaEnabled ? (
                                  <Badge variant="green" className="text-[10px]">
                                    On
                                  </Badge>
                                ) : (
                                  <span className="text-muted-foreground text-xs">Off</span>
                                )}
                              </td>
                              <td className="p-3 text-muted-foreground">
                                {new Date(u.created).toLocaleDateString("en-US", {
                                  day: "numeric",
                                  month: "short",
                                  year: "numeric",
                                })}
                              </td>
                              <td className="p-3 pr-4 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  {!u.verified && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 px-2 text-xs gap-1"
                                      disabled={actionLoading === u.id + "-verify"}
                                      onClick={() => void handleVerifyUser(u.id, true)}
                                      title="Mark user as verified"
                                    >
                                      {actionLoading === u.id + "-verify" ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <>
                                          <Check className="w-3 h-3 text-emerald-400" />
                                          <span>Verify</span>
                                        </>
                                      )}
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    disabled={actionLoading === u.id + "-disable"}
                                    onClick={() => void handleDisableUser(u.id, !u.disabled)}
                                    title={u.disabled ? "Enable account" : "Disable account"}
                                  >
                                    {actionLoading === u.id + "-disable" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : u.disabled ? (
                                      <span className="text-emerald-400">Enable</span>
                                    ) : (
                                      <span className="text-muted-foreground hover:text-foreground">Disable</span>
                                    )}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                    onClick={() => setConfirmDeleteUser(u.id)}
                                    title="Delete user"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination */}
                    {authUsersTotalPages > 1 && (
                      <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-xs"
                          disabled={authUsersPage <= 1 || authUsersLoading}
                          onClick={() => void loadAuthUsers(authUsersSearch || undefined, authUsersPage - 1)}
                        >
                          Previous
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          Page {authUsersPage} of {authUsersTotalPages} ({authUsersTotal} users)
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-xs"
                          disabled={authUsersPage >= authUsersTotalPages || authUsersLoading}
                          onClick={() => void loadAuthUsers(authUsersSearch || undefined, authUsersPage + 1)}
                        >
                          Next
                        </Button>
                      </div>
                    )}
                  </Card>
                )}

                {/* Konfirmasi Hapus User */}
                {confirmDeleteUser && (
                  <ConfirmDelete
                    title={`Delete user account?`}
                    description="The user will be immediately logged out and will no longer be able to sign in. Their session tokens will be permanently revoked."
                    confirmLabel="Delete User"
                    busy={actionLoading === confirmDeleteUser + "-delete"}
                    onConfirm={() => void handleDeleteUser(confirmDeleteUser)}
                    onCancel={() => setConfirmDeleteUser(null)}
                  />
                )}
              </div>
            </TabsContent>

            {/* ════════════════════════════════════════════════════════════════ */}
            {/* TAB 2: OAUTH PROVIDERS (Grid Kompak + Modal Konfigurasi) */}
            {/* ════════════════════════════════════════════════════════════════ */}
            <TabsContent value="providers">
              <div className="space-y-4">
                <div className="flex justify-between items-center flex-wrap gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">OAuth2 Social Identity Providers</h2>
                    <p className="text-xs text-muted-foreground">
                      Enable third-party authentication so end users can sign in with their existing accounts.
                    </p>
                  </div>
                </div>

                {providersError && (
                  <LoadError message={providersError} onRetry={() => void loadProviders()} />
                )}

                {/* Grid Provider Ringkas */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                  {ALL_PROVIDERS.map((provider) => {
                    const meta = PROVIDER_META[provider];
                    const Icon = meta.icon;
                    const configured = isConfigured(provider);
                    const form = forms[provider] ?? EMPTY_FORM;
                    const isApple = provider === "apple";

                    return (
                      <Card
                        key={provider}
                        className={`p-4 flex flex-col justify-between hover:border-foreground/20 transition-colors ${
                          isApple ? "opacity-60" : ""
                        }`}
                      >
                        <div>
                          {/* Top Row: Icon + Title + Status Badge */}
                          <div className="flex items-center justify-between gap-2 mb-3">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-md bg-secondary border border-border flex items-center justify-center text-foreground">
                                <Icon className="w-4 h-4" />
                              </div>
                              <div>
                                <span className="font-semibold text-sm text-foreground block">
                                  {meta.label}
                                </span>
                              </div>
                            </div>
                            <div>
                              {isApple ? (
                                <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                                  Coming soon
                                </Badge>
                              ) : configured && form.enabled ? (
                                <Badge variant="green" className="text-[10px] py-0 px-1.5 gap-1">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                  Active
                                </Badge>
                              ) : configured && !form.enabled ? (
                                <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                                  Disabled
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="text-[10px] py-0 px-1.5 text-muted-foreground">
                                  Not configured
                                </Badge>
                              )}
                            </div>
                          </div>

                          {/* Subtitle Info */}
                          <p className="text-xs text-muted-foreground mb-4 line-clamp-2">
                            {isApple
                              ? meta.note
                              : configured
                              ? `Configured with Client ID (${form.clientId.slice(0, 16)}…)`
                              : `Authenticate users with their ${meta.label} account.`}
                          </p>
                        </div>

                        {/* Action Button */}
                        <div className="pt-2 border-t border-border flex items-center justify-between gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="w-full text-xs gap-1.5 h-8"
                            onClick={() => setSelectedProvider(provider)}
                            disabled={isApple}
                          >
                            <Settings className="w-3.5 h-3.5" />
                            <span>{configured ? "Configure" : "Set up"}</span>
                          </Button>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            </TabsContent>

            {/* ════════════════════════════════════════════════════════════════ */}
            {/* TAB 3: CUSTOM PROFILE FIELDS */}
            {/* ════════════════════════════════════════════════════════════════ */}
            <TabsContent value="fields">
              <AuthFieldsEditor projectId={projectId} />
            </TabsContent>

            {/* ════════════════════════════════════════════════════════════════ */}
            {/* TAB 4: API & INTEGRATION */}
            {/* ════════════════════════════════════════════════════════════════ */}
            <TabsContent value="integration">
              <div className="space-y-4">
                <Card className="p-5">
                  <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
                    <Globe className="w-4 h-4 text-brand" />
                    <span>OAuth2 Authorization Flow</span>
                  </h3>
                  <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                    Direct users to this URL from your web or mobile client to start the OAuth2 flow. After consent, BaseForge redirects back to your application with JWT tokens in the URL fragment (<code className="bg-secondary px-1 rounded font-mono">#access_token=…&amp;refresh_token=…</code>).
                  </p>
                  <div className="bg-secondary border border-border rounded-md p-3 font-mono text-xs text-foreground overflow-x-auto select-all">
                    GET {PUBLIC_API_URL}/api/p/{projectId}/auth/oauth/:provider/authorize?redirect_to=https://your-app.com/callback
                  </div>
                </Card>

                <Card className="p-5">
                  <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-brand" />
                    <span>Email &amp; Password REST Endpoints</span>
                  </h3>
                  <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                    Standard JSON authentication endpoints for end-user accounts in this project.
                  </p>
                  <div className="space-y-2 font-mono text-xs">
                    <div className="bg-secondary p-2 rounded border border-border flex items-center justify-between">
                      <span><strong className="text-emerald-400">POST</strong> /api/p/{projectId}/auth/register</span>
                      <span className="text-muted-foreground text-[11px] font-sans">Create user account</span>
                    </div>
                    <div className="bg-secondary p-2 rounded border border-border flex items-center justify-between">
                      <span><strong className="text-emerald-400">POST</strong> /api/p/{projectId}/auth/login</span>
                      <span className="text-muted-foreground text-[11px] font-sans">Obtain access &amp; refresh tokens</span>
                    </div>
                    <div className="bg-secondary p-2 rounded border border-border flex items-center justify-between">
                      <span><strong className="text-emerald-400">POST</strong> /api/p/{projectId}/auth/refresh</span>
                      <span className="text-muted-foreground text-[11px] font-sans">Rotate refresh token</span>
                    </div>
                    <div className="bg-secondary p-2 rounded border border-border flex items-center justify-between">
                      <span><strong className="text-sky-400">GET</strong> /api/p/{projectId}/auth/me</span>
                      <span className="text-muted-foreground text-[11px] font-sans">Get authenticated profile</span>
                    </div>
                  </div>
                </Card>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* ─── MODAL KONFIGURASI OAUTH PROVIDER ─── */}
      {selectedProvider && activeProviderMeta && (
        <Dialog
          open={!!selectedProvider}
          onOpenChange={(open: boolean) => {
            if (!open) {
              setSelectedProvider(null);
              setConfirmDeleteProvider(null);
            }
          }}
        >
          <DialogContent className="max-w-xl w-full p-6 sm:p-7 overflow-hidden">
            <DialogHeader className="pr-8 space-y-1.5 text-left">
              <DialogTitle className="flex items-center gap-2.5 text-base font-semibold text-foreground">
                <div className="w-8 h-8 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0">
                  <activeProviderMeta.icon className="w-4 h-4 text-foreground" />
                </div>
                <span>{activeProviderMeta.label} Configuration</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap pt-0.5">
                <span>Configure OAuth2 credentials from the</span>
                <a
                  href={activeProviderMeta.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline hover:text-primary inline-flex items-center gap-1 font-medium transition-colors"
                >
                  <span>{activeProviderMeta.label} Developer Console</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </DialogDescription>
            </DialogHeader>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSaveProvider(selectedProvider);
              }}
              className="space-y-4 pt-1 text-left w-full min-w-0 max-w-full"
            >
              {/* Client ID — autoComplete="off" + ignore attributes mencegah autofill kredensial admin */}
              <div className="space-y-1.5 w-full min-w-0">
                <Label htmlFor="oauth-client-id" className="text-xs font-medium">
                  Client ID <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="oauth-client-id"
                  name="oauth_provider_client_id_field"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck="false"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  value={activeForm.clientId}
                  onChange={(e) => updateForm(selectedProvider, { clientId: e.target.value })}
                  placeholder={`Client ID from ${activeProviderMeta.label} console`}
                  required
                  className="h-10 text-sm font-mono w-full min-w-0"
                />
              </div>

              {/* Client Secret — autoComplete="new-password" mencegah autofill password admin */}
              <div className="space-y-1.5 w-full min-w-0">
                <Label htmlFor="oauth-client-secret" className="text-xs font-medium">
                  Client Secret {activeConfigured ? <span className="text-muted-foreground font-normal">(leave blank to keep current)</span> : <span className="text-destructive">*</span>}
                </Label>
                <Input
                  id="oauth-client-secret"
                  name="oauth_provider_client_secret_field"
                  type="password"
                  autoComplete="new-password"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  value={activeForm.clientSecret}
                  onChange={(e) => updateForm(selectedProvider, { clientSecret: e.target.value })}
                  placeholder={activeConfigured ? "••••••••••••••••" : `Client secret from ${activeProviderMeta.label}`}
                  required={!activeConfigured}
                  className="h-10 text-sm font-mono w-full min-w-0"
                />
              </div>

              {/* Redirect URI (Copyable) — Tombol Copy di baris label agar URL mendapat 100% lebar container tanpa overflow flex */}
              <div className="space-y-1.5 w-full min-w-0">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">Authorized Redirect URI</Label>
                  <button
                    type="button"
                    onClick={() => handleCopyUri(registerCallbackUrl(selectedProvider))}
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 font-medium transition-colors cursor-pointer"
                  >
                    {copiedUri ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span className={copiedUri ? "text-emerald-400" : ""}>{copiedUri ? "Copied" : "Copy URI"}</span>
                  </button>
                </div>
                <div className="h-10 px-3 bg-secondary/80 border border-border rounded-md w-full flex items-center text-xs font-mono text-muted-foreground select-all overflow-hidden min-w-0">
                  <span className="truncate w-full">{registerCallbackUrl(selectedProvider)}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Paste this exact URL into Authorized redirect URIs in your {activeProviderMeta.label} console.
                </p>
              </div>

              {/* Allowed Origins */}
              <div className="space-y-1.5 w-full min-w-0">
                <Label htmlFor="oauth-allowed-origins" className="text-xs font-medium">
                  Allowed Redirect Origins <span className="text-muted-foreground font-normal">(optional, comma-separated)</span>
                </Label>
                <Input
                  id="oauth-allowed-origins"
                  autoComplete="off"
                  value={activeForm.allowedOrigins}
                  onChange={(e) => updateForm(selectedProvider, { allowedOrigins: e.target.value })}
                  placeholder="e.g. https://app.mydomain.com, http://localhost:3000"
                  className="h-10 font-mono text-xs w-full min-w-0"
                />
              </div>

              {/* Toggle Enable Card */}
              <div className="rounded-lg border border-border bg-secondary/40 p-3 flex items-center justify-between gap-3 w-full min-w-0">
                <div className="space-y-0.5">
                  <Label htmlFor="oauth-enable-toggle" className="text-xs font-medium cursor-pointer text-foreground block">
                    Enable {activeProviderMeta.label} Sign-in
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    Allow end users to authenticate with their {activeProviderMeta.label} account.
                  </p>
                </div>
                <Checkbox
                  id="oauth-enable-toggle"
                  checked={activeForm.enabled}
                  onCheckedChange={(c: boolean | "indeterminate") =>
                    updateForm(selectedProvider, { enabled: !!c })
                  }
                />
              </div>

              {/* Modal Footer */}
              <div className="flex items-center justify-between pt-4 border-t border-border mt-5 w-full min-w-0">
                <div>
                  {activeConfigured && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 text-xs gap-1.5 h-9"
                      onClick={() => setConfirmDeleteProvider(selectedProvider)}
                      disabled={savingProvider}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Remove Provider</span>
                    </Button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-9 px-4 text-xs"
                    onClick={() => {
                      setSelectedProvider(null);
                      setConfirmDeleteProvider(null);
                    }}
                    disabled={savingProvider}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    className="h-9 px-4 text-xs gap-1.5"
                    disabled={savingProvider || !activeForm.clientId.trim()}
                  >
                    {savingProvider ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Saving…</span>
                      </>
                    ) : (
                      <>
                        <Save className="w-3.5 h-3.5" />
                        <span>Save Changes</span>
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </form>

            {/* Konfirmasi Hapus Provider */}
            {confirmDeleteProvider && (
              <div className="mt-3">
                <ConfirmDelete
                  title={`Remove ${activeProviderMeta.label} provider?`}
                  description="Users will no longer be able to log in using this OAuth provider. Existing linked accounts will be detached."
                  confirmLabel="Remove"
                  busy={savingProvider}
                  onConfirm={() => void handleDeleteProvider(confirmDeleteProvider)}
                  onCancel={() => setConfirmDeleteProvider(null)}
                />
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}

      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
