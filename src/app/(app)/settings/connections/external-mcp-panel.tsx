"use client";

import { useCallback, useEffect, useState } from "react";

import { SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, InfoBox, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";

/**
 * Outbound MCP servers (issue #1473) — the tenants whose assistant may call
 * somebody else's MCP server, starting with an Eshobe CMS at `/api/mcp`.
 *
 * The inverse of the panel above it: that one hands *this* business's tools to
 * Claude and ChatGPT; this one registers a server whose tools *this* assistant may
 * call. The two are deliberately separate screens inside the same tab, because a
 * single credential never authorises both directions.
 *
 * The credential is write-only. It is typed once, sent over TLS, encrypted at rest
 * and never returned by any endpoint — so the form renders blank on every load and
 * an empty field on save means "unchanged", never "delete".
 *
 * The address must be on the deployment's `MCP_OUTBOUND_ALLOWED_HOSTS` allowlist.
 * That is stated in the card rather than discovered from a 403 after a save: an
 * operator who cannot add a host needs to know it is not their permission.
 */

interface ExternalTool {
  name: string;
  title?: string;
  description?: string;
}

interface ExternalServer {
  id: string;
  slug: string;
  label: string;
  url: string;
  authKind: "bearer" | "none";
  enabled: boolean;
  allowedTools: string[];
  discoveredTools: ExternalTool[];
  lastDiscoveredAt: string | null;
  lastError: string | null;
}

interface ExternalCall {
  id: string;
  toolName: string;
  status: "ok" | "refused" | "failed";
  durationMs: number | null;
  errorCode: string | null;
  createdAt: string;
}

const emptyDraft = {
  authKind: "bearer" as "bearer" | "none",
  bearerToken: "",
  enabled: true,
  label: "",
  slug: "",
  url: "",
};

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("fa-IR");
}

