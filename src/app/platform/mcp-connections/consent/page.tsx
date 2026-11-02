"use client";

/**
 * The console-side consent screen of the platform MCP OAuth flow — the
 * superadmin twin of the tenant `/mcp/consent` page.
 *
 * An AI client that connected from the console's MCP address alone lands here
 * through `/api/platform/mcp/oauth/authorize`. The admin sees WHO is asking and
 * where the answer goes, then decides what to grant: which capabilities, which
 * businesses, for how long. What the client asked for is irrelevant — only this
 * form decides, and the server re-filters it against the admin's current role.
 */
import { useEffect, useMemo, useState } from "react";
import { platformCapabilityLabel, POWERFUL_PLATFORM_CAPABILITIES } from "../capability-labels";
import { Button, Card, ErrorBox, Field, InfoBox, SkeletonRows, api, errorMessage, inputClass } from "../../ui";

interface ConsentInfo {
  clientName: string;
  redirectHost: string;
  canManage: boolean;
  grantable: string[];
  defaultExpiresInDays: number;
  maxExpiresInDays: number;
}

interface RequestParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
}

function readParams(): RequestParams {
  const q = new URLSearchParams(window.location.search);
  return {
    clientId: q.get("client_id") ?? "",
    redirectUri: q.get("redirect_uri") ?? "",
    codeChallenge: q.get("code_challenge") ?? "",
    state: q.get("state"),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PlatformMcpConsentPage() {
  const [params, setParams] = useState<RequestParams | null>(null);
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [businessText, setBusinessText] = useState("");
  const [days, setDays] = useState("");

  useEffect(() => {
    const p = readParams();
    setParams(p);
    (async () => {
      const qs = new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri });
      const { ok, data } = await api<ConsentInfo & { error?: string }>(
        `/api/platform/mcp-connections/consent?${qs.toString()}`,
      );
      if (!ok) {
        setError(data.error === "invalid_client" ? "درخواست اتصال نامعتبر است؛ از ابزار هوش مصنوعی دوباره شروع کنید." : errorMessage(data.error));
        return;
      }
      setInfo(data);
      setName(data.clientName);
      setDays(String(data.defaultExpiresInDays));
    })();
  }, []);

  const powerful = useMemo(
    () => [...selected].filter((c) => POWERFUL_PLATFORM_CAPABILITIES.has(c)),
    [selected],
  );

  function toggle(capability: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(capability)) next.delete(capability);
      else next.add(capability);
      return next;
    });
  }

  async function decide(deny: boolean) {
    if (!params || !info) return;
    const businessIds = businessText
      .split(/[\s,،]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!deny) {
      if (selected.size === 0) return setError("دست‌کم یک دسترسی را انتخاب کنید.");
      if (businessIds.some((id) => !UUID.test(id))) return setError("شناسهٔ کسب‌وکارها باید UUID معتبر باشد.");
    }
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ redirectTo?: string; error?: string }>(
      "/api/platform/mcp-connections/consent",
      {
        method: "POST",
        body: JSON.stringify({
          ...params,
          deny,
          connectionName: name.trim() || info.clientName,
          capabilities: [...selected],
          businessIds,
          expiresInDays: Number(days) || info.defaultExpiresInDays,
        }),
      },
    );
    if (!ok || !data.redirectTo) {
      setBusy(false);
      setError(errorMessage(data.error));
      return;
    }
    window.location.assign(data.redirectTo);
  }

  if (!info) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        {error ? <ErrorBox>{error}</ErrorBox> : <SkeletonRows rows={3} label="در حال بارگذاری درخواست اتصال" />}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <h1 className="text-lg font-semibold text-foreground">اتصال یک دستیار هوش مصنوعی به کنسول</h1>
      <Card>
        <p className="text-sm text-foreground">
          «{info.clientName}» می‌خواهد به کنسول سکو وصل شود. پس از تأیید، نتیجه به{" "}
          <span dir="ltr" className="font-mono">{info.redirectHost}</span> فرستاده می‌شود.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          فقط همین فرم تعیین می‌کند چه دسترسی‌هایی داده شود؛ هر فراخوانی با نقش فعلی شما دوباره بررسی می‌شود.
        </p>
      </Card>

      {!info.canManage ? (
        <InfoBox>برای اتصال دستیار به کنسول باید مالک سکو باشید (دسترسی «مدیریت مدیران»).</InfoBox>
      ) : null}
      <ErrorBox>{error}</ErrorBox>

      <Card title="دسترسی‌ها">
        <div className="grid gap-2 sm:grid-cols-2">
          {info.grantable.map((capability) => (
            <label key={capability} className="flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(capability)}
                disabled={busy || !info.canManage}
                onChange={() => toggle(capability)}
              />
              <span>
                {platformCapabilityLabel(capability)}
                {POWERFUL_PLATFORM_CAPABILITIES.has(capability) ? (
                  <span className="ms-1 text-xs text-destructive">(حساس)</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
        {powerful.length > 0 ? (
          <p className="mt-3 text-xs text-destructive">
            دسترسی‌های حساس انتخاب شده‌اند ({powerful.map(platformCapabilityLabel).join("، ")}). این اتصال می‌تواند
            روی کسب‌وکارها اثر بگذارد؛ فقط به ابزار مورد اعتماد بدهید.
          </p>
        ) : null}
      </Card>

      <Card title="دامنه و مدت">
        <Field label="نام اتصال">
          <input className={inputClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="محدود به این کسب‌وکارها (اختیاری)"
          hint="شناسه‌ها را با ویرگول یا فاصله جدا کنید؛ خالی یعنی همهٔ کسب‌وکارها."
        >
          <textarea
            dir="ltr"
            className={`${inputClass} h-20 py-2 font-mono`}
            value={businessText}
            onChange={(e) => setBusinessText(e.target.value)}
          />
        </Field>
        <Field label={`مدت اعتبار اتصال (روز، حداکثر ${info.maxExpiresInDays})`}>
          <input
            dir="ltr"
            inputMode="numeric"
            className={inputClass}
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))}
          />
        </Field>
      </Card>

      <div className="flex gap-2">
        <Button disabled={busy || !info.canManage} onClick={() => void decide(false)}>
          {busy ? "در حال ثبت…" : "اجازه می‌دهم"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void decide(true)}>
          رد درخواست
        </Button>
      </div>
    </div>
  );
}
