"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { MessageCircleIcon, PlusIcon, SendIcon, WalletCardsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber } from "@/lib/digits";
import { templateVariableTokens } from "@/lib/message-template";
import {
  cardClass,
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, Field, InfoBox, inputClass, SecondaryButton } from "@/app/dashboard/ui";

type Channel = "sms" | "email";

interface Template {
  id: string;
  channel: Channel;
  name: string;
  subject: string;
  body: string;
}

interface Segment {
  id: string;
  name: string;
  description: string;
}

interface Project {
  id: string;
  name: string;
}

interface Promotion {
  id: string;
  name: string;
  isActive: boolean;
}

interface Campaign {
  id: string;
  channel: Channel;
  name: string;
  templateId: string | null;
  segmentId: string | null;
  projectId: string | null;
  promotionId: string | null;
  status: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  createdAt: string;
}

/**
 * Issue #902 §5 — the tenant's approved-message catalog, in first-party words.
 * The server sends a title, a purpose and a status label; the provider's
 * template name, id, review notes and rejection text stay behind the API.
 */
interface LookupTemplate {
  id: string;
  title: string;
  purpose: "verification" | "transactional";
  status: "in_review" | "ready" | "needs_action" | "disabled";
  statusLabel: string;
  updatedAt: string;
  /** The business events this message's own variables can serve (issue #902 §5). */
  triggers?: LookupTriggerKey[];
}

/** The closed vocabulary the server accepts for automations. */
type LookupTriggerKey = "order_ready" | "payment_received";

/**
 * Issue #902 §5 — one "when X happens, send this" decision, as the server
 * describes it. `problem` is why the attached message cannot be used, in
 * first-party words; `login_code` is deliberately not a trigger, because a
 * login OTP runs on the platform transport and never on this business's wallet.
 */
interface TriggerSetting {
  trigger: LookupTriggerKey;
  label: string;
  description: string;
  enabled: boolean;
  templateId: string | null;
  templateTitle: string | null;
  problem: string | null;
}

interface Data {
  config: {
    enabled: boolean;
    configured: boolean;
    rate: { smsRialPerSegment: number; emailRialPerSend: number };
    /**
     * First-party readiness. The server never sends provider vocabulary
     * (issue #902): a status, a Persian sentence, and — when the tenant can
     * actually do something — a first-party action.
     */
    service?: {
      status: "ready" | "preparing" | "action_required" | "unavailable";
      statusLabel: string;
      detail: string;
      action: { label: string; href: string; blocking: boolean } | null;
    };
  };
  /** The central wallet's usable balance — shown, never bought, here. */
  billing: { balanceRial: number };
  templates: Template[];
  lookupTemplates?: LookupTemplate[];
  triggers?: TriggerSetting[];
  campaigns: Campaign[];
  segments: Segment[];
  projects: Project[];
  promotions: Promotion[];
}

/** `excludedByConsent` is the API field; `missingContact` is a separate, actionable data-quality gap. */
interface Audience {
  matched: number;
  reachable: number;
  excludedByConsent: number;
  missingContact: number;
  truncated: boolean;
}

interface MessagePreview {
  customerName: string;
  channel: Channel;
  subject: string;
  body: string;
  smsSegments: number | null;
  costRial: number;
}

const channelLabel: Record<Channel, string> = { sms: "پیامک", email: "ایمیل" };

const lookupPurposeLabel: Record<LookupTemplate["purpose"], string> = {
  verification: "کد ورود یا تأیید",
  transactional: "اطلاع‌رسانی تراکنشی",
};

function lookupTone(status: LookupTemplate["status"]): "active" | "positive" | "neutral" | "danger" {
  if (status === "ready") return "positive";
  if (status === "needs_action") return "danger";
  if (status === "in_review") return "active";
  return "neutral";
}

function campaignStatus(state: string): string {
  if (state === "sending") return "در حال ارسال";
  if (state === "completed") return "تکمیل‌شده";
  if (state === "paused") return "متوقف";
  if (state === "failed") return "ناموفق";
  return "پیش‌نویس";
}

function campaignStatusTone(state: string): "active" | "positive" | "neutral" | "danger" {
  if (state === "sending") return "active";
  if (state === "completed") return "positive";
  if (state === "failed") return "danger";
  return "neutral";
}

