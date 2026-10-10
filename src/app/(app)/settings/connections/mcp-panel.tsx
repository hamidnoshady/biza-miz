"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * «دستیارهای هوش مصنوعی» — connecting Claude, ChatGPT, Codex and anything else
 * that speaks MCP to this business.
 *
 * The panel does three jobs, in the order an owner meets them:
 *
 *   1. **Hand over the address.** For Claude and ChatGPT that is the whole
 *      setup: paste one URL into their "add connector" box, sign in here, tick
 *      what it may do. No credential is typed anywhere.
 *   2. **Mint a token** for the clients that cannot do OAuth and read a config
 *      file instead (Codex, an IDE, a script). Shown once, hashed, never again.
 *   3. **Show what is connected, and let it be taken back** — narrowed to
 *      read-only, dropped to approval-required, or revoked outright, each in one
 *      click and effective on the connector's very next call.
 *
 * Plus the approval list, which is where an `approve`-mode connection's writes
 * wait. It is deliberately at the top when it is non-empty: a queue nobody looks
 * at is the same as a connector that does not work.
 */
import { useCallback, useEffect, useState } from "react";
import { useFeatureLocked } from "@/components/feature-lock";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, InfoBox, inputClass } from "@/app/dashboard/ui";
import {
  ALL_MCP_SCOPES,
  MCP_SCOPES,
  MCP_SCOPE_LABELS,
  MCP_WRITE_MODE_LABELS,
  type McpScope,
  type McpWriteMode,
} from "@/lib/mcp/scopes";
import {
  MCP_APPS,
  MCP_APP_LABELS,
  defaultGrantsForConsents,
  grantsToStorage,
  type McpApp,
  type McpGrants,
} from "@/lib/mcp/grants";

interface McpConnection {
  id: string;
  name: string;
  scopes: McpScope[];
  writeMode: McpWriteMode;
  origin: "token" | "oauth";
  clientName: string | null;
  tokenPrefix: string | null;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** Issue #883 §1 — the parsed app/branch consent this connection carries. */
  grants: McpGrants;
  branchScope: "single" | "multi";
  grantedBranchIds: string[] | null;
  locationName: string | null;
}

/** A ment of history from the operations trail. */
interface HistoryRow {
  id: string;
  connectionId: string | null;
  connectionName: string | null;
  actionLabel: string;
  title: string;
  summary: string;
  status: "applied" | "failed" | "dismissed";
  requiresReview: boolean;
  createdAt: string;
  closedAt: string | null;
}

interface PendingAction {
  id: string;
  connectionName: string | null;
  actionLabel: string;
  title: string;
  summary: string;
  createdAt: string;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}

/** A one-line Persian summary of the grants document, for the connection row. */
function grantsSummary(connection: McpConnection): string {
  const writable = MCP_APPS.filter((app) => connection.grants.apps[app]?.write);
  const readable = MCP_APPS.filter((app) => connection.grants.apps[app]?.read && !connection.grants.apps[app]?.write);
  const parts: string[] = [];
  if (writable.length > 0) parts.push(`خواندن+نوشتن: ${writable.map((a) => MCP_APP_LABELS[a]).join("، ")}`);
  if (readable.length > 0) parts.push(`فقط خواندن: ${readable.map((a) => MCP_APP_LABELS[a]).join("، ")}`);
  if (parts.length === 0) {
    // Legacy `{}` — pre-wave-2 connections parse to the conservative full set.
    parts.push("همهٔ بخش‌ها (سطح دسترسی اتصال)");
  }
  if (connection.grants.branches === "all") parts.push("همهٔ شعبه‌ها");
  else if (connection.locationName) parts.push(`شعبهٔ «${connection.locationName}»`);
  return parts.join(" — ");
}