export function ExternalMcpPanel() {
  const [servers, setServers] = useState<ExternalServer[]>([]);
  const [calls, setCalls] = useState<Record<string, ExternalCall[]>>({});
  const [draft, setDraft] = useState(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{ servers?: ExternalServer[]; error?: string }>(
      "/api/integrations/mcp-servers",
    );
    setLoading(false);
    if (ok) {
      setServers(data.servers ?? []);
      setError("");
      return;
    }
    setError(data.error === "forbidden" ? "اجازهٔ دیدن اتصال‌ها را ندارید." : "دریافت سرورها ناموفق بود.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy("create");
    setError("");
    setNotice("");
    const { ok, data } = await api<{ server?: ExternalServer; error?: string }>(
      "/api/integrations/mcp-servers",
      {
        body: JSON.stringify({
          authKind: draft.authKind,
          // An empty token on an unauthenticated server is not a credential.
          bearerToken: draft.authKind === "bearer" ? draft.bearerToken : null,
          enabled: draft.enabled,
          label: draft.label,
          slug: draft.slug,
          url: draft.url,
        }),
        method: "POST",
      },
    );
    setBusy(null);
    if (!ok || !data.server) {
      setError(
        data.error === "url_not_allowed"
          ? "دامنهٔ این نشانی در فهرست مجاز سرور پشتیبانی نیست. با مدیر سامانه تماس بگیرید."
          : data.error === "duplicate_slug"
            ? "این شناسه قبلاً استفاده شده است."
            : "افزودن سرور ناموفق بود.",
      );
      return;
    }
    setDraft(emptyDraft);
    setNotice("سرور افزوده شد. برای دیدن ابزارها «تست اتصال» را بزنید.");
    await load();
  }

  async function patch(server: ExternalServer, body: Record<string, unknown>, message: string) {
    setBusy(server.id);
    setError("");
    const { ok, data } = await api<{ server?: ExternalServer; error?: string }>(
      `/api/integrations/mcp-servers/${server.id}`,
      { body: JSON.stringify(body), method: "PATCH" },
    );
    setBusy(null);
    if (!ok) {
      setError(data.error === "url_not_allowed" ? "این دامنه در فهرست مجاز نیست." : "ذخیره ناموفق بود.");
      return;
    }
    setNotice(message);
    await load();
  }

  async function test(server: ExternalServer) {
    setBusy(server.id);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ server?: ExternalServer; error?: string }>(
      `/api/integrations/mcp-servers/${server.id}/test`,
      { method: "POST" },
    );
    setBusy(null);
    if (!ok || !data.server) {
      setError(
        data.error === "discovery_failed"
          ? "اتصال برقرار نشد. نشانی، دسترسی شبکه و کلید را بررسی کنید."
          : "تست اتصال ناموفق بود.",
      );
      await load();
      return;
    }
    setNotice(`اتصال برقرار شد؛ ${data.server.discoveredTools.length} ابزار یافت شد.`);
    await load();
  }

  async function remove(server: ExternalServer) {
    setBusy(server.id);
    const { ok } = await api(`/api/integrations/mcp-servers/${server.id}`, { method: "DELETE" });
    setBusy(null);
    if (!ok) {
      setError("حذف ناموفق بود.");
      return;
    }
    setNotice("سرور حذف شد.");
    await load();
  }

  async function loadCalls(server: ExternalServer) {
    const { ok, data } = await api<{ calls?: ExternalCall[] }>(
      `/api/integrations/mcp-servers/${server.id}/calls?limit=10`,
    );
    if (ok) setCalls((current) => ({ ...current, [server.id]: data.calls ?? [] }));
  }

  async function toggleTool(server: ExternalServer, tool: string, checked: boolean) {
    // An empty allowlist means "every discovered tool". Ticking the first box turns
    // the empty list into an explicit set, so the rest become denied — which is the
    // narrowing an operator asked for by touching it.
    const next = checked
      ? [...new Set([...server.allowedTools, tool])]
      : server.allowedTools.filter((entry) => entry !== tool);
    await patch(server, { allowedTools: next }, "فهرست ابزارها ذخیره شد.");
  }

  return (
    <SectionCard
      title="سرورهای MCP خارجی"
      description="دستیار شما می‌تواند ابزارهای یک سرور MCP دیگر (مثلاً مدیریت محتوای سایت) را صدا بزند. اتصال فقط پس از افزودن دامنه در فهرست مجاز سامانه برقرار می‌شود."
    >
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      <div className="mb-6 grid gap-3 rounded-xl border border-border p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span>شناسه (فقط حروف کوچک و خط تیره)</span>
            <input
              className={inputClass}
              value={draft.slug}
              onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
              placeholder="eshobe-cms"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>نام نمایشی</span>
            <input
              className={inputClass}
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              placeholder="سایت شرکت"
            />
          </label>
        </div>
        <label className="grid gap-1 text-sm">
          <span>نشانی سرور MCP</span>
          <input
            className={inputClass}
            dir="ltr"
            value={draft.url}
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            placeholder="https://cms.example.com/api/mcp"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span>نوع احراز هویت</span>
            <select
              className={inputClass}
              value={draft.authKind}
              onChange={(event) =>
                setDraft({ ...draft, authKind: event.target.value === "none" ? "none" : "bearer" })
              }
            >
              <option value="bearer">کلید دسترسی (Bearer)</option>
              <option value="none">بدون کلید</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span>کلید دسترسی</span>
            <input
              className={inputClass}
              dir="ltr"
              type="password"
              value={draft.bearerToken}
              disabled={draft.authKind === "none"}
              onChange={(event) => setDraft({ ...draft, bearerToken: event.target.value })}
              placeholder="فقط یک بار ذخیره می‌شود"
            />
          </label>
        </div>
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            <span>فعال باشد</span>
          </label>
          <Button
            disabled={busy === "create" || !draft.slug || !draft.label || !draft.url}
            onClick={() => void create()}
          >
            افزودن سرور
          </Button>
        </div>
      </div>

      {loading ? <p className="text-sm text-muted-foreground">در حال دریافت…</p> : null}
      {!loading && servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">هنوز سروری ثبت نشده است.</p>
      ) : null}

      <div className="grid gap-4">
        {servers.map((server) => (
          <div key={server.id} className="rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {server.label}{" "}
                  <span className="text-muted-foreground" dir="ltr">
                    ({server.slug})
                  </span>
                </p>
                <p className="truncate text-xs text-muted-foreground" dir="ltr">
                  {server.url}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge tone={server.enabled ? "active" : "neutral"}>
                  {server.enabled ? "فعال" : "غیرفعال"}
                </StatusBadge>
                <StatusBadge tone={server.authKind === "bearer" ? "positive" : "neutral"}>
                  {server.authKind === "bearer" ? "با کلید" : "بدون کلید"}
                </StatusBadge>
              </div>
            </div>

            <dl className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
              <div>
                <dt>آخرین بررسی</dt>
                <dd>{formatWhen(server.lastDiscoveredAt)}</dd>
              </div>
              <div>
                <dt>ابزارهای یافت‌شده</dt>
                <dd>{server.discoveredTools.length.toLocaleString("fa-IR")}</dd>
              </div>
              <div>
                <dt>خطای آخر</dt>
                <dd dir="auto">{server.lastError ?? "—"}</dd>
              </div>
            </dl>

            {server.discoveredTools.length > 0 ? (
              <div className="mt-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  ابزارهای مجاز (اگر هیچ‌کدام تیک نخورد، همهٔ ابزارها مجازند):
                </p>
                <div className="grid gap-1 sm:grid-cols-2">
                  {server.discoveredTools.map((tool) => {
                    const checked =
                      server.allowedTools.length === 0 || server.allowedTools.includes(tool.name);
                    return (
                      <label key={tool.name} className="flex items-center gap-2 text-xs" dir="ltr">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy === server.id}
                          onChange={(event) => void toggleTool(server, tool.name, event.target.checked)}
                        />
                        <span className="truncate">{tool.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={busy === server.id}
                onClick={() => void test(server)}
              >
                تست اتصال
              </Button>
              <Button
                variant="outline"
                disabled={busy === server.id}
                onClick={() =>
                  void patch(
                    server,
                    { enabled: !server.enabled },
                    server.enabled ? "سرور غیرفعال شد." : "سرور فعال شد.",
                  )
                }
              >
                {server.enabled ? "غیرفعال کردن" : "فعال کردن"}
              </Button>
              <Button
                variant="outline"
                disabled={busy === server.id}
                onClick={() => void loadCalls(server)}
              >
                آخرین فراخوانی‌ها
              </Button>
              <Button
                variant="outline"
                disabled={busy === server.id}
                onClick={() => void remove(server)}
              >
                حذف
              </Button>
            </div>

            {calls[server.id]?.length ? (
              <ul className="mt-3 grid gap-1 text-xs" dir="ltr">
                {calls[server.id]!.map((call) => (
                  <li key={call.id} className="flex items-center gap-2 text-muted-foreground">
                    <span>{formatWhen(call.createdAt)}</span>
                    <span>{call.toolName}</span>
                    <span>{call.status}</span>
                    <span>{call.durationMs === null ? "" : `${call.durationMs}ms`}</span>
                    {call.errorCode ? <span>{call.errorCode}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