function usesVariable(template: Template | undefined, variable: string): boolean {
  return Boolean(template && templateVariableTokens(`${template.subject}\n${template.body}`).includes(variable));
}

function displayMessagingError(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  if (code.startsWith("message_variable_missing:")) {
    return `برای این الگو، مقدار «${code.slice("message_variable_missing:".length)}» را وارد کنید یا متغیر را از متن حذف کنید.`;
  }
  return errorMessageOrRaw(code);
}

/** The central wallet page: the only place credit is bought (issue #764). */
export const CENTRAL_BILLING_HREF = "/settings/billing";

/**
 * Outbound SMS/email campaigns: templates, audience (a CRM segment, filtered
 * for consent server-side), a real sample, cost estimate and send status.
 *
 * Growth does not run a second billing centre. The balance shown is the
 * platform wallet's, the estimate is checked against it, and buying credit is
 * a link to `/settings/billing` (issue #764). Composing and sending need
 * `campaigns.manage`; `campaigns.view` sees the campaigns and their results.
 */
export function MessagingSection({
  canManage,
  initialPromotionId,
}: {
  canManage: boolean;
  initialPromotionId?: string;
}) {
  const money = useMoney();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [templateChannel, setTemplateChannel] = useState<Channel>("sms");
  const [templateName, setTemplateName] = useState("");
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [campaignChannel, setCampaignChannel] = useState<Channel>("sms");
  const [templateId, setTemplateId] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [projectId, setProjectId] = useState("");
  // Arriving from a discount campaign's «اطلاع‌رسانی با پیام» preselects it as
  // this message's attributable promotion.
  const [promotionId, setPromotionId] = useState(initialPromotionId ?? "");
  const [audience, setAudience] = useState<Audience | null>(null);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [messagePreview, setMessagePreview] = useState<MessagePreview | null>(null);
  const [discountCodes, setDiscountCodes] = useState<Record<string, string>>({});
  // Issue #902 §5 — "کد ورود" and friends. `editingLookupId` turns the same
  // form into a revision: the server decides whether that rewrites the row or
  // creates a successor, so the tenant never sees a "version" concept.
  const [lookupTitle, setLookupTitle] = useState("");
  const [lookupBody, setLookupBody] = useState("");
  const [lookupPurpose, setLookupPurpose] = useState<LookupTemplate["purpose"]>("verification");
  const [editingLookupId, setEditingLookupId] = useState("");
  // Issue #902 §5 — the trigger form: which approved message each automation is
  // attached to, before it is saved.
  const [triggerPick, setTriggerPick] = useState<Record<string, string>>({});
  const audienceRequest = useRef(0);
  const messagePreviewRequest = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const result = await api<Data & { error?: string }>("/api/messaging");
    if (!result.ok) {
      setError(displayMessagingError(result.data.error, "دریافت اطلاعات پیام‌رسانی ممکن نشد."));
    } else {
      setData(result.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const matchingTemplates = useMemo(
    () => data?.templates.filter((item) => item.channel === campaignChannel) ?? [],
    [data, campaignChannel],
  );

  useEffect(() => {
    if (!matchingTemplates.some((item) => item.id === templateId)) {
      setTemplateId(matchingTemplates[0]?.id ?? "");
    }
  }, [matchingTemplates, templateId]);

  // A sample is meaningful only for the exact template + segment currently selected.
  useEffect(() => {
    messagePreviewRequest.current += 1;
    setMessagePreview(null);
    setBusy((current) => (current === "preview" ? "" : current));
  }, [templateId, segmentId]);

  async function send(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError("");
    setNotice("");
    const result = await api<{ error?: string }>("/api/messaging", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setBusy("");
    if (!result.ok) {
      setError(displayMessagingError(result.data.error, "عملیات پیام‌رسانی ناموفق بود."));
      return false;
    }
    await load();
    return true;
  }

  async function previewAudience(nextSegment = segmentId, nextChannel = campaignChannel) {
    const requestId = ++audienceRequest.current;
    if (!nextSegment) {
      setAudience(null);
      setAudienceLoading(false);
      return;
    }
    setAudience(null);
    setAudienceLoading(true);
    setError("");
    const result = await api<{ audience?: Audience; error?: string }>("/api/growth/campaign-audience", {
      method: "POST",
      body: JSON.stringify({ segmentId: nextSegment, channel: nextChannel }),
    });
    if (requestId !== audienceRequest.current) return;
    setAudienceLoading(false);
    if (!result.ok || !result.data.audience) {
      setError(displayMessagingError(result.data.error, "پیش‌نمایش مخاطب ممکن نشد."));
      return;
    }
    setAudience(result.data.audience);
  }

  async function previewMessage() {
    if (!templateId || !segmentId) return;
    const requestId = ++messagePreviewRequest.current;
    setBusy("preview");
    setError("");
    setMessagePreview(null);
    const result = await api<{ preview?: MessagePreview; error?: string }>("/api/messaging/preview", {
      method: "POST",
      body: JSON.stringify({ templateId, segmentId }),
    });
    if (requestId !== messagePreviewRequest.current) return;
    setBusy("");
    if (!result.ok || !result.data.preview) {
      setError(displayMessagingError(result.data.error, "پیش‌نمایش متن ممکن نشد."));
      return;
    }
    setMessagePreview(result.data.preview);
  }

  async function addTemplate(event: FormEvent) {
    event.preventDefault();
    const saved = await send(
      {
        action: "template",
        channel: templateChannel,
        name: templateName,
        subject: templateSubject,
        message: templateBody,
      },
      "template",
    );
    if (saved) {
      setTemplateName("");
      setTemplateSubject("");
      setTemplateBody("");
      setNotice("الگو ذخیره شد.");
    }
  }

  function editLookup(template: LookupTemplate) {
    setEditingLookupId(template.id);
    setLookupTitle(template.title);
    setLookupPurpose(template.purpose);
    // The body is not returned to the tenant list (it can be long and is only
    // meaningful alongside its provider review), so a revision starts from an
    // empty text box with the title carried over.
    setLookupBody("");
    setNotice("متن جدید را وارد کنید؛ پیام فعلی تا تأیید متن تازه فعال می‌ماند.");
  }

  async function saveLookup(event: FormEvent) {
    event.preventDefault();
    const edited = Boolean(editingLookupId);
    const saved = await send(
      edited
        ? {
            action: "lookup_template_revise",
            templateId: editingLookupId,
            title: lookupTitle,
            message: lookupBody,
          }
        : {
            action: "lookup_template",
            title: lookupTitle,
            message: lookupBody,
            purpose: lookupPurpose,
          },
      edited ? "lookup-revise" : "lookup",
    );
    if (saved) {
      setLookupTitle("");
      setLookupBody("");
      setEditingLookupId("");
      setNotice(
        edited
          ? "متن تازه ثبت شد و برای بررسی ارسال می‌شود."
          : "پیام ثبت شد و برای بررسی ارسال می‌شود؛ پس از تأیید در همین فهرست «آمادهٔ استفاده» می‌شود.",
      );
    }
  }

  async function removeLookup(id: string) {
    const saved = await send({ action: "lookup_template_disable", templateId: id }, `lookup-remove:${id}`);
    if (saved) setNotice("این پیام از فهرست پیام‌های خودکار خارج شد.");
  }

  /**
   * Turn one automation on or off. The chosen message is what the server
   * validates against the event's own variables, so a mismatch comes back as a
   * refusal in this form rather than as a message sent with a blank.
   */
  async function saveTrigger(trigger: LookupTriggerKey, enabled: boolean) {
    const chosen = triggerPick[trigger] ?? data?.triggers?.find((item) => item.trigger === trigger)?.templateId ?? "";
    if (!chosen) {
      setError("برای این رویداد یک پیام آمادهٔ استفاده انتخاب کنید.");
      return;
    }
    const saved = await send({ action: "lookup_trigger", trigger, templateId: chosen, enabled }, `trigger:${trigger}`);
    if (saved) {
      setNotice(
        enabled
          ? "این رویداد فعال شد؛ از این پس برای هر اتفاق، یک پیامک برای مشتری همان سفارش می‌رود."
          : "این رویداد خاموش شد؛ دیگر پیامکی برای آن فرستاده نمی‌شود.",
      );
    }
  }

  async function addCampaign(event: FormEvent) {
    event.preventDefault();
    if (audience?.truncated) return;
    const saved = await send(
      {
        action: "campaign",
        channel: campaignChannel,
        name: campaignName,
        templateId,
        segmentId,
        projectId: projectId || null,
        promotionId: promotionId || null,
      },
      "campaign",
    );
    if (saved) {
      setCampaignName("");
      setNotice("پیش‌نویس کمپین ساخته شد. پس از بررسی نمونه، ارسال را شروع کنید.");
    }
  }

  async function startCampaign(id: string, discountCode?: string) {
    const saved = await send(
      { action: "launch", campaignId: id, ...(discountCode?.trim() ? { discountCode: discountCode.trim() } : {}) },
      `launch:${id}`,
    );
    if (saved) setNotice("فهرست مخاطبانِ مجاز ثابت شد و پیام‌ها در صف ارسال قرار گرفتند.");
  }

  if (!data) {
    if (loading) return <SectionCardSkeleton rows={7} label="در حال بارگذاری پیام‌رسانی" />;
    return (
      <div className="space-y-3">
        <ErrorBox>{error || "دریافت اطلاعات پیام‌رسانی ممکن نشد."}</ErrorBox>
        <div className="max-w-xs">
          <SecondaryButton onClick={() => void load()}>تلاش دوباره</SecondaryButton>
        </div>
      </div>
    );
  }

  const costPerRecipient =
    campaignChannel === "sms" ? data.config.rate.smsRialPerSegment : data.config.rate.emailRialPerSend;
  const sendableAudience = audience ? Math.max(0, audience.reachable - audience.missingContact) : 0;
  const estimatedAudienceCost = messagePreview
    ? sendableAudience * messagePreview.costRial
    : sendableAudience * costPerRecipient;
  const insufficientCredit = audience !== null && estimatedAudienceCost > data.billing.balanceRial;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <section className="grid gap-3 md:grid-cols-3" aria-label="وضعیت پیام‌رسانی">
        <div className={`${cardClass} min-w-0 p-4`}>
          <WalletCardsIcon aria-hidden="true" className="size-5 text-amber-600 dark:text-amber-400" />
          <p className="mt-2 text-xs text-muted-foreground">اعتبار قابل استفاده (کیف پول پلتفرم)</p>
          <b className="mt-1 block break-words text-lg">{money.format(data.billing.balanceRial)}</b>
          <Link
            href={CENTRAL_BILLING_HREF}
            className="mt-2 inline-flex min-h-11 items-center text-xs font-medium text-teal-700 underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            افزایش اعتبار و سوابق پرداخت در «اعتبار و پرداخت‌ها»
          </Link>
        </div>
        <div className={`${cardClass} min-w-0 p-4`}>
          <MessageCircleIcon aria-hidden="true" className="size-5 text-amber-600 dark:text-amber-400" />
          <p className="mt-2 text-xs text-muted-foreground">وضعیت سرویس پیامک</p>
          <b className="mt-1 block text-sm">
            {data.config.service
              ? data.config.service.statusLabel
              : data.config.enabled && data.config.configured
                ? "آمادهٔ ارسال"
                : "نیازمند تنظیم پلتفرم"}
          </b>
          {data.config.service ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {data.config.service.detail}
            </p>
          ) : null}
          {data.config.service?.action ? (
            <Link
              href={data.config.service.action.href}
              className="mt-2 inline-flex min-h-9 items-center text-xs font-medium text-teal-700 underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {data.config.service.action.label}
            </Link>
          ) : null}
        </div>
        <div className={`${cardClass} min-w-0 p-4`}>
          <SendIcon aria-hidden="true" className="size-5 text-amber-600 dark:text-amber-400" />
          <p className="mt-2 text-xs text-muted-foreground">نرخ فعلی</p>
          <b className="mt-1 block text-sm leading-6">
            پیامک {money.format(data.config.rate.smsRialPerSegment)} برای هر قطعه · ایمیل {money.format(data.config.rate.emailRialPerSend)}
          </b>
        </div>
      </section>

      {canManage ? (
      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard
          title="الگوی پیام"
          description="متغیرها: {{نام}}، {{نام_فروشگاه}}، {{امتیاز}}، {{اعتبار}} و {{کد_تخفیف}}. اعتبار، ماندهٔ زندهٔ هر مشتری است."
        >
          <form className="grid gap-3" onSubmit={addTemplate}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="کانال">
                <select className={inputClass} value={templateChannel} onChange={(event) => setTemplateChannel(event.target.value as Channel)}>
                  <option value="sms">پیامک</option>
                  <option value="email">ایمیل</option>
                </select>
              </Field>
              <Field label="نام الگو">
                <input className={inputClass} value={templateName} onChange={(event) => setTemplateName(event.target.value)} required />
              </Field>
            </div>
            {templateChannel === "email" ? (
              <Field label="موضوع ایمیل">
                <input className={inputClass} value={templateSubject} onChange={(event) => setTemplateSubject(event.target.value)} />
              </Field>
            ) : null}
            <Field
              label="متن پیام"
              hint="اگر از «کد تخفیف» استفاده می‌کنید، هنگام شروع ارسال آن را وارد خواهید کرد."
            >
              <textarea className={`${inputClass} min-h-28`} value={templateBody} onChange={(event) => setTemplateBody(event.target.value)} required />
            </Field>
            <div>
              <Button type="submit" disabled={busy === "template"}>
                {busy === "template" ? "در حال ذخیره…" : <><PlusIcon aria-hidden="true" /> ذخیرهٔ الگو</>}
              </Button>
            </div>
          </form>

          <div className="mt-4 space-y-1">
            {data.templates.length ? (
              data.templates.map((item) => (
                <div className="min-w-0 rounded-lg border border-border/80 px-3 py-2 text-sm" key={item.id}>
                  <b className="break-words">{item.name}</b>
                  <span className="me-2 text-xs text-muted-foreground">{channelLabel[item.channel]}</span>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.body}</p>
                </div>
              ))
            ) : (
              <EmptyState>هنوز الگویی ندارید.</EmptyState>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="ساخت و پیش‌نمایش کمپین"
          description="قبل از ساخت پیش‌نویس، مخاطبان مجاز و نمونهٔ واقعیِ پیام را بررسی کنید."
        >
          <form className="grid gap-3" onSubmit={addCampaign}>
            <Field label="نام کمپین">
              <input className={inputClass} value={campaignName} onChange={(event) => setCampaignName(event.target.value)} required />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="کانال">
                <select
                  className={inputClass}
                  value={campaignChannel}
                  onChange={(event) => {
                    const nextChannel = event.target.value as Channel;
                    setCampaignChannel(nextChannel);
                    void previewAudience(segmentId, nextChannel);
                  }}
                >
                  <option value="sms">پیامک</option>
                  <option value="email">ایمیل</option>
                </select>
              </Field>
              <Field label="الگو">
                <select className={inputClass} value={templateId} onChange={(event) => setTemplateId(event.target.value)} required>
                  <option value="">انتخاب الگو</option>
                  {matchingTemplates.map((item) => (
                    <option value={item.id} key={item.id}>{item.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="بخش مشتریان">
                <select
                  className={inputClass}
                  value={segmentId}
                  onChange={(event) => {
                    setSegmentId(event.target.value);
                    void previewAudience(event.target.value);
                  }}
                  required
                >
                  <option value="">انتخاب بخش</option>
                  {data.segments.map((item) => (
                    <option value={item.id} key={item.id}>{item.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="پروژه / مرکز هزینه (اختیاری)">
                <select className={inputClass} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  <option value="">بدون پروژه</option>
                  {data.projects.map((item) => (
                    <option value={item.id} key={item.id}>{item.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field
              label="پروموشنِ اختصاصی برای سنجش بازده (اختیاری)"
              hint="فقط فروش‌های ثبت‌شده با همین پروموشن به این کمپین نسبت داده می‌شوند؛ بدون آن، بازده قابل محاسبه نیست."
            >
              <select className={inputClass} value={promotionId} onChange={(event) => setPromotionId(event.target.value)}>
                <option value="">بدون پروموشن اختصاصی</option>
                {data.promotions.filter((item) => item.isActive).map((item) => (
                  <option value={item.id} key={item.id}>{item.name}</option>
                ))}
              </select>
            </Field>

            {insufficientCredit ? (
              <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-6 text-destructive">
                برآورد هزینهٔ این ارسال ({money.format(estimatedAudienceCost)}) از اعتبار قابل استفاده بیشتر است.{" "}
                <Link href={CENTRAL_BILLING_HREF} className="font-medium underline underline-offset-4">
                  افزایش اعتبار
                </Link>
              </div>
            ) : null}

            {audienceLoading ? (
              <LoadingSkeleton rows={2} compact label="در حال بررسی مخاطبان مجاز" />
            ) : audience ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
                <p>
                  <b>{formatPersianNumber(sendableAudience)}</b> مخاطب قابل‌ارسال از {formatPersianNumber(audience.matched)} عضو بخش
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {formatPersianNumber(audience.excludedByConsent)} نفر بدون رضایت · {formatPersianNumber(audience.missingContact)} نفر بدون راه ارتباطی
                  {messagePreview
                    ? ` · برآورد براساس نمونه: ${money.format(estimatedAudienceCost)}`
                    : campaignChannel === "sms"
                      ? ` · حداقل هزینه: ${money.format(estimatedAudienceCost)} (هزینهٔ نهایی به طول هر پیام بستگی دارد)`
                      : ` · هزینهٔ برآوردی: ${money.format(estimatedAudienceCost)}`}
                </p>
                {audience.truncated ? (
                  <p className="mt-2 rounded-lg border border-amber-200 bg-card px-3 py-2 text-xs leading-5 text-amber-950 dark:border-amber-500/30 dark:text-amber-200">
                    تعداد مخاطبان از سقف ارسال یک‌باره بیشتر است. برای جلوگیری از ارسال ناقص، این بخش را کوچک‌تر کنید.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">بخش مشتریان را انتخاب کنید تا پیش‌نمایش با قواعد رضایت انجام شود.</p>
            )}

            {messagePreview ? (
              <div className="rounded-xl border border-border/80 p-3 text-sm">
                <p className="font-medium">نمونه با دادهٔ واقعیِ «{messagePreview.customerName}»</p>
                {messagePreview.subject ? <p className="mt-1 text-xs text-muted-foreground">موضوع: {messagePreview.subject}</p> : null}
                <p className="mt-2 whitespace-pre-wrap break-words">{messagePreview.body}</p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {messagePreview.smsSegments === null ? "ایمیل" : `${formatPersianNumber(messagePreview.smsSegments)} قطعه پیامک`} · هزینهٔ این نمونه {money.format(messagePreview.costRial)}
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!templateId || !segmentId || busy === "preview" || audienceLoading}
                onClick={() => void previewMessage()}
              >
                {busy === "preview" ? "در حال آماده‌سازی…" : <><MessageCircleIcon aria-hidden="true" /> نمایش نمونهٔ واقعی</>}
              </Button>
              <Button type="submit" disabled={!templateId || !segmentId || busy === "campaign" || audienceLoading || audience?.truncated}>
                {busy === "campaign" ? "در حال ساخت…" : <><PlusIcon aria-hidden="true" /> ساخت پیش‌نویس</>}
              </Button>
            </div>
          </form>
        </SectionCard>
      </div>
      ) : (
        <InfoBox>ساخت الگو و ارسال کمپین پیامی به مجوز «اجرای کمپین» نیاز دارد؛ این‌جا وضعیت و نتیجهٔ کمپین‌ها را می‌بینید.</InfoBox>
      )}

      <SectionCard
        title="پیام‌های خودکار (کد ورود و اطلاع‌رسانی)"
        description="این پیام‌ها با متن ثابت و متغیر %token ارسال می‌شوند و پیش از استفاده بررسی می‌شوند. متن و وضعیت بررسی را همین‌جا می‌بینید؛ جزئیات فنی سرویس‌دهنده نمایش داده نمی‌شود."
      >
        {(data.lookupTemplates ?? []).length ? (
          <ul className="divide-y divide-border/80">
            {(data.lookupTemplates ?? []).map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="leading-6 font-medium">
                    {item.title}{" "}
                    <StatusBadge tone={lookupTone(item.status)}>{item.statusLabel}</StatusBadge>
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {lookupPurposeLabel[item.purpose]}
                    {item.status === "needs_action"
                      ? " · متن را اصلاح کنید و دوباره ثبت کنید"
                      : item.status === "ready"
                        ? " · برای ارسال خودکار آماده است"
                        : null}
                  </p>
                </div>
                {canManage && item.status !== "disabled" ? (
                  <div className="flex items-center gap-2">
                    <SecondaryButton onClick={() => editLookup(item)}>ویرایش متن</SecondaryButton>
                    <SecondaryButton onClick={() => void removeLookup(item.id)} disabled={busy === `lookup-remove:${item.id}`}>
                      {busy === `lookup-remove:${item.id}` ? "در حال حذف…" : "خروج از فهرست"}
                    </SecondaryButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>هنوز پیام خودکاری ثبت نشده است. کد ورود یا پیام تراکنشی را از فرم پایین اضافه کنید.</EmptyState>
        )}

        {/* Issue #902 §5 — the product half: when a real event happens, one of
            these messages goes to the customer of that order. Off until the
            business turns one on. */}
        {(data.triggers ?? []).length ? (
          <div className="mt-4 grid gap-3 border-t border-border/80 pt-4">
            <div>
              <p className="text-sm font-medium">اطلاع‌رسانی خودکار برای رویدادها</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                هر پیامک از حساب پیامکی همین کسب‌وکار ارسال و از کیف پول مرکزی کسر می‌شود. فقط مشتری همان سفارشِ پیام را
                می‌گیرد، و اگر مشتری اجازهٔ پیامک نداده باشد پیامی فرستاده نمی‌شود.
              </p>
            </div>
            {(data.triggers ?? []).map((setting) => {
              const options = (data.lookupTemplates ?? []).filter(
                (item) => item.status === "ready" && (item.triggers ?? []).includes(setting.trigger),
              );
              const chosen = triggerPick[setting.trigger] ?? setting.templateId ?? options[0]?.id ?? "";
              return (
                <div key={setting.trigger} className="grid gap-2 rounded-xl border border-border/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {setting.label}{" "}
                        <StatusBadge tone={setting.enabled && !setting.problem ? "positive" : "neutral"}>
                          {setting.problem
                            ? "نیازمند رسیدگی"
                            : setting.enabled
                              ? "فعال"
                              : "خاموش"}
                        </StatusBadge>
                      </p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{setting.description}</p>
                      {setting.problem ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          پیام انتخاب‌شده با این رویداد سازگار نیست؛ پیامی انتخاب کنید که متغیرهایش با این رویداد پر می‌شود.
                        </p>
                      ) : setting.templateTitle ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">پیام: {setting.templateTitle}</p>
                      ) : null}
                    </div>
                  </div>
                  {canManage ? (
                    options.length ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="min-w-0 flex-1">
                          <span className="mb-1 block text-xs font-medium text-foreground">پیام این رویداد</span>
                          <select
                            className={inputClass}
                            value={chosen}
                            onChange={(event) =>
                              setTriggerPick((current) => ({ ...current, [setting.trigger]: event.target.value }))
                            }
                          >
                            {options.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        {setting.enabled ? (
                          <Button
                            variant="outline"
                            className="min-h-11"
                            disabled={busy === `trigger:${setting.trigger}`}
                            onClick={() => void saveTrigger(setting.trigger, false)}
                          >
                            {busy === `trigger:${setting.trigger}` ? "در حال ذخیره…" : "خاموش کردن"}
                          </Button>
                        ) : (
                          <Button
                            className="min-h-11"
                            disabled={!chosen || busy === `trigger:${setting.trigger}`}
                            onClick={() => void saveTrigger(setting.trigger, true)}
                          >
                            {busy === `trigger:${setting.trigger}` ? "در حال ذخیره…" : "فعال کردن"}
                          </Button>
                        )}
                      </div>
                    ) : (
                      <InfoBox>
                        برای این رویداد هنوز پیام آمادهٔ استفاده‌ای ندارید. یکی از پیام‌های تراکنشی را از فهرست بالا اضافه
                        کنید؛ پس از تأیید، همین‌جا قابل انتخاب می‌شود.
                      </InfoBox>
                    )
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {canManage ? (
          <form className="mt-4 grid gap-3 border-t border-border/80 pt-4" onSubmit={saveLookup}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="نام پیام" hint="همین نام در فهرست بالا دیده می‌شود، مثل «کد ورود».">
                <input className={inputClass} value={lookupTitle} onChange={(event) => setLookupTitle(event.target.value)} required maxLength={80} />
              </Field>
              <Field label="کاربرد">
                <select
                  className={inputClass}
                  value={lookupPurpose}
                  disabled={Boolean(editingLookupId)}
                  onChange={(event) => setLookupPurpose(event.target.value as LookupTemplate["purpose"])}
                >
                  <option value="verification">کد ورود یا تأیید</option>
                  <option value="transactional">اطلاع‌رسانی تراکنشی</option>
                </select>
              </Field>
            </div>
            <Field
              label="متن پیام"
              hint="باید شامل %token باشد؛ متغیرهای شماره‌دار %token2 تا %token20 هم پذیرفته می‌شوند."
            >
              <textarea
                className={`${inputClass} min-h-24`}
                value={lookupBody}
                onChange={(event) => setLookupBody(event.target.value)}
                required
                placeholder="کد ورود شما %token است"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={busy === "lookup" || busy === "lookup-revise"}>
                {busy === "lookup" || busy === "lookup-revise"
                  ? "در حال ثبت…"
                  : editingLookupId
                    ? "ثبت متن تازه"
                    : <><PlusIcon aria-hidden="true" /> افزودن پیام</>}
              </Button>
              {editingLookupId ? (
                <SecondaryButton
                  type="button"
                  onClick={() => {
                    setEditingLookupId("");
                    setLookupTitle("");
                    setLookupBody("");
                  }}
                >
                  انصراف از ویرایش
                </SecondaryButton>
              ) : null}
            </div>
          </form>
        ) : null}
      </SectionCard>

      <SectionCard title="کمپین‌های پیام" description="با شروع ارسال، فهرست مشتریانِ مجاز همان لحظه ثابت و در صف خروجی ثبت می‌شود.">
        {data.campaigns.length ? (
          <ul className="divide-y divide-border/80">
            {data.campaigns.map((campaign) => {
              const template = data.templates.find((item) => item.id === campaign.templateId);
              const needsDiscountCode = usesVariable(template, "کد_تخفیف");
              const discountCode = discountCodes[campaign.id] ?? "";
              return (
                <li key={campaign.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="leading-6 font-medium">
                      {campaign.name}{" "}
                      <StatusBadge tone={campaignStatusTone(campaign.status)}>{campaignStatus(campaign.status)}</StatusBadge>
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {channelLabel[campaign.channel]} · {formatPersianNumber(campaign.sentCount)} ارسال‌شده از {formatPersianNumber(campaign.totalRecipients)} · تحویل {formatPersianNumber(campaign.deliveredCount)} · ناموفق {formatPersianNumber(campaign.failedCount)} · {campaign.promotionId ? "بازده با پروموشن اختصاصی در گزارش حسابداری" : "بازده: قابل محاسبه نیست (پروموشن اختصاصی ندارد)"}
                    </p>
                  </div>

                  {!canManage ? null : campaign.status === "draft" ? (
                    <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto sm:flex-nowrap">
                      {needsDiscountCode ? (
                        <label className="min-w-0 flex-1 sm:w-52 sm:flex-none">
                          <span className="mb-1 block text-xs font-medium text-foreground">کد تخفیف در پیام</span>
                          <input
                            className={inputClass}
                            dir="ltr"
                            value={discountCode}
                            onChange={(event) => setDiscountCodes((current) => ({ ...current, [campaign.id]: event.target.value }))}
                            placeholder="SUMMER20"
                          />
                        </label>
                      ) : null}
                      <Button
                        className="min-h-11 w-full sm:w-auto"
                        disabled={busy === `launch:${campaign.id}` || (needsDiscountCode && !discountCode.trim())}
                        onClick={() => void startCampaign(campaign.id, needsDiscountCode ? discountCode : undefined)}
                      >
                        {busy === `launch:${campaign.id}` ? "در حال شروع…" : <><SendIcon aria-hidden="true" /> شروع ارسال</>}
                      </Button>
                    </div>
                  ) : campaign.status === "sending" ? (
                    <Button
                      variant="outline"
                      className="min-h-11 w-full sm:w-auto"
                      disabled={busy === `pause:${campaign.id}`}
                      onClick={() => void send({ action: "pause", campaignId: campaign.id }, `pause:${campaign.id}`)}
                    >
                      {busy === `pause:${campaign.id}` ? "در حال توقف…" : "توقف"}
                    </Button>
                  ) : campaign.status === "paused" ? (
                    <Button
                      variant="outline"
                      className="min-h-11 w-full sm:w-auto"
                      disabled={busy === `resume:${campaign.id}`}
                      onClick={() => void send({ action: "resume", campaignId: campaign.id }, `resume:${campaign.id}`)}
                    >
                      {busy === `resume:${campaign.id}` ? "در حال ادامه…" : "ادامهٔ ارسال"}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState>هنوز پیش‌نویس یا کمپین پیامی ثبت نشده است.</EmptyState>
        )}
      </SectionCard>

    </div>
  );
}