export function McpPanel() {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [endpoint, setEndpoint] = useState("");
  // Issue #883 P0-4 — creating, narrowing, revoking and approving are
  // owner-only (`mcp.manage`). The panel still lists what is connected, but
  // renders every mutating control only when the server says this member may.
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const locked = useFeatureLocked();

  const [name, setName] = useState("");
  const [selected, setSelected] = useState<McpScope[]>([MCP_SCOPES.read]);
  const [writeMode, setWriteMode] = useState<McpWriteMode>("approve");
  const [expiresInDays, setExpiresInDays] = useState("180");
  // Issue #883 §1: the grant document the new connection gets. The panel's
  // default = read everything, write nothing, only THE CURRENT branch — the
  // safe shape the banner copy explains; widen from here explicitly.
  const [grantDraft, setGrantDraft] = useState<{
    apps: Record<McpApp, { read: boolean; write: boolean }>;
    branches: string[] | "all";
  } | null>(null);
  // The owner's current branch — the panel shows it as the anchor of the
  // default grant document.
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  // Issue #883 UX — the decided-trail view, with filters + pagination.
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyStatus, setHistoryStatus] = useState<string>("");
  const [historyQuery, setHistoryQuery] = useState("");
  const HISTORY_PAGE = 10;

  const load = useCallback(async () => {
    if (locked) {
      setConnections([]);
      setPending([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { ok, data } = await api<{
      connections?: McpConnection[];
      pending?: PendingAction[];
      endpoint?: string;
      canManage?: boolean;
      branches?: { id: string; name: string }[];
      currentBranchId?: string | null;
    }>("/api/connections/mcp");
    if (ok) {
      setConnections(data.connections ?? []);
      setPending(data.pending ?? []);
      setEndpoint(data.endpoint ?? "");
      setCanManage(data.canManage === true);
      setBranches(data.branches ?? []);
      // Prime the grant draft from the safe default, anchored on the current branch.
      const defaults = defaultGrantsForConsents(data.currentBranchId ?? data.branches?.[0]?.id ?? "");
      setGrantDraft((current) =>
        current ?? {
          apps: Object.fromEntries(
            MCP_APPS.map((app) => [app, { ...defaults.apps[app]! }]),
          ) as Record<McpApp, { read: boolean; write: boolean }>,
          branches: Array.isArray(defaults.branches) ? [...defaults.branches] : defaults.branches,
        },
      );
    } else {
      setMessage({ kind: "error", text: "بارگذاری اتصال‌ها ممکن نشد." });
    }
    setLoading(false);
  }, [locked]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!locked) void loadHistory(0, historyStatus, historyQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, historyStatus]);

  function toggleScope(scope: McpScope) {
    setSelected((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function create() {
    setBusy(true);
    setMessage(null);
    const { ok, data } = await api<{ token?: string; error?: string }>("/api/connections/mcp", {
      method: "POST",
      body: JSON.stringify({
        name,
        scopes: selected,
        writeMode,
        expiresInDays: expiresInDays.trim() ? Number(expiresInDays) : null,
        grants: grantDraft
          ? grantsToStorage({
              apps: grantDraft.apps,
              branches: grantDraft.branches,
            })
          : undefined,
      }),
    });
    setBusy(false);
    if (!ok || !data.token) {
      const map: Record<string, string> = {
        invalid_name: "برای این اتصال یک نام وارد کنید.",
        invalid_scopes: "حداقل یک دسترسی را انتخاب کنید.",
        invalid_write_mode: "حالت اعمال تغییرها معتبر نیست.",
        invalid_expiry: "مدت اعتبار معتبر نیست.",
        invalid_grants:
          "مجوزهای انتخاب‌شده معتبر نیست — حداقل یک بخش با دسترسی خواندن و یک شعبه لازم است.",
        branch_out_of_scope: "شعبهٔ انتخاب‌شده برای این اتصال قابل استفاده نیست.",
        feature_disabled: "«اتصال هوش مصنوعی» برای کسب‌وکار شما فعال نیست.",
      };
      setMessage({ kind: "error", text: map[data.error ?? ""] ?? errorMessage(data.error) });
      return;
    }
    setToken(data.token);
    setName("");
    setExpiresInDays("");
    await load();
  }

  async function loadHistory(offset: number, status: string, q: string) {
    const params = new URLSearchParams({
      limit: String(HISTORY_PAGE),
      offset: String(offset),
    });
    if (status) params.set("status", status);
    if (q.trim()) params.set("q", q.trim());
    const { ok, data } = await api<{ rows?: HistoryRow[]; total?: number }>(
      `/api/connections/mcp/history?${params.toString()}`,
    );
    if (ok) {
      setHistory(data.rows ?? []);
      setHistoryTotal(data.total ?? 0);
      setHistoryOffset(offset);
    }
  }

  async function revoke(connection: McpConnection) {
    if (
      !confirm(
        `اتصال «${connection.name}» باطل شود؟ آن برنامه بلافاصله دسترسی‌اش را از دست می‌دهد.`,
      )
    ) {
      return;
    }
    setBusy(true);
    const { ok } = await api(`/api/connections/mcp/${connection.id}`, { method: "DELETE" });
    setBusy(false);
    setMessage(
      ok
        ? { kind: "ok", text: "اتصال باطل شد." }
        : { kind: "error", text: "باطل‌کردن اتصال ممکن نشد." },
    );
    await load();
  }

  async function patch(connection: McpConnection, changes: { scopes?: McpScope[]; writeMode?: McpWriteMode }) {
    setBusy(true);
    const { ok } = await api(`/api/connections/mcp/${connection.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        scopes: changes.scopes ?? connection.scopes,
        writeMode: changes.writeMode ?? connection.writeMode,
      }),
    });
    setBusy(false);
    if (!ok) setMessage({ kind: "error", text: "تغییر دسترسی ممکن نشد." });
    await load();
  }

  async function decide(action: PendingAction, decision: "approve" | "reject") {
    setBusy(true);
    const { ok, data } = await api<{ outcome?: { status: string; message: string } }>(
      `/api/connections/mcp/pending/${action.id}`,
      { method: "POST", body: JSON.stringify({ decision }) },
    );
    setBusy(false);
    if (!ok) {
      setMessage({ kind: "error", text: "ثبت این تصمیم ممکن نشد." });
    } else if (decision === "reject") {
      setMessage({ kind: "ok", text: "درخواست رد شد و چیزی تغییر نکرد." });
    } else {
      setMessage({
        kind: data.outcome?.status === "applied" ? "ok" : "error",
        text: data.outcome?.message ?? "انجام شد.",
      });
    }
    await load();
  }

  return (
    <div className="space-y-6">
      {message?.kind === "ok" ? <InfoBox>{message.text}</InfoBox> : null}
      {message?.kind === "error" ? <ErrorBox>{message.text}</ErrorBox> : null}

      {token ? (
        <div className="rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 p-4 text-sm">
          <p className="font-semibold text-amber-900 dark:text-amber-200">این توکن فقط همین یک بار نمایش داده می‌شود.</p>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            آن را در جای امنی ذخیره کنید. اگر گم شود قابل بازیابی نیست و باید اتصال تازه‌ای بسازید.
          </p>
          <code
            dir="ltr"
            className="mt-2 block select-all break-all rounded-lg bg-white/70 p-2 font-mono text-amber-900 dark:text-amber-200"
          >
            {token}
          </code>
          <Button
            type="button"
            size="sm"
            className="mt-2 bg-amber-500 dark:bg-amber-400 text-amber-950 hover:bg-amber-600 dark:hover:bg-amber-300"
            onClick={() => {
              void navigator.clipboard.writeText(token).catch(() => undefined);
              setToken(null);
            }}
          >
            کپی و بستن
          </Button>
        </div>
      ) : null}

      {!canManage && !loading ? (
        <InfoBox>
          ساخت، تغییر و ابطال اتصال‌های هوش مصنوعی و تأیید درخواست‌های در انتظار، مخصوص مالک
          کسب‌وکار است. این فهرست برای شما فقط‌خواندنی است.
        </InfoBox>
      ) : null}

      {pending.length > 0 ? (
        <SectionCard title={`تغییرهای منتظر تأیید (${pending.length.toLocaleString("fa-IR")})`}>
          <p className="mb-3 text-xs leading-5 text-muted-foreground">
            این‌ها را یک دستیار هوش مصنوعی درخواست کرده است. تا وقتی تأیید نکنید هیچ‌کدام ثبت نشده‌اند.
          </p>
          <ul className="space-y-2">
            {pending.map((action) => (
              <li key={action.id} className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/15 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{action.actionLabel}</span>
                  {action.connectionName ? (
                    <StatusBadge tone="neutral">{action.connectionName}</StatusBadge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">{formatDateTime(action.createdAt)}</span>
                </div>
                <p dir="ltr" className="mt-1 break-all text-start text-xs text-muted-foreground">
                  {action.summary}
                </p>
                {canManage ? (
                  <div className="mt-2 flex gap-2">
                    <Button type="button" size="xs" onClick={() => decide(action, "approve")} disabled={busy}>
                      تأیید و ثبت
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => decide(action, "reject")}
                      disabled={busy}
                    >
                      رد
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="اتصال Claude یا ChatGPT">
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          در برنامهٔ Claude (موبایل یا دسکتاپ) یا در ChatGPT، بخش افزودن «Connector» را باز کنید و همین آدرس
          را وارد کنید. سپس همین‌جا وارد می‌شوید و انتخاب می‌کنید چه دسترسی‌ای بدهید. هیچ کلید یا رمزی جایی
          کپی نمی‌شود.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code
            dir="ltr"
            className="min-w-0 flex-1 select-all break-all rounded-lg bg-muted p-2 font-mono text-xs"
          >
            {endpoint || "—"}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(endpoint).catch(() => undefined)}
            disabled={!endpoint}
          >
            کپی آدرس
          </Button>
        </div>
      </SectionCard>

      {canManage ? (
      <SectionCard title="ساخت توکن برای برنامه‌های دیگر">
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          برای ابزارهایی مثل Codex یا افزونه‌های ویرایشگر که به‌جای ورود، توکن را از فایل تنظیمات می‌خوانند.
          برای هر برنامه یک اتصال جدا بسازید تا بتوانید فقط همان را باطل کنید.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <input
            className={inputClass}
            placeholder="نام اتصال (مثلاً Codex روی لپ‌تاپ)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            placeholder="مدت اعتبار به روز (پیش‌فرض ۱۸۰ روز)"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
          />
        </div>

        {grantDraft ? (
          <fieldset className="mt-3 rounded-xl border border-border/60 p-3">
            <legend className="mb-1 text-sm font-medium">دسترسی هر بخش</legend>
            <p className="mb-3 text-xs leading-5 text-muted-foreground">
              پیش‌فرض را استفای شروع کنید: خواندن همه‌چیز و نوشتن هیچ‌چیز. «نوشتن» فقط وقتی اثر دارد
              که دسترسی pos.write هم روشن باشد و حتی برای موارد خطرناک، تأیید شما لازم است.
            </p>
            <div className="space-y-2">
              {MCP_APPS.map((app) => (
                <div key={app} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="min-w-28 text-xs font-medium">{MCP_APP_LABELS[app]}</span>
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={grantDraft.apps[app].read}
                      onChange={() =>
                        setGrantDraft((current) =>
                          current
                            ? {
                                ...current,
                                apps: {
                                  ...current.apps,
                                  [app]: {
                                    read: !current.apps[app].read,
                                    write: current.apps[app].read
                                      ? false
                                      : current.apps[app].write,
                                  },
                                },
                              }
                            : current,
                        )
                      }
                    />
                    خواندن
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={grantDraft.apps[app].write}
                      onChange={() =>
                        setGrantDraft((current) =>
                          current
                            ? {
                                ...current,
                                apps: {
                                  ...current.apps,
                                  [app]: {
                                    read: current.apps[app].write ? true : current.apps[app].read,
                                    write: !current.apps[app].write,
                                  },
                                },
                              }
                            : current,
                        )
                      }
                    />
                    نوشتن
                  </label>
                </div>
              ))}
            </div>
            <div className="mt-3 border-t border-border/60 pt-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={grantDraft.branches === "all"}
                  onChange={() =>
                    setGrantDraft((current) =>
                      current
                        ? {
                            ...current,
                            branches:
                              current.branches === "all"
                                ? branches.slice(0, 1).map((b) => b.id)
                                : "all",
                          }
                        : current,
                    )
                  }
                />
                همهٔ شعبه‌ها
              </label>
              {grantDraft.branches !== "all" ? (
                branches.length > 1 ? (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {branches.map((branch) => (
                      <label key={branch.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={
                            Array.isArray(grantDraft.branches) && grantDraft.branches.includes(branch.id)
                          }
                          onChange={() =>
                            setGrantDraft((current) => {
                              if (!current || current.branches === "all") return current;
                              const next = current.branches.includes(branch.id)
                                ? current.branches.filter((id) => id !== branch.id)
                                : [...current.branches, branch.id];
                              return { ...current, branches: next };
                            })
                          }
                        />
                        {branch.name}
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    فقط شعبهٔ فعلی ({branches[0]?.name ?? "—"})
                  </p>
                )
              ) : null}
            </div>
          </fieldset>
        ) : null}

        <fieldset className="mt-3">
          <legend className="mb-2 text-sm font-medium">دسترسی‌ها</legend>
          <div className="flex flex-wrap gap-2">
            {ALL_MCP_SCOPES.map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => toggleScope(scope)}
                aria-pressed={selected.includes(scope)}
                className={`min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${
                  selected.includes(scope)
                    ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {MCP_SCOPE_LABELS[scope]}
              </button>
            ))}
          </div>
        </fieldset>

        {selected.includes(MCP_SCOPES.write) ? (
          <fieldset className="mt-3">
            <legend className="mb-2 text-sm font-medium">تغییرها چطور اعمال شوند؟</legend>
            <div className="flex flex-wrap gap-2">
              {(["approve", "apply"] as McpWriteMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setWriteMode(mode)}
                  aria-pressed={writeMode === mode}
                  className={`min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${
                    writeMode === mode
                      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {MCP_WRITE_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}

        <Button
          type="button"
          className="mt-4"
          onClick={create}
          disabled={busy || !name.trim() || selected.length === 0}
        >
          {busy ? "در حال ساخت…" : "ساخت اتصال"}
        </Button>
      </SectionCard>
      ) : null}

      <SectionCard title="اتصال‌های موجود">
        {loading ? (
          <LoadingSkeleton rows={3} />
        ) : connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز هیچ دستیاری به این کسب‌وکار وصل نشده است.</p>
        ) : (
          <ul className="space-y-2">
            {connections.map((connection) => (
              <li key={connection.id} className="rounded-xl border border-border/80 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{connection.name}</span>
                  <StatusBadge tone="neutral">
                    {connection.origin === "oauth" ? "ورود مستقیم" : "توکن"}
                  </StatusBadge>
                  {connection.tokenPrefix ? (
                    <code dir="ltr" className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
                      {connection.tokenPrefix}…
                    </code>
                  ) : null}
                  <StatusBadge tone={connection.status === "active" ? "positive" : "neutral"}>
                    {connection.status === "active" ? "فعال" : "باطل‌شده"}
                  </StatusBadge>
                  {connection.status === "active" && canManage ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => revoke(connection)}
                      disabled={busy}
                    >
                      باطل‌کردن
                    </Button>
                  ) : null}
                </div>

                <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {connection.scopes.map((scope) => (
                    <span key={scope} className="rounded bg-muted px-2 py-0.5">
                      {MCP_SCOPE_LABELS[scope]}
                    </span>
                  ))}
                  {connection.scopes.includes(MCP_SCOPES.write) ? (
                    <span className="rounded bg-amber-100 dark:bg-amber-500/20 px-2 py-0.5 text-amber-950 dark:text-amber-200">
                      {MCP_WRITE_MODE_LABELS[connection.writeMode]}
                    </span>
                  ) : null}
                </div>
                {/* Issue #883 §1 — what the connection touches, in words any
                    owner can read. The registry keeps the machine truth; this
                    is the human rendering of it. */}
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {grantsSummary(connection)}
                </p>

                {connection.status === "active" && canManage ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {connection.scopes.includes(MCP_SCOPES.write) ? (
                      <>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => patch(connection, { scopes: [MCP_SCOPES.read] })}
                          disabled={busy}
                        >
                          فقط خواندن
                        </Button>
                        {connection.writeMode === "apply" ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => patch(connection, { writeMode: "approve" })}
                            disabled={busy}
                          >
                            تغییرها منتظر تأیید بمانند
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => patch(connection, { writeMode: "apply" })}
                            disabled={busy}
                          >
                            تغییرها بدون تأیید اجرا شوند
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          patch(connection, { scopes: [MCP_SCOPES.read, MCP_SCOPES.write] })
                        }
                        disabled={busy}
                      >
                        اجازهٔ تغییر هم بده
                      </Button>
                    )}
                  </div>
                ) : null}

                <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>ساخت: {formatDateTime(connection.createdAt)}</span>
                  <span>آخرین استفاده: {formatDateTime(connection.lastUsedAt)}</span>
                  <span>انقضا: {connection.expiresAt ? formatDateTime(connection.expiresAt) : "ندارد"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Issue #883 UX — the decided trail with status filter, search and
          pagination. Arabian-aware layout mirrors the pending queue above. */}
      <SectionCard title={`گزارش عملیات دستیارها (${historyTotal.toLocaleString("fa-IR")})`}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            className={`${inputClass} max-w-52 text-xs`}
            placeholder="جست‌وجو در عنوان یا قسمت…"
            value={historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void loadHistory(0, historyStatus, historyQuery);
            }}
          />
          <select
            className="rounded-lg border border-input bg-white dark:bg-card px-3 py-2 text-xs"
            value={historyStatus}
            onChange={(e) => setHistoryStatus(e.target.value)}
            aria-label="وضعیت"
          >
            <option value="">همهٔ وضعیت‌ها</option>
            <option value="applied">انجام‌شده</option>
            <option value="failed">ناموفق</option>
            <option value="dismissed">ردشده</option>
          </select>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void loadHistory(0, historyStatus, historyQuery)}
          >
            جست‌وجو
          </Button>
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            هنوز عملیاتی ثبت نشده است — وقتی یک اتصال کاری انجام دهد یا شما درخواستی را رد کنید،
            اینجا می‌آید.
          </p>
        ) : (
          <ul className="space-y-2">
            {history.map((row) => (
              <li key={row.id} className="rounded-lg border border-border/60 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    tone={
                      row.status === "applied"
                        ? "positive"
                        : row.status === "failed"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {row.status === "applied" ? "انجام‌شده" : row.status === "failed" ? "ناموفق" : "ردشده"}
                  </StatusBadge>
                  {row.requiresReview ? <StatusBadge tone="active">نیازمند بازبینی</StatusBadge> : null}
                  <span className="font-medium">{row.actionLabel}</span>
                  {row.connectionName ? (
                    <StatusBadge tone="neutral">{row.connectionName}</StatusBadge>
                  ) : null}
                  <span className="text-muted-foreground">
                    {formatDateTime(row.closedAt ?? row.createdAt)}
                  </span>
                </div>
                <p dir="ltr" className="mt-1 break-all text-start text-muted-foreground">
                  {row.summary}
                </p>
              </li>
            ))}
          </ul>
        )}
        {historyTotal > HISTORY_PAGE ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={historyOffset === 0}
              onClick={() =>
                void loadHistory(
                  Math.max(0, historyOffset - HISTORY_PAGE),
                  historyStatus,
                  historyQuery,
                )
              }
            >
              قبلی
            </Button>
            <span>
              صفحهٔ {(Math.floor(historyOffset / HISTORY_PAGE) + 1).toLocaleString("fa-IR")} از{" "}
              {Math.ceil(historyTotal / HISTORY_PAGE).toLocaleString("fa-IR")}
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={historyOffset + HISTORY_PAGE >= historyTotal}
              onClick={() =>
                void loadHistory(historyOffset + HISTORY_PAGE, historyStatus, historyQuery)
              }
            >
              بعدی
            </Button>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="راهنمای برنامه‌های مبتنی بر فایل تنظیمات">
        <p className="mb-2 text-xs leading-6 text-muted-foreground">
          توکن را در سرآیند <code dir="ltr">Authorization</code> بفرستید. نمونهٔ تنظیمات برای یک کلاینت MCP:
        </p>
        <pre dir="ltr" className="overflow-x-auto rounded-lg bg-primary p-3 text-xs text-primary-foreground/90">
{`{
  "mcpServers": {
    "cafe-pos": {
      "type": "http",
      "url": "${endpoint || "https://your-business.example.com/api/mcp"}",
      "headers": { "Authorization": "Bearer posmcp_..." }
    }
  }
}`}
        </pre>
      </SectionCard>
    </div>
  );
}
