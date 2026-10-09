"use client";

/**
 * The business workspace's panels, split out of the old single-page console
 * view so each section page composes two or three of them instead of one
 * thousand-line scroll. Every panel reads (and saves through) the shared
 * `useBusiness()` context, so a write in one section refreshes the identity
 * header and the sidebar without a remount.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatPersianNumber } from "@/lib/digits";
import { validateSubdomain } from "@/lib/slug";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import { businessDestructivePhrase } from "@/lib/platform-admin";
import {
  api,
  errorMessage,
  ErrorBox,
  InfoBox,
  Field,
  Button,
  Card,
  inputClass,
  useCan,
  SkeletonRows,
} from "../../ui";
import { IndustryPicker } from "../../industry-picker";
import { useBusiness, type Business } from "./context";

/**
 * Name + timezone. The workspace header shows who this is; this card is the
 * ordinary metadata edit — deliberately kept separate from subdomain and
 * industry, which each carry their own confirmation and side effects.
 */
export function BusinessDetailsPanel() {
  const { business, reload } = useBusiness();
  const can = useCan();
  const editable = can("business.edit");
  const [name, setName] = useState(business?.name ?? "");
  const [timezone, setTimezone] = useState(business?.timezone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!business) return;
    setName(business.name);
    setTimezone(business.timezone);
  }, [business]);

  if (!business) return null;
  const changed = name.trim() !== business.name || timezone.trim() !== business.timezone;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim(), timezone: timezone.trim() }),
    });
    setBusy(false);
    if (ok) {
      setSaved(true);
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="ویرایش کسب‌وکار">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>اطلاعات کسب‌وکار ذخیره شد.</InfoBox> : null}
      <form onSubmit={save} className="grid gap-x-4 sm:grid-cols-2">
        <Field label="نام کسب‌وکار">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!editable}
            className={inputClass}
          />
        </Field>
        <Field label="منطقهٔ زمانی" hint="مانند Asia/Tehran">
          <input
            required
            dir="ltr"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={!editable}
            className={inputClass}
          />
        </Field>
        <div className="mb-4 min-w-0">
          <p className="mb-1 text-sm font-medium text-foreground">شناسهٔ کسب‌وکار</p>
          <p
            className="break-all rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground"
            dir="ltr"
          >
            {business.slug}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">این شناسه برای پایداری ارجاع‌ها تغییر نمی‌کند.</p>
        </div>
        {editable ? (
          <div className="mb-4 flex items-end sm:justify-end">
            <Button type="submit" disabled={busy || !changed} className="w-full sm:w-auto">
              {busy ? "در حال ذخیره…" : "ذخیرهٔ تغییرات"}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

/**
 * Phase 25 Wave 1 — change which industry a business operates in.
 *
 * Migration 0048 made `industry` immutable *by omission*: no update route
 * existed, because the chart of accounts is seeded from it at creation and
 * there was no way to reconcile a switch. This panel is the deliberate
 * reversal of that, so a mis-provisioned tenant does not need a factory reset.
 *
 * What it cannot do is rewrite history, and it says so rather than implying
 * otherwise: seeding is additive, the old industry's rows stay in place but
 * become unreachable, and the counts below are the server's real numbers so
 * the admin confirms against facts instead of a generic warning.
 */
export function IndustryPanel() {
  const { business, industryCounts, reload } = useBusiness();
  const can = useCan();
  const editable = can("business.edit");
  const [industry, setIndustry] = useState<Industry>(business?.industry ?? "food_service");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSaved(null);
    if (business) setIndustry(business.industry);
  }, [business]);

  if (!business) return null;
  const changed = industry !== business.industry;
  const counts = industryCounts;
  const carried = counts
    ? [
        { label: "آیتم منو", value: counts.menuItems },
        { label: "کالای صنفی", value: counts.industryItems },
        { label: "سفارش", value: counts.orders },
        { label: "سند حسابداری", value: counts.journalEntries },
      ].filter((c) => c.value > 0)
    : [];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const warning =
      carried.length > 0
        ? "\n\nاین کسب‌وکار داده‌ای دارد که به نوع فعلی تعلق دارد:\n" +
          carried.map((c) => `• ${c.label}: ${formatPersianNumber(c.value)}`).join("\n") +
          "\n\nاین داده‌ها حذف نمی‌شوند، اما پس از تغییر نوع، دیگر از داشبورد در دسترس نخواهند بود. " +
          "سرفصل‌های حساب موجود هم دست‌نخورده می‌مانند و فقط حساب‌های نبودهٔ نوع جدید اضافه می‌شوند."
        : "";
    if (
      !window.confirm(
        `نوع «${business!.name}» از «${INDUSTRY_LABELS[business!.industry]}» به «${INDUSTRY_LABELS[industry]}» تغییر کند؟` +
          warning,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    const { ok, data } = await api<{ seededAccountCodes?: string[]; error?: string }>(
      `/api/platform/businesses/${business!.id}`,
      { method: "PATCH", body: JSON.stringify({ industry }) },
    );
    setBusy(false);
    if (ok) {
      const seeded = data.seededAccountCodes?.length ?? 0;
      setSaved(
        seeded > 0
          ? `نوع کسب‌وکار تغییر کرد و ${formatPersianNumber(seeded)} سرفصل حساب جدید اضافه شد.`
          : "نوع کسب‌وکار تغییر کرد. سرفصل حساب جدیدی لازم نبود.",
      );
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="نوع کسب‌وکار">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>{saved}</InfoBox> : null}
      <form onSubmit={save}>
        <p className="mb-3 text-sm text-muted-foreground">
          نوع فعلی:{" "}
          <span className="font-medium text-foreground">{INDUSTRY_LABELS[business.industry]}</span>
        </p>
        <IndustryPicker value={industry} onChange={setIndustry} disabled={!editable || busy} />
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          نوع کسب‌وکار تعیین می‌کند چه سرفصل حساب‌هایی ساخته می‌شود، مالک چه مراحلی از راه‌اندازی را
          می‌بیند، و داشبورد کدام ماژول‌ها را نشان می‌دهد.
        </p>
        {changed && carried.length > 0 ? (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2.5 text-xs leading-6 text-amber-800/90 dark:text-amber-200/90">
            <p className="font-medium">این کسب‌وکار داده‌ای دارد که به نوع فعلی تعلق دارد:</p>
            <ul className="mt-1 space-y-0.5">
              {carried.map((c) => (
                <li key={c.label}>
                  {c.label}: {formatPersianNumber(c.value)}
                </li>
              ))}
            </ul>
            <p className="mt-1.5">
              چیزی حذف نمی‌شود؛ اما این داده‌ها پس از تغییر از داشبورد در دسترس نخواهند بود.
            </p>
          </div>
        ) : null}
        {editable ? (
          <div className="mt-4">
            <Button type="submit" disabled={busy || !changed}>
              {busy ? "در حال تغییر…" : "تغییر نوع کسب‌وکار"}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

/**
 * Phase 23 — the business's public host.
 *
 * Renaming an origin is not an ordinary metadata edit: it writes the old name
 * into `business_subdomain_aliases` so existing links keep resolving, and it
 * invalidates every live session on the old host. The admin is told that
 * before they confirm, not after.
 */
export function SubdomainPanel() {
  const { business, rootDomain, aliases, reload } = useBusiness();
  const can = useCan();
  const editable = can("business.edit");
  const [subdomain, setSubdomain] = useState(business?.subdomain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (business) setSubdomain(business.subdomain);
    setSaved(false);
  }, [business]);

  if (!business) return null;
  const trimmed = subdomain.trim().toLowerCase();
  const invalid = trimmed ? validateSubdomain(trimmed) : "invalid_subdomain";
  const changed = trimmed !== business.subdomain.toLowerCase();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (
      !window.confirm(
        `نشانی این کسب‌وکار به «${trimmed}» تغییر کند؟\n\n` +
          "نشانی قبلی همچنان به نشانی جدید هدایت می‌شود، اما نشست‌های بازِ کاربران روی نشانی قبلی " +
          "باطل می‌شود و باید دوباره وارد شوند.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ subdomain: trimmed }),
    });
    setBusy(false);
    if (ok) {
      setSaved(true);
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="نشانی اینترنتی">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>نشانی تغییر کرد. نشانی قبلی به نشانی جدید هدایت می‌شود.</InfoBox> : null}
      <form onSubmit={save}>
        <Field
          label="زیردامنه"
          hint={
            invalid ? undefined : rootDomain
              ? `https://${trimmed}.${rootDomain}`
              : "فقط حروف انگلیسی کوچک، رقم و خط تیره."
          }
        >
          <input
            dir="ltr"
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value)}
            disabled={!editable}
            className={`${inputClass} text-start`}
          />
          {invalid && changed ? (
            <span className="mt-1 block text-xs text-rose-700 dark:text-rose-300">{errorMessage(invalid)}</span>
          ) : null}
        </Field>

        {aliases.length > 0 ? (
          <div className="mb-4">
            <p className="mb-1 text-sm font-medium text-foreground">نشانی‌های قبلی</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {aliases.map((a) => (
                <li key={a.alias} dir="ltr">
                  {rootDomain ? `${a.alias}.${rootDomain}` : a.alias}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">
              این نشانی‌ها همچنان کار می‌کنند و به نشانی فعلی هدایت می‌شوند.
            </p>
          </div>
        ) : null}

        {editable ? (
          <Button type="submit" disabled={busy || !changed || Boolean(invalid)}>
            {busy ? "در حال تغییر…" : "تغییر نشانی"}
          </Button>
        ) : null}
      </form>
    </Card>
  );
}

interface Feature {
  key: string;
  name: string;
  description: string | null;
  defaultEnabled: boolean;
  override: boolean | null;
  effective: boolean;
}

/**
 * What the API answers after the `ai_assistant` flag changes — the runtime's
 * real readiness, computed from the resolved gateway/model/key configuration.
 * "AI is enabled" is an entitlement; "AI is operational" is this object.
 */
interface AiReadiness {
  ready: boolean;
  reason: string | null;
  gatewayReady: boolean;
  authenticationReady: boolean;
  virtualKeyRequired: boolean;
  virtualKeyReady: boolean;
  modelReady: boolean;
}

const AI_READINESS_REASONS: Record<string, string> = {
  platform_disabled: "دستیار در سطح سکو خاموش است",
  gateway_disabled: "درگاه LiteLLM غیرفعال است",
  missing_base_url: "نشانی درگاه تنظیم نشده است",
  invalid_base_url: "نشانی درگاه معتبر نیست",
  missing_runtime_credential: "کلید دسترسی درگاه تنظیم نشده است",
  tenant_virtual_key_missing: "کلید مجازی این کسب‌وکار صادر نشده است",
  missing_model: "مدل پیش‌فرض انتخاب نشده است",
  invalid_max_output_tokens: "سقف توکن خروجی معتبر نیست",
  configuration_load_failed: "تنظیمات بارگذاری نشد",
};

export function FeaturesPanel() {
  const { business, version } = useBusiness();
  const can = useCan();
  const editable = can("features.write");
  const [features, setFeatures] = useState<Feature[] | null>(null);
  // Discarded before: the API computed readiness on every ai_assistant change
  // and the UI threw it away, so an operator could switch AI on and reasonably
  // believe the assistant now worked.
  const [aiReadiness, setAiReadiness] = useState<AiReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!business) return;
    const { ok, data } = await api<{ features: Feature[]; error?: string }>(
      `/api/platform/businesses/${business.id}/features`,
    );
    if (ok) setFeatures(data.features);
    else setError(errorMessage(data.error));
  }, [business]);

  useEffect(() => {
    void load();
  }, [load, version]);

  if (!business) return null;
  const bizId = business.id;

  async function setOverride(flagKey: string, enabled: boolean | null) {
    setPending(flagKey);
    setError(null);
    const { ok, data } = await api<{
      features: Feature[];
      aiReadiness?: AiReadiness;
      error?: string;
    }>(`/api/platform/businesses/${bizId}/features`, {
      method: "PATCH",
      body: JSON.stringify({ flagKey, enabled }),
    });
    setPending(null);
    if (ok) {
      setFeatures(data.features);
      if (data.aiReadiness) setAiReadiness(data.aiReadiness);
    } else {
      setError(errorMessage(data.error));
    }
  }

  const aiFlag = features?.find((f) => f.key === "ai_assistant") ?? null;

  return (
    <>
    <Card title="پرچم‌های ویژگی">
      <ErrorBox>{error}</ErrorBox>
      {features === null ? (
        <SkeletonRows rows={3} />
      ) : features.length === 0 ? (
        <p className="text-sm text-muted-foreground">پرچمی تعریف نشده است.</p>
      ) : (
        <div className="space-y-2">
          {features.map((f) => (
            <div
              key={f.key}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{f.name}</p>
                {f.description ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{f.description}</p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                  {f.key}
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
                <span
                  className={
                    f.effective
                      ? "rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
                      : "rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  }
                >
                  {f.effective ? "فعال" : "غیرفعال"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {f.override === null
                    ? `پیش‌فرض (${f.defaultEnabled ? "روشن" : "خاموش"})`
                    : "بازنویسی‌شده"}
                </span>
                {editable ? (
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      disabled={pending === f.key}
                      onClick={() => setOverride(f.key, true)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      روشن
                    </button>
                    <button
                      type="button"
                      disabled={pending === f.key}
                      onClick={() => setOverride(f.key, false)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      خاموش
                    </button>
                    <button
                      type="button"
                      disabled={pending === f.key || f.override === null}
                      onClick={() => setOverride(f.key, null)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      پیش‌فرض
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>

    {/*
      The flag says "entitled", this says "actually working". Rendered only
      after an `ai_assistant` change, because that is when the API computes it.
      A future grant may split AI enablement from runtime configuration; until
      then the honest reading is: enabled ≠ operational.
    */}
    {aiReadiness && aiFlag ? (
      <Card title="آمادگی اجرای هوش مصنوعی">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              aiFlag.effective
                ? "rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
                : "rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            }
          >
            ویژگی: {aiFlag.effective ? "فعال" : "غیرفعال"}
          </span>
          <span
            className={
              aiReadiness.ready
                ? "rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
                : "rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300"
            }
          >
            اجرا: {aiReadiness.ready ? "آماده" : "آماده نیست"}
          </span>
        </div>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">کلید مجازی کسب‌وکار</dt>
            <dd>{aiReadiness.virtualKeyReady ? "موجود" : aiReadiness.virtualKeyRequired ? "صادر نشده" : "لازم نیست"}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">مدل / مسیر</dt>
            <dd>{aiReadiness.modelReady ? "آماده" : "تنظیم نشده"}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">درگاه</dt>
            <dd>{aiReadiness.gatewayReady ? "آماده" : "غیرفعال یا ناقص"}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">احراز هویت درگاه</dt>
            <dd>{aiReadiness.authenticationReady ? "آماده" : "ناقص"}</dd>
          </div>
        </dl>
        {!aiReadiness.ready ? (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-900 dark:text-amber-100">
            <p>
              {aiReadiness.reason
                ? (AI_READINESS_REASONS[aiReadiness.reason] ?? aiReadiness.reason)
                : "پیکربندی اجرا کامل نیست."}
            </p>
            {can("ai.config.manage") ? (
              <p className="mt-1 text-xs">
                پیکربندی فنی در{" "}
                <Link href="/platform/ai" className="underline">
                  تنظیمات هوش مصنوعی سکو
                </Link>{" "}
                انجام می‌شود؛ این بخش فقط وضعیت را گزارش می‌کند.
              </p>
            ) : (
              <p className="mt-1 text-xs">برای تکمیل پیکربندی با تیم فنی سکو تماس بگیرید.</p>
            )}
          </div>
        ) : null}
      </Card>
    ) : null}
    </>
  );
}

interface Grant {
  id: string;
  platformAdminId: string;
  operatorName: string | null;
  operatorRole: string | null;
  mode: "read_only" | "controlled" | "full" | "emergency";
  reason: string;
  ticketId: string | null;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  revokedAt: string | null;
  /** Computed by the API for the admin asking — the browser cannot know it. */
  isMine: boolean;
}

interface TicketOption { id: string; subject: string; status: string }

const MODE_LABELS: Record<Grant["mode"], string> = {
  read_only: "فقط خواندنی",
  controlled: "دسترسی محدود فنی",
  full: "دسترسی کامل",
  emergency: "دسترسی اضطراری",
};

export function ImpersonationPanel() {
  const { business, setNotice, version } = useBusiness();
  const can = useCan();
  const searchParams = useSearchParams();
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [tickets, setTickets] = useState<TicketOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [mode, setMode] = useState<"read_only" | "controlled" | "full">("read_only");
  const [minutes, setMinutes] = useState(30);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!business) return;
    const [grantResult, ticketResult] = await Promise.all([
      api<{ grants: Grant[]; error?: string }>(`/api/platform/impersonation?businessId=${business.id}`),
      api<{ tickets: TicketOption[] }>(`/api/platform/support/tickets?businessId=${business.id}&pageSize=100`),
    ]);
    if (grantResult.ok) setGrants(grantResult.data.grants);
    else setError(errorMessage(grantResult.data.error));
    if (ticketResult.ok) setTickets(ticketResult.data.tickets.filter((t) => !["closed", "resolved"].includes(t.status)));
  }, [business]);

  useEffect(() => { void load(); }, [load, version]);
  useEffect(() => {
    const linkedTicket = searchParams.get("ticketId");
    if (!linkedTicket) return;
    setTicketId(linkedTicket);
    const ticket = tickets.find((candidate) => candidate.id === linkedTicket);
    if (ticket && !reason) setReason(`تیکت پشتیبانی ${ticket.id.slice(0, 8)} — ${ticket.subject}`);
    setOpen(true);
  }, [reason, searchParams, tickets]);
  if (!business) return null;

  const isActive = (g: Grant) => !g.endedAt && !g.revokedAt && new Date(g.expiresAt).getTime() > Date.now();
  // Ownership, not "the first active row". A colleague's open session is shown
  // as theirs — never offered the controls that only make sense for one's own.
  const myActive = (grants ?? []).find((g) => isActive(g) && g.isMine) ?? null;
  const otherActive = (grants ?? []).find((g) => isActive(g) && !g.isMine) ?? null;

  /** Re-enter my own open session: a real handoff into the same grant. */
  async function resume(grant: Grant) {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ handoffUrl?: string; error?: string }>(
      `/api/platform/impersonation/${grant.id}/resume`,
      { method: "POST", body: JSON.stringify({ businessId: business!.id }) },
    );
    setBusy(false);
    if (ok) {
      window.location.href = data.handoffUrl ?? "/dashboard";
      return;
    }
    setError("ادامهٔ نشست ممکن نشد؛ ممکن است پایان یافته یا منقضی شده باشد.");
    void load();
  }

  async function enter() {
    if (reason.trim().length < 10) { setError("دلیل نشست باید دست‌کم ۱۰ نویسه و روشن باشد."); return; }
    setBusy(true); setError(null);
    const { ok, data } = await api<{ handoffUrl?: string; error?: string; code?: string }>(
      `/api/platform/businesses/${business!.id}/impersonate`,
      { method: "POST", body: JSON.stringify({ mode, reason: reason.trim(), ticketId: ticketId || undefined, minutes }) },
    );
    setBusy(false);
    if (ok) window.location.href = data.handoffUrl ?? "/dashboard";
    else if (data.code === "ACTIVE_SUPPORT_SESSION_EXISTS") setError("یک نشست فعال دارید؛ ابتدا همان نشست را ادامه دهید یا پایان دهید.");
    else setError(errorMessage(data.error));
  }

  async function closeGrant(grant: Grant, revoke: boolean) {
    setBusy(true); setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/impersonation/${grant.id}${revoke ? "?action=revoke" : ""}`, { method: "DELETE" });
    setBusy(false);
    if (ok) setNotice(revoke ? "نشست پشتیبانی لغو شد." : "نشست پشتیبانی پایان یافت.");
    else setError(errorMessage(data.error));
    void load();
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {myActive ? (
        <Card title="نشست پشتیبانی من">
          <SessionSummary grant={myActive} />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => void resume(myActive)} disabled={busy}>ادامه نشست من</Button>
            <Button variant="ghost" onClick={() => void closeGrant(myActive, false)} disabled={busy}>پایان نشست من</Button>
          </div>
        </Card>
      ) : null}

      {otherActive ? (
        <Card title="نشست فعال اپراتور دیگر">
          <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-900 dark:text-amber-100">
            این نشست به شما تعلق ندارد؛ فقط با دسترسی لغو می‌توانید آن را ببندید.
          </p>
          <SessionSummary grant={otherActive} />
          <div className="mt-4 flex flex-wrap gap-2">
            {can("impersonate.revoke") ? (
              <Button variant="danger" onClick={() => void closeGrant(otherActive, true)} disabled={busy}>
                لغو نشست این اپراتور
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">
                برای لغو نشست دیگری به دسترسی «لغو نشست پشتیبانی» نیاز است.
              </span>
            )}
          </div>
        </Card>
      ) : null}

      {!myActive && !otherActive ? (
        <Card title="شروع نشست پشتیبانی">
          <p className="mb-4 text-sm text-muted-foreground">دسترسی موقت، ثبت‌شده و قابل لغو است. حالت فقط‌خواندنی گزینهٔ پیش‌فرض است.</p>
          <Button onClick={() => setOpen(true)}>شروع نشست</Button>
        </Card>
      ) : null}

      {myActive ? (
        <p className="text-xs text-muted-foreground">
          تا پایان نشست فعلی نمی‌توانید نشست تازه‌ای بسازید؛ ابتدا آن را ادامه دهید یا پایان دهید.
        </p>
      ) : otherActive ? (
        <p className="text-xs text-muted-foreground">
          کسب‌وکار اشغال است؛ تا بسته شدن نشست اپراتور دیگر امکان ساخت نشست تازه نیست.
        </p>
      ) : null}

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle>شروع نشست پشتیبانی</DialogTitle><DialogDescription>کسب‌وکار: {business.name}</DialogDescription></DialogHeader>
            <div className="mt-4">
              <Field label="دلیل دسترسی" hint="الزامی؛ دست‌کم ۱۰ نویسه">
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} min-h-24 py-2`} placeholder="مثلاً: بررسی مشکل شناسایی نشدن چاپگر فاکتور" />
              </Field>
              <Field label="تیکت مرتبط">
                <select value={ticketId} onChange={(e) => setTicketId(e.target.value)} className={inputClass}>
                  <option value="">بدون تیکت</option>
                  {tickets.map((ticket) => <option key={ticket.id} value={ticket.id}>#{ticket.id.slice(0, 8)} — {ticket.subject}</option>)}
                </select>
              </Field>
              <Field label="سطح دسترسی">
                <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className={inputClass}>
                  {can("impersonate.readOnly") ? <option value="read_only">فقط خواندنی (پیشنهادی)</option> : null}
                  {can("impersonate.controlled") ? <option value="controlled">دسترسی محدود فنی</option> : null}
                  {can("impersonate.full") ? <option value="full">دسترسی کامل — پرخطر</option> : null}
                </select>
              </Field>
              <Field label="مدت">
                <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={inputClass}>
                  {[15, 30, 45, 60].map((value) => <option key={value} value={value}>{formatPersianNumber(value)} دقیقه</option>)}
                </select>
              </Field>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>انصراف</Button>
              <Button variant={mode === "full" ? "danger" : "primary"} onClick={() => void enter()} disabled={busy || reason.trim().length < 10}>{busy ? "در حال ایجاد…" : "ایجاد و ورود"}</Button>
            </div>
          </DialogContent>
      </Dialog>

      <Card title="تاریخچه نشست‌ها">
        {grants === null ? <SkeletonRows rows={4} /> : grants.length === 0 ? <p className="text-sm text-muted-foreground">نشستی ثبت نشده است.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead><tr className="border-b border-border text-right text-xs text-muted-foreground"><th className="p-2">وضعیت</th><th className="p-2">اپراتور</th><th className="p-2">دسترسی</th><th className="p-2">دلیل</th><th className="p-2">شروع</th><th className="p-2">پایان</th></tr></thead><tbody>{grants.map((g) => <tr key={g.id} className="border-b border-border/60"><td className="p-2">{isActive(g) ? (g.isMine ? "فعال (نشست من)" : "فعال (اپراتور دیگر)") : g.revokedAt ? "لغوشده" : g.endedAt ? "پایان‌یافته" : "منقضی"}</td><td className="p-2">{g.operatorName ?? "—"}</td><td className="p-2">{MODE_LABELS[g.mode]}</td><td className="max-w-xs truncate p-2">{g.reason}</td><td className="p-2">{new Date(g.createdAt).toLocaleString("fa-IR")}</td><td className="p-2">{g.endedAt ? new Date(g.endedAt).toLocaleString("fa-IR") : "—"}</td></tr>)}</tbody></table></div>
        )}
      </Card>
      <Card title="سیاست امنیتی پشتیبانی"><p className="text-sm leading-6 text-muted-foreground">هر نشست موقت است، شناسهٔ دقیق مجوز در هر درخواست دوباره بررسی می‌شود و تغییرات مجاز با هویت اپراتور ثبت می‌شوند. اطلاعات محرمانه و خروجی‌های حساس جزو دسترسی عادی پشتیبانی نیستند.</p></Card>
    </div>
  );
}

/** One session's facts, shared by the "mine" and "another operator's" cards. */
function SessionSummary({ grant }: { grant: Grant }) {
  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <p><span className="block text-xs text-muted-foreground">اپراتور</span>{grant.operatorName ?? "اپراتور پلتفرم"} · {grant.operatorRole ?? "—"}</p>
      <p><span className="block text-xs text-muted-foreground">نوع دسترسی</span>{MODE_LABELS[grant.mode]}</p>
      <p><span className="block text-xs text-muted-foreground">دلیل</span>{grant.reason}</p>
      <p><span className="block text-xs text-muted-foreground">تیکت مرتبط</span>{grant.ticketId ? `#${grant.ticketId.slice(0, 8)}` : "بدون تیکت"}</p>
      <p><span className="block text-xs text-muted-foreground">شروع</span>{new Date(grant.createdAt).toLocaleString("fa-IR")}</p>
      <p><span className="block text-xs text-muted-foreground">پایان خودکار</span>{new Date(grant.expiresAt).toLocaleString("fa-IR")}</p>
    </div>
  );
}

/**
 * The danger zone (issue #822). Two very different actions with one shared
 * confirmation pattern:
 *
 *  - Reset and delete each demand their OWN target-specific typed phrase —
 *    `RESET {slug}` vs `DELETE {slug}` — built by the same helper the server
 *    validates (`businessDestructivePhrase`), so the literal exists in
 *    exactly one place and a confirmation for one action or one tenant can
 *    never authorize the other.
 *  - No `window.confirm()`: each action opens a design-system dialog that
 *    shows the exact business, the consequences (what is removed, what
 *    survives), the typed confirmation, an explicit cancel, the loading
 *    state, and any API error — one confirmation system, final button labels
 *    we control.
 *  - The protected platform-internal business never renders actionable
 *    controls; the backend stays the final authority either way.
 */

/** What the dialog shows about the target, so it can never be ambiguous. */
function DestructiveTargetSummary({ business }: { business: Business }) {
  const { rootDomain } = useBusiness();
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <p>
        <span className="text-muted-foreground">کسب‌وکار: </span>
        <span className="font-semibold">{business.name}</span>
      </p>
      <p className="mt-1">
        <span className="text-muted-foreground">شناسه: </span>
        <span dir="ltr">{business.slug}</span>
      </p>
      <p className="mt-1">
        <span className="text-muted-foreground">نشانی: </span>
        <span dir="ltr">
          {rootDomain ? `${business.subdomain}.${rootDomain}` : business.subdomain}
        </span>
      </p>
    </div>
  );
}

interface DestructiveDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  busy: boolean;
  title: string;
  description: string;
  /** The exact phrase that must be typed, e.g. `RESET cafe-alpha`. */
  phrase: string;
  removed: string[];
  preserved: string[];
  actionLabel: string;
  busyLabel: string;
  error: string | null;
  business: Business;
  onConfirm: (confirmation: string) => void;
}

function DestructiveBusinessDialog({
  open,
  onOpenChange,
  busy,
  title,
  description,
  phrase,
  removed,
  preserved,
  actionLabel,
  busyLabel,
  error,
  business,
  onConfirm,
}: DestructiveDialogProps) {
  const [typed, setTyped] = useState("");
  // A re-opened dialog always starts unconfirmed.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const confirmed = typed.trim() === phrase;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DestructiveTargetSummary business={business} />

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-red-500/25 bg-red-500/8 p-3 text-red-900 dark:text-red-100">
            <p className="font-semibold">از بین می‌رود</p>
            <ul className="mt-2 list-disc space-y-1 ps-4 text-xs leading-5 text-red-900/80 dark:text-red-100/80">
              {removed.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          {preserved.length > 0 ? (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/8 p-3 text-emerald-900 dark:text-emerald-100">
              <p className="font-semibold">باقی می‌ماند</p>
              <ul className="mt-2 list-disc space-y-1 ps-4 text-xs leading-5 text-emerald-900/80 dark:text-emerald-100/80">
                {preserved.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <Field label={`برای تأیید، عبارت زیر را دقیق وارد کنید: ${phrase}`}>
          <input
            dir="ltr"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className={inputClass}
            placeholder={phrase}
            autoComplete="off"
            disabled={busy}
            aria-label="عبارت تأیید"
          />
        </Field>

        <ErrorBox>{error}</ErrorBox>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            انصراف
          </Button>
          <Button variant="danger" onClick={() => onConfirm(typed.trim())} disabled={busy || !confirmed}>
            {busy ? busyLabel : actionLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The reset scope, worded exactly as `resetBusiness` implements it. */
const RESET_REMOVED = [
  "سفارش‌ها، مراجوعی‌ها و تاریخچهٔ فروش",
  "حسابداری: اسناد، حساب‌ها، مغایرت‌گیری بانکی، دریافتنی/پرداختنی، هزینه‌ها و حقوق",
  "انبار: کالاها، موجودی، انتقال‌ها، قطع موجودی و شمارش‌ها",
  "منو/کالاها و دسته‌بندی‌ها",
  "همهٔ شعبه‌ها — با یک شعبهٔ پیش‌فرض جدید جایگزین می‌شوند",
  "کارکنان و همهٔ عضویت‌ها — فقط عضویت مالک دوباره ساخته می‌شود",
  "تنظیمات و پیشرفت ویزارد راه‌اندازی",
  "بازنویسی‌های پرچم ویژگی",
  "داده‌های طرف‌حساب/CRM داخل این کسب‌وکار",
  "داده‌های عملیاتی وب‌سایت و پیکربندی همگام‌سازی",
  "هوش مصنوعی: گفت‌وگوها، حافظه، پروژه‌ها و خودکارسازی‌ها",
  "تیکت‌های پشتیبانی، اعلان‌ها و کمپین‌ها",
  "جفت‌شدن دستگاه‌ها، کدهای اتصال، کلیدهای API و وب‌هوک‌ها",
];

const RESET_PRESERVED = [
  "اشتراک و پلن",
  "موجودی کیف پول و تاریخچهٔ تراکنش‌های آن",
  "فاکتورها، پرداخت‌ها و تعدیلات صورتحساب",
  "حق‌امتیزها و مصرف قابلیت‌ها",
  "سیاست هزینه و بازنویسی‌های تجاری",
  "اشتراک و هزینه‌های سرویس وب‌سایت",
  "نگاشت این کسب‌وکار در CRM/حسابداری شرکت سکو (در صورت وجود)",
  "وضعیت کسب‌وکار — بازنشانی کسب‌وکار معلق یا بایگانی را فعال نمی‌کند",
  "نام، شناسه، زیردامنه، نوع، منطقهٔ زمانی و تاریخ ایجاد",
  "هویت سراسری مالک — ورود، رمز و ورود دومرحله‌ای",
];

export function ResetPanel() {
  const { business, reload, setNotice } = useBusiness();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!business || !can("business.reset")) return null;
  if (business.ownershipKind === "platform_internal") return null;

  async function confirmReset(confirmation: string) {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "POST",
      body: JSON.stringify({ confirmation }),
    });
    setBusy(false);
    if (ok) {
      setOpen(false);
      setNotice(
        "داده‌های عملیاتی کسب‌وکار پاک شد؛ اشتراک، کیف پول و فاکتورها باقی ماندند. مالک باید دوباره وارد شود و راه‌اندازی اولیه را انجام دهد.",
      );
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="بازنشانی کسب‌وکار">
      <div className="rounded-lg border border-red-500/25 bg-red-500/8 p-3 text-sm text-red-900 dark:text-red-100">
        <p className="font-semibold">داده‌های عملیاتی پاک می‌شوند؛ سوابق تجاری باقی می‌مانند.</p>
        <p className="mt-1 text-red-900/70 dark:text-red-100/70">
          بازنشانی، کسب‌وکار را برای شروع مجدد آماده می‌کند: شعبه‌ها، کاربران، سفارش‌ها، انبار و
          تنظیمات پاک می‌شوند، اما اشتراک، کیف پول، فاکتورها و هویت مالک دست‌نخورده می‌مانند و
          وضعیت کسب‌وکار تغییر نمی‌کند.
        </p>
      </div>
      <div className="mt-4">
        <Button variant="danger" onClick={() => setOpen(true)} className="w-full sm:w-auto">
          بازنشانی و شروع مجدد
        </Button>
      </div>
      <DestructiveBusinessDialog
        open={open}
        onOpenChange={setOpen}
        busy={busy}
        title="بازنشانی کسب‌وکار"
        description={`کسب‌وکار «${business.name}» بازنشانی می‌شود: داده‌های عملیاتی پاک می‌شوند، سوابق تجاری باقی می‌مانند و مالک دوباره از راه‌اندازی اولیه شروع می‌کند.`}
        phrase={businessDestructivePhrase("reset", business.slug)}
        removed={RESET_REMOVED}
        preserved={RESET_PRESERVED}
        actionLabel="بازنشانی و شروع مجدد"
        busyLabel="در حال بازنشانی…"
        error={error}
        business={business}
        onConfirm={(confirmation) => void confirmReset(confirmation)}
      />
    </Card>
  );
}

/** The hard-delete scope, worded exactly as `hardDeleteBusiness` implements it. */
const DELETE_REMOVED = [
  "رکورد کسب‌وکار برای همیشه حذف می‌شود — بدون بازگشت و بدون دورهٔ مهلت",
  "همهٔ داده‌های عملیاتی (همان محدودهٔ بازنشانی)",
  "سوابق تجاری هم حذف می‌شوند: اشتراک، کیف پول، فاکتورها و پرداخت‌ها",
  "نگاشت این کسب‌وکار در شرکت سکو قطع می‌شود؛ خود رکورد مشتری در CRM باقی می‌ماند",
  "عضویت کارکنان حذف می‌شود؛ هویت سراسری مالک هم اگر در کسب‌وکار دیگری عضویت نداشته باشد حذف می‌شود",
];

const DELETE_SURVIVES = ["فقط ردپای عملیات در گزارش حسابرسی سکو باقی می‌ماند"];

export function RemovePanel() {
  const { business } = useBusiness();
  const can = useCan();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!business || !can("business.delete")) return null;
  if (business.ownershipKind === "platform_internal") return null;

  async function confirmRemove(confirmation: string) {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation }),
    });
    if (ok) {
      // The business list is `/platform/businesses`; `/platform` is the console
      // home, and landing there after a delete reads as "nothing happened".
      router.push("/platform/businesses");
      return;
    }
    setBusy(false);
    setError(errorMessage(data.error));
  }

  return (
    <Card title="حذف دائمی کسب‌وکار">
      <div className="rounded-lg border border-red-500/25 bg-red-500/8 p-3 text-sm text-red-900 dark:text-red-100">
        <p className="font-semibold">این کسب‌وکار برای همیشه حذف می‌شود.</p>
        <p className="mt-1 text-red-900/70 dark:text-red-100/70">
          فوری و قطعی است — بدون بایگانی و بدون مهلت. برخلاف بازنشانی، سوابق تجاری (اشتراک، کیف پول
          و فاکتورها) هم حذف می‌شوند و اگر هویت مالک در کسب‌وکار دیگری عضویت نداشته باشد، ورود
          سراسری او نیز از بین می‌رود.
        </p>
      </div>
      <div className="mt-4">
        <Button variant="danger" onClick={() => setOpen(true)} className="w-full sm:w-auto">
          حذف دائمی کسب‌وکار
        </Button>
      </div>
      <DestructiveBusinessDialog
        open={open}
        onOpenChange={setOpen}
        busy={busy}
        title="حذف دائمی کسب‌وکار"
        description={`کسب‌وکار «${business.name}» به‌طور دائمی حذف می‌شود؛ این عمل فوری، قطعی و بازگشت‌ناپذیر است.`}
        phrase={businessDestructivePhrase("delete", business.slug)}
        removed={DELETE_REMOVED}
        preserved={DELETE_SURVIVES}
        actionLabel="حذف دائمی کسب‌وکار"
        busyLabel="در حال حذف دائمی…"
        error={error}
        business={business}
        onConfirm={(confirmation) => void confirmRemove(confirmation)}
      />
    </Card>
  );
}
