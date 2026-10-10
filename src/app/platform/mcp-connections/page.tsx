"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlatformCapability } from "@/lib/platform-admin";
import {
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  SkeletonRows,
  api,
  errorMessage,
  fmtDate,
  inputClass,
  selectClass,
} from "../ui";

interface Connection {
  id: string;
  adminId: string;
  adminName: string;
  adminRole: string;
  name: string;
  capabilities: PlatformCapability[];
  businessIds: string[] | null;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface ToolRow {
  name: string;
  capability: PlatformCapability;
  description: string;
  bridged: boolean;
}

const CAPABILITY_LABELS: Record<string, string> = {
  "businesses.read": "خواندن فهرست کسب‌وکارها",
  "business.reports.read": "خواندن گزارش‌های یک کسب‌وکار",
  "features.write": "تغییر پرچم‌های ویژگی",
  "business.suspend": "تعلیق / فعال‌سازی کسب‌وکار",
  "admins.manage": "مدیریت مدیران - فقط برای این صفحه",
};

/**
 * Console MCP credentials (issue #883 wave 3). A machine token for the
 * console's business directory and lifecycle operations, visible to a
 * platform owner only; every call is per-tool capability-gated live and one
 * row per call lands in platform_audit_log.
 */
export default function PlatformMcpConnectionsPage() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [caps, setCaps] = useState<Set<string>>(new Set(["businesses.read"]));
  const [bizIds, setBizIds] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("90");
  const [token, setToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{
      connections: Connection[];
      tools: ToolRow[];
      canManage: boolean;
      error?: string;
    }>("/api/platform/mcp-connections");
    if (!ok) {
      setError(errorMessage(data.error));
      setConnections([]);
      return;
    }
    setConnections(data.connections);
    setTools(data.tools);
    setCanManage(data.canManage);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mint() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const ids = bizIds
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const { ok, data } = await api<{ connection?: Connection; token?: string; error?: string }>(
      "/api/platform/mcp-connections",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          capabilities: [...caps],
          businessIds: ids.length > 0 ? ids : null,
          expiresInDays: expiresInDays ? Number(expiresInDays) : null,
        }),
      },
    );
    setBusy(false);
    if (!ok || !data.token) {
      setError(errorMessage(data.error));
      return;
    }
    setToken(data.token);
    setName("");
    setNotice("توکن ساخته شد — همین‌بار آن را در جای امنی ذخیره کنید؛ دوباره نمایش داده نمی‌شود.");
    await load();
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ ok?: boolean; error?: string }>(
      `/api/platform/mcp-connections?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("اتصال باطل شد — روی نخستین فراخوانی بعدی قطع می‌شود.");
    await load();
  }

  if (connections === null) {
    return (
      <Card title="اتصال‌های MCP کنسول">
        <SkeletonRows rows={4} />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      {token ? (
        <div className="rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 p-4 text-sm">
          <p className="font-semibold text-amber-900 dark:text-amber-200">توکن فقط همین‌بار دیده می‌شود:</p>
          <code dir="ltr" className="mt-2 block select-all break-all rounded-lg bg-white/70 p-2 font-mono">
            {token}
          </code>
          <Button className="mt-2" onClick={() => { void navigator.clipboard.writeText(token).catch(() => undefined); setToken(null); }}>
            کپی و بستن
          </Button>
        </div>
      ) : null}

      {canManage ? (
        <Card title="ساخت توکن برای یک مدیر">
          <p className="mb-3 text-xs leading-5 text-muted-foreground">
            توکن با هویت خودمان صادر می‌شود و هر فراخوانی با همان هویت در رویدادهای سکو ثبت می‌شود.
            ابزارها فقط وقتی کار می‌کنند که همان توانایی را نقش فعلی مدیر نیز داشته باشد — کم‌شدن نقش،
            توکن را هم کم‌قدرت می‌کند.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="نام اتصال">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً Codex عملیات" />
            </Field>
            <Field label="مدت اعتبار (روز، خالی = دائمی)">
              <input className={inputClass} dir="ltr" inputMode="numeric" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} />
            </Field>
          </div>
          <Field label="توانایی‌ها">
            <div className="flex flex-wrap gap-3">
              {tools.map((tool) => (
                <label key={tool.capability} className="flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={caps.has(tool.capability)}
                    onChange={() =>
                      setCaps((current) => {
                        const next = new Set(current);
                        if (next.has(tool.capability)) next.delete(tool.capability);
                        else next.add(tool.capability);
                        return next;
                      })
                    }
                  />
                  <span title={tool.description}>
                    {CAPABILITY_LABELS[tool.capability] ?? tool.capability}
                    {tool.bridged ? " (بین‌کسب‌وکاری)" : ""}
                  </span>
                </label>
              ))}
            </div>
          </Field>
          <Field label='محدودهٔ کسب‌وکارها (شناسه‌ها با فاصله/کاما؛ خالی = کل سکو)'>
            <input
              className={inputClass}
              dir="ltr"
              value={bizIds}
              onChange={(e) => setBizIds(e.target.value)}
              placeholder="uuid uuid …"
            />
          </Field>
          <Button onClick={() => void mint()} disabled={busy || !name.trim() || caps.size === 0}>
            ساخت توکن
          </Button>
        </Card>
      ) : (
        <InfoBox>فقط مالک سکو می‌تواند توکن‌های MCP کنسول بسازد یا باطل کند.</InfoBox>
      )}

      <Card title={`اتصال‌ها (${connections.length.toLocaleString("fa-IR")})`}>
        {connections.length === 0 ? (
          <EmptyState title="هنوز توکن MCP کنسول ساخته نشده است" />
        ) : (
          <ul className="space-y-3">
            {connections.map((c) => (
              <li key={c.id} className="rounded-xl border border-border/60 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">{c.name}</span>
                    <span className="ms-2 text-xs text-muted-foreground">
                      {c.adminName} ({c.adminRole})
                    </span>
                  </div>
                  {c.status === "active" && canManage ? (
                    <Button variant="ghost" className="text-destructive" disabled={busy} onClick={() => void revoke(c.id)}>
                      باطل‌کردن
                    </Button>
                  ) : (
                    c.status === "revoked" && <span className="text-xs text-muted-foreground">باطل‌شده</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {c.capabilities.map((cap) => (
                    <span key={cap} className="rounded bg-muted px-2 py-0.5">
                      {CAPABILITY_LABELS[cap] ?? cap}
                    </span>
                  ))}
                  <span className="rounded bg-muted px-2 py-0.5">
                    {c.businessIds === null ? "کل سکو" : `${c.businessIds.length.toLocaleString("fa-IR")} کسب‌وکار`}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>ساخت: {fmtDate(c.createdAt)}</span>
                  <span>آخرین استفاده: {c.lastUsedAt ? fmtDate(c.lastUsedAt) : "—"}</span>
                  <span>انقضا: {c.expiresAt ? fmtDate(c.expiresAt) : "ندارد"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="ابزارها">
        <select className={selectClass} disabled defaultValue="info">
          <option value="info">مرجع ابزارهای در دسترس</option>
        </select>
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {tools.map((tool) => (
            <li key={tool.name}>
              <code dir="ltr">{tool.name}</code> — {tool.description}{" "}
              <span className="text-muted-foreground/70">({tool.capability})</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
