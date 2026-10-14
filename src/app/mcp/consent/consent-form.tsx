"use client";

/**
 * The one screen in the OAuth flow where a human decides anything.
 *
 * Everything it shows is a decision the owner is making on behalf of a program
 * they cannot see: which of two grants it gets, and — if it gets the write
 * grant — whether its writes happen or wait. So the defaults matter more than
 * the layout. Read-only is preselected and approval-required is preselected,
 * because the safe answer must be the one you get by pressing the obvious
 * button, and «اجازه بده» must never quietly mean "and it can change my prices".
 */
import { useCallback, useEffect, useState } from "react";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, InfoBox } from "@/app/dashboard/ui";
import {
  ALL_MCP_SCOPES,
  MCP_SCOPE_DESCRIPTIONS,
  MCP_SCOPE_LABELS,
  MCP_SCOPES,
  MCP_WRITE_MODE_LABELS,
  type McpScope,
  type McpWriteMode,
} from "@/lib/mcp/scopes";
import {
  MCP_APPS,
  MCP_APP_LABELS,
  MCP_APP_DESCRIPTIONS,
  defaultGrantsForConsents,
  grantsToStorage,
  type McpGrants,
} from "@/lib/mcp/grants";

interface ConsentInfo {
  client: { clientId: string; clientName: string };
  branch: { id: string; name: string } | null;
  /** Issue #883 §1 — every active branch the owner could consent to. */
  branches: { id: string; name: string }[];
}

type AppGrantMap = Record<string, { read: boolean; write: boolean }>;

/** The consent screen's grant state; serializes to the wire document. */
interface GrantDraft {
  apps: AppGrantMap;
  branches: string[] | "all";
}

function draftToGrants(draft: GrantDraft): unknown {
  const grants: McpGrants = {
    apps: {},
    branches: draft.branches,
  };
  for (const app of MCP_APPS) {
    grants.apps[app] = draft.apps[app] ?? { read: false, write: false };
  }
  return grantsToStorage(grants);
}

export function ConsentForm(props: {
  isOwner: boolean;
  featureEnabled: boolean;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  requestedScopes: string[];
}) {
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<McpScope[]>([MCP_SCOPES.read]);
  const [writeMode, setWriteMode] = useState<McpWriteMode>("approve");
  const [name, setName] = useState("");
  // Issue #883 §1 — the grant document the owner composes here. Built from
  // the safe default (read everything, write nothing, current branch only)
  // once the branch list lands.
  const [draft, setDraft] = useState<GrantDraft | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ client_id: props.clientId });
    if (props.requestedScopes.length > 0) params.set("scope", props.requestedScopes.join(" "));
    const { ok, data } = await api<ConsentInfo & { error?: string }>(
      `/api/connections/mcp/consent?${params.toString()}`,
    );
    if (ok) {
      setInfo(data);
      setName(data.client.clientName);
      const primary = data.branch?.id ?? data.branches[0]?.id ?? "";
      const defaults = defaultGrantsForConsents(primary);
      const apps: AppGrantMap = {};
      for (const app of MCP_APPS) apps[app] = { ...defaults.apps[app]! };
      setDraft({ apps, branches: [...(defaults.branches as string[])] });
    } else {
      setError(
        data.error === "invalid_client"
          ? "این درخواست معتبر نیست: برنامه‌ای با این شناسه نزد این کسب‌وکار ثبت نشده است."
          : "بارگذاری این درخواست ممکن نشد.",
      );
    }
    setLoading(false);
  }, [props.clientId, props.requestedScopes]);

  useEffect(() => {
    if (props.isOwner && props.featureEnabled && props.clientId) void load();
    else setLoading(false);
  }, [load, props.clientId, props.featureEnabled, props.isOwner]);

  function toggle(scope: McpScope) {
    setApproved((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function decide(allow: boolean) {
    if (!allow) {
      // A refusal is answered by the client's own redirect URI carrying
      // `access_denied`, which is what tells the connector to stop waiting.
      const url = new URL(props.redirectUri);
      url.searchParams.set("error", "access_denied");
      if (props.state !== null) url.searchParams.set("state", props.state);
      window.location.href = url.toString();
      return;
    }

    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ redirectTo?: string; error?: string }>(
      "/api/connections/mcp/consent",
      {
        method: "POST",
        body: JSON.stringify({
          clientId: props.clientId,
          redirectUri: props.redirectUri,
          codeChallenge: props.codeChallenge,
          state: props.state,
          requestedScopes: props.requestedScopes,
          approvedScopes: approved,
          writeMode,
          connectionName: name,
          grants: draft ? draftToGrants(draft) : undefined,
        }),
      },
    );
    setBusy(false);
    if (ok && data.redirectTo) {
      window.location.href = data.redirectTo;
      return;
    }
    const messages: Record<string, string> = {
      invalid_scopes: "حداقل یک دسترسی را انتخاب کنید.",
      invalid_grants: "مجوزهای انتخاب‌شده معتبر نیست — دسترسی خواندن یا حداقل یک شعبه را روشن کنید.",
      invalid_client: "این درخواست معتبر نیست.",
      invalid_request: "این درخواست معتبر نیست.",
      no_location: "شعبه‌ای ثبت نشده است.",
      feature_disabled: "این امکان برای کسب‌وکار شما فعال نیست.",
    };
    setError(messages[data.error ?? ""] ?? "ثبت اجازه ممکن نشد.");
  }

  if (!props.isOwner) {
    return (
      <ConsentShell title="اتصال برنامهٔ هوش مصنوعی">
        <ErrorBox>فقط مالک کسب‌وکار می‌تواند به یک برنامهٔ بیرونی اجازهٔ دسترسی بدهد. با حساب مالک وارد شوید و دوباره تلاش کنید.</ErrorBox>
      </ConsentShell>
    );
  }
  if (!props.featureEnabled) {
    return (
      <ConsentShell title="اتصال برنامهٔ هوش مصنوعی">
        <ErrorBox>امکان «کلیدهای API و اتصال هوش مصنوعی» برای کسب‌وکار شما فعال نیست.</ErrorBox>
      </ConsentShell>
    );
  }
  if (loading) {
    return (
      <ConsentShell title="اتصال برنامهٔ هوش مصنوعی">
        <FormLoadingSkeleton rows={3} showHeading={false} label="در حال بارگذاری درخواست اتصال" />
      </ConsentShell>
    );
  }
  if (!info) {
    return (
      <ConsentShell title="اتصال برنامهٔ هوش مصنوعی">
        <ErrorBox>{error ?? "این درخواست معتبر نیست."}</ErrorBox>
      </ConsentShell>
    );
  }

  const canWrite = approved.includes(MCP_SCOPES.write);

  function toggleApp(app: string, level: "read" | "write") {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current.apps[app]! };
      if (level === "read") {
        next.read = !next.read;
        if (!next.read) next.write = false; // write-without-read is refused at mint
      } else {
        next.write = !next.write;
        if (next.write) next.read = true;
      }
      return { ...current, apps: { ...current.apps, [app]: next } };
    });
  }

  function toggleBranch(id: string) {
    setDraft((current) => {
      if (!current || current.branches === "all") return current;
      const branches = current.branches.includes(id)
        ? current.branches.filter((branch) => branch !== id)
        : [...current.branches, id];
      return { ...current, branches };
    });
  }

  const anyAppGranted = draft
    ? Object.values(draft.apps).some((grant) => grant.read || grant.write)
    : true;
  const anyBranch = draft ? draft.branches === "all" || draft.branches.length > 0 : true;
  const draftInvalid = !anyAppGranted || !anyBranch;

  return (
    <ConsentShell title="اتصال برنامهٔ هوش مصنوعی">
      <p className="text-sm leading-6 text-muted-foreground">
        برنامهٔ <span className="font-semibold text-foreground">«{info.client.clientName}»</span> درخواست
        دسترسی به داده‌های این کسب‌وکار را دارد. انتخاب کنید چه چیزی به آن بدهید؛ جزئیات را می‌توانید
        که اواخر کافی است یک کلیک بیشتر بازتر کنید.
      </p>

      {draft ? (
        <div className="mt-5 rounded-xl border border-border/80 p-3">
          <p className="mb-3 text-sm font-medium">
            این برنامه به کدام قسمت‌ها دسترسی داشته باشد؟
          </p>
          <div className="space-y-2">
            {MCP_APPS.map((app) => {
              const grant = draft.apps[app]!;
              return (
                <div
                  key={app}
                  className="rounded-lg border border-border/60 p-3"
                  aria-label={MCP_APP_LABELS[app]}
                >
                  <p className="text-sm font-medium">{MCP_APP_LABELS[app]}</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {MCP_APP_DESCRIPTIONS[app]}
                  </p>
                  <div className="mt-2 flex gap-4">
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={grant.read}
                        onChange={() => toggleApp(app, "read")}
                      />
                      خواندن
                    </label>
                    {canWrite ? (
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={grant.write}
                          onChange={() => toggleApp(app, "write")}
                        />
                        نوشتن
                      </label>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          {!anyAppGranted ? (
            <p className="mt-2 text-xs text-destructive">
              حداقل برای یک بخش دسترسی خواندن یا نوشتن فعال کنید.
            </p>
          ) : null}
        </div>
      ) : null}

      {draft && info.branches.length > 1 ? (
        <div className="mt-4 rounded-xl border border-border/80 p-3">
          <p className="mb-2 text-sm font-medium">دسترسی به کدام شعبه‌ها؟</p>
          <p className="mb-3 text-xs leading-5 text-muted-foreground">
            فقط داده‌های همین شعبه‌ها دیده یا تغییر می‌کند. جمع‌بندی‌های چندشعبه‌ای فقط وقتی بیش از
            یک شعبه انتخاب شده باشد در دسترس است.
          </p>
          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.branches === "all"}
                onChange={() =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          branches:
                            current.branches === "all"
                              ? [info.branches[0]!.id]
                              : ("all" as const),
                        }
                      : current,
                  )
                }
              />
              همهٔ شعبه‌ها (از جمله شعبه‌هایی که بعداً اضافه می‌شوند)
            </label>
            {draft.branches !== "all"
              ? info.branches.map((branch) => (
                  <label
                    key={branch.id}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={
                        draft.branches !== "all" && draft.branches.includes(branch.id)
                      }
                      onChange={() => toggleBranch(branch.id)}
                    />
                    {branch.name}
                  </label>
                ))
              : null}
          </div>
          {!anyBranch ? (
            <p className="mt-2 text-xs text-destructive">حداقل یک شعبه را انتخاب کنید.</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 space-y-3">
        {ALL_MCP_SCOPES.map((scope) => (
          <label
            key={scope}
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/80 p-3 hover:bg-muted"
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={approved.includes(scope)}
              onChange={() => toggle(scope)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{MCP_SCOPE_LABELS[scope]}</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                {MCP_SCOPE_DESCRIPTIONS[scope]}
              </span>
            </span>
          </label>
        ))}
      </div>

      {canWrite ? (
        <div className="mt-4 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/15 p-3">
          <p className="mb-2 text-sm font-medium text-amber-950 dark:text-amber-200">تغییرها چطور اعمال شوند؟</p>
          <div className="space-y-2">
            {(["approve", "apply"] as McpWriteMode[]).map((mode) => (
              <label key={mode} className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="writeMode"
                  className="mt-1"
                  checked={writeMode === mode}
                  onChange={() => setWriteMode(mode)}
                />
                <span className="min-w-0">
                  <span className="block text-sm">{MCP_WRITE_MODE_LABELS[mode]}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-amber-900/80 dark:text-amber-200">
                    {mode === "approve"
                      ? "هر تغییری در فهرست انتظار می‌ماند تا شما در «اتصال‌ها» تأییدش کنید. تا آن لحظه هیچ چیزی عوض نمی‌شود."
                      : "تغییرها بلافاصله ثبت می‌شوند. همهٔ آن‌ها در «گزارش عملیات دستیار» ثبت و قابل بازبینی‌اند."}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <InfoBox>این اتصال فقط می‌تواند بخواند و هیچ تغییری در داده‌های شما نمی‌دهد.</InfoBox>
      )}

      <div className="mt-4">
        <label htmlFor="connection-name" className="mb-1 block text-sm text-muted-foreground">
          نام این اتصال (برای شناختنش در فهرست اتصال‌ها)
        </label>
        <input
          id="connection-name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
        />
      </div>

      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <div className="mt-6 flex gap-3">
        <Button
          onClick={() => decide(true)}
          disabled={busy || approved.length === 0 || draftInvalid}
        >
          {busy ? "در حال ثبت…" : "اجازه بده"}
        </Button>
        <Button variant="outline" onClick={() => decide(false)} disabled={busy}>
          انصراف
        </Button>
      </div>
    </ConsentShell>
  );
}

function ConsentShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="mb-1 text-lg font-bold">{title}</h1>
      <div className="mt-4">{children}</div>
    </div>
  );
}
