"use client";

/**
 * Issue #902 — the Superadmin control plane for managed SMS accounts.
 *
 * Shown inside `/platform/messaging` as its own card because the account fleet
 * is operational, not part of the provider connection: the connection is one
 * master credential, while this screen is one row per business, with the
 * provider's own state, tariff, balance and key hint.
 *
 * Everything here is provider-facing. That is allowed on this surface and
 * nowhere else — tenant screens receive `getTenantMessagingConfig()` instead.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { Loader2Icon, RefreshCwIcon, SaveIcon, ShieldCheckIcon, WalletCardsIcon } from "lucide-react";
import { formatPersianNumber } from "@/lib/digits";
import { tomanLabel } from "@/lib/platform-money";
import { MASTER_BALANCE_STALE_HOURS } from "@/lib/kavenegar/master-balance-facts";
import { deliveryHealth, type DeliveryHealth } from "@/lib/delivery-health";
import {
  TREND_HEALTH_LABELS,
  trendBarPercent,
  type DeliveryTrendSummary,
} from "@/lib/delivery-trend-facts";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass } from "../ui";

interface ManagedPolicy {
  enabled: boolean;
  planId: number | null;
  minAllowedCreditRial: number;
  senderLines: string[];
  note: string | null;
  fundingBufferMessages: number;
  fundingChildCapRial: number | null;
  fundingDailyCapRial: number | null;
  fundingMasterFloorRial: number;
  /** Issue #902 §3 — when a transfer is planned, not just how much. */
  fundingStrategy: "jit" | "low_watermark" | "scheduled" | "manual";
  fundingLowWatermarkMessages: number;
  fundingWindowStartHour: number;
  fundingWindowEndHour: number;
  fundingGlobalDailyCapRial: number | null;
  /** Issue #902 #3 — credit above the floor that only transactional spend may use. */
  fundingTransactionalReserveRial: number;
  fundingPurpose: "marketing" | "transactional";
  updatedAt: string | null;
}

interface ManagedAccount {
  id: string;
  businessId: string;
  businessName: string | null;
  localId: string;
  username: string;
  state:
    | "not_provisioned"
    | "pending"
    | "provisioning"
    | "active"
    | "retry_pending"
    | "attention_required"
    | "suspended";
  attentionReason: string | null;
  providerStatus: string | null;
  keyHint: string | null;
  planId: number | null;
  pricingName: string | null;
  smsFarsiCostRial: number | null;
  smsEnglishCostRial: number | null;
  providerBalanceRial: number | null;
  providerBalanceAt: string | null;
  senderLines: string[];
  adopted: boolean;
  provisionedAt: string | null;
  suspendedAt: string | null;
}

interface ManagedJob {
  id: string;
  businessId: string;
  kind: string;
  state: string;
  attempts: number;
  lastErrorCode: string | null;
  createdAt: string;
}

interface UnresolvedTransfer {
  id: string;
  businessId: string;
  amountRial: number;
  state: string;
  createdAt: string;
}

interface MarginRow {
  businessId: string;
  businessName: string | null;
  retailChargedRial: number;
  providerCostRial: number;
  marginRial: number;
  unreportedCostSends: number;
  sends: number;
}

interface ReconciliationRow {
  id: string;
  business_id: string;
  state: "ok" | "drift" | "incomplete";
  delta_rial: string | number | null;
  provider_balance_rial: string | number | null;
  provider_cost_rial: string | number;
  retail_charged_rial: string | number;
  created_at: string;
}

/** Issue #902 §5 — one row per business template, straight from the catalog. */
interface CatalogTemplate {
  id: string;
  business_id: string;
  business_name: string | null;
  name: string;
  title: string;
  body: string;
  purpose: "verification" | "transactional";
  state: "draft" | "submitted" | "approved" | "rejected" | "disabled";
  provider_template_id: string | number | null;
  last_sync_error: string | null;
  revision: number;
  /** Ordered variable names; empty means the managed send path refuses it (§5). */
  variables: string[];
  archived_at: string | null;
  updated_at: string;
}

/**
 * Issue #902 §5 — one entry of the platform's own message library.
 *
 * This is the layer above the catalog: the operator decides which first-party
 * message exists, which trades/plans may have it, and whether it is offered at
 * all. `sample` arrives rendered by the server with representative values, so
 * the console never has to guess what `%token` will become.
 */
interface MasterTemplate {
  id: string;
  key: string;
  title: string;
  body: string;
  purpose: "verification" | "transactional";
  variables: string[];
  industries: string[];
  plans: string[];
  enabled: boolean;
  version: number;
  notes: string | null;
  business_copies: number;
  sample: string;
  updated_at: string;
}

/** Issue #902 §6 — acceptance vs. delivery, per business, last 24 hours. */
interface DeliveryRow {
  businessId: string;
  businessName: string | null;
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
  lastAttemptAt: string | null;
}

/** Issue #902 §9 item 2 — the same question per campaign, with both latencies. */
interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

interface CampaignDeliveryRow {
  campaignId: string;
  businessId?: string;
  businessName?: string | null;
  campaignName: string | null;
  channel: "sms" | "email";
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
  queueLatency: LatencyStats | null;
  sendLatency: LatencyStats | null;
  lastAttemptAt: string | null;
  health: keyof typeof DELIVERY_LABELS;
}

/** Issue #902 §3 — what needs a human, in the service's own words. */
interface ServiceAlert {
  id: string;
  kind: string;
  severity: "critical" | "warning" | "info";
  businessId: string | null;
  businessName: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgementNote: string | null;
  detail: Record<string, unknown>;
}

/** Issue #902 §9 item 4 — the master credit the last funding pass observed. */
interface MasterBalance {
  rial: number | null;
  observedAt: string | null;
  checkedAt: string | null;
  state: "unknown" | "current" | "unreadable" | "stale";
  ageMinutes: number | null;
}

/** Issue #902 §9 item 1 — the queued work the funding planner sizes against. */
interface PendingDemand {
  businessId: string;
  messages: number;
  segments: number;
  campaigns: number;
}

interface Snapshot {
  error?: string;
  policy: ManagedPolicy;
  masterBalance: MasterBalance;
  pendingDemand: PendingDemand[];
  accounts: ManagedAccount[];
  templates: CatalogTemplate[];
  masterTemplates: MasterTemplate[];
  delivery: DeliveryRow[];
  campaignDelivery: CampaignDeliveryRow[];
  /** Issue #902 §9 item 2 — a quarter of delivery, bucketed weekly. */
  deliveryTrend: DeliveryTrendSummary & { granularity: string; days: number; businesses?: number };
  alerts: ServiceAlert[];
  alertSummary: { critical: number; warning: number; info: number; unacknowledged: number; total: number };
  recentJobs: ManagedJob[];
  unresolvedTransfers: UnresolvedTransfer[];
  margin: MarginRow[];
  reconciliation: ReconciliationRow[];
}

/**
 * The operator copy for each alert kind, mirrored from `alert-service.ts`.
 * Duplicated rather than imported because the API sends a kind and the console
 * decides how to say it — the server's copy is for logs and API consumers.
 */
const ALERT_COPY: Record<string, { title: string; action: string }> = {
  master_credit_low: {
    title: "اعتبار حساب اصلی در آستانهٔ پایان است",
    action: "اعتبار حساب اصلی را شارژ کنید یا سقف‌های شارژ خودکار را بازبینی کنید.",
  },
  master_balance_unknown: {
    title: "موجودی حساب اصلی نامشخص است؛ شارژ خودکار متوقف شد",
    action: "کلید حساب اصلی و اتصال به تأمین‌کننده را بررسی کنید؛ شارژ خودکار موجودی را خودش می‌خواند.",
  },
  transactional_reserve_held: {
    title: "شارژ خودکار بازاریابی به ذخیرهٔ تراکنشی رسیده است",
    action:
      "اعتبار حساب مادر را شارژ کنید؛ این سهم برای پیام ورود و پیام سفارش نگه داشته شده است.",
  },
  fleet_cap_reached: {
    title: "سقف روزانهٔ شارژ همهٔ کسب‌وکارها پر شده است",
    action: "سقف روزانهٔ سراسری را بالا ببرید یا تا فردا صبر کنید.",
  },
  child_cap_reached: {
    title: "سقف اعتبار مجاز این کسب‌وکار پر شده است",
    action: "سقف اعتبار این کسب‌وکار را بالا ببرید یا موجودی آن را بازبینی کنید.",
  },
  daily_cap_reached: {
    title: "سقف شارژ روزانهٔ این کسب‌وکار پر شده است",
    action: "سقف شارژ روزانهٔ این کسب‌وکار را بازبینی کنید.",
  },
  unresolved_transfer: {
    title: "یک انتقال اعتبار با نتیجهٔ نامشخص در انتظار بررسی است",
    action: "انتقال را در پنل تأمین‌کننده بررسی کنید؛ انتقال دوباره انجام ندهید.",
  },
  funding_failed: {
    title: "انتقال اعتبار به حساب سرویس این کسب‌وکار ناموفق بود",
    action: "پس از بررسی وضعیت حساب، شارژ دستی همان مبلغ را انجام دهید.",
  },
  reconciliation_drift: {
    title: "مغایرت بین موجودی تأمین‌کننده و دفتر داخلی",
    action: "گردش حساب سرویس را بررسی و مغایرت را ثبت کنید.",
  },
  reconciliation_incomplete: {
    title: "بازخوانی موجودی تأمین‌کننده انجام نشد",
    action: "اتصال به تأمین‌کننده را بررسی کنید؛ پاس بعدی دوباره تلاش می‌کند.",
  },
  account_suspended: {
    title: "وضعیت حساب سرویس با تأمین‌کننده هم‌خوان نیست",
    action: "وضعیت حساب را با پنل تأمین‌کننده هم‌خوان کنید و در صورت نیاز دوباره فعال کنید.",
  },
  provisioning_failed: {
    title: "راه‌اندازی حساب سرویس این کسب‌وکار ناموفق بود",
    action: "کار راه‌اندازی را از پنل دوباره اجرا کنید و علت را بررسی کنید.",
  },
  tariff_missing: {
    title: "تعرفهٔ تأمین‌کننده برای این کسب‌وکار ثبت نشده است",
    action: "حساب را با تأمین‌کننده همگام کنید تا تعرفه ثبت شود.",
  },
};

const SEVERITY_LABELS: Record<ServiceAlert["severity"], string> = {
  critical: "بحرانی",
  warning: "هشدار",
  info: "اطلاع",
};

const STATE_LABELS: Record<ManagedAccount["state"], string> = {
  not_provisioned: "در انتظار",
  pending: "در صف",
  provisioning: "در حال ساخت",
  active: "فعال",
  retry_pending: "تلاش دوباره",
  attention_required: "نیازمند اقدام",
  suspended: "معلق",
};

const PURPOSE_LABELS: Record<"verification" | "transactional", string> = {
  verification: "ورود و تأیید",
  transactional: "اطلاع‌رسانی تراکنشی",
};

/** Why a test send was refused, in the console's own words. */
const SEND_BLOCK_LABELS: Record<string, string> = {
  template_not_found: "پیام یافت نشد",
  template_not_approved: "پیام هنوز تأیید نشده است",
  template_archived: "پیام از فهرست خارج شده است",
  template_variables_undeclared: "متغیرهای پیام تعریف نشده‌اند",
  invalid_receptor: "شمارهٔ گیرنده معتبر نیست",
  sms_not_ready: "حساب پیامکی این کسب‌وکار آماده نیست",
  insufficient_credit: "اعتبار کیف پول کسب‌وکار کافی نیست",
  pricing_unavailable: "تعرفهٔ ارسال در دسترس نیست",
  variable_missing: "مقدار یکی از متغیرها وارد نشده است",
  variable_invalid: "مقدار یکی از متغیرها معتبر نیست",
  variables_mismatch: "تعداد متغیرها با متن پیام هم‌خوان نیست",
  variable_not_allowed: "متغیر ناشناخته",
};

/** What each variable means, for the operator's input label. */
const VARIABLE_LABELS: Record<string, string> = {
  code: "کد",
  customer_name: "نام مشتری",
  store_name: "نام فروشگاه",
  order_number: "شمارهٔ سفارش",
  amount: "مبلغ (ریال)",
  date: "تاریخ",
};

/** Believable values, so a test send needs no typing at all. */
const SAMPLE_VALUES: Record<string, string> = {
  code: "482913",
  customer_name: "سارا محمدی",
  store_name: "فروشگاه نمونه",
  order_number: "1042",
  amount: "250000",
  date: "2026-10-28",
};

const TEMPLATE_STATE_LABELS: Record<CatalogTemplate["state"], string> = {
  draft: "پیش‌نویس",
  submitted: "در حال بررسی",
  approved: "تأییدشده",
  rejected: "رد‌شده",
  disabled: "غیرفعال",
};

/** Issue #902 #3 — how the fleet's spend is classified for the reserve. */
const FUNDING_PURPOSE_LABELS: Record<ManagedPolicy["fundingPurpose"], string> = {
  marketing: "بازاریابی — ذخیرهٔ تراکنشی را مصرف نمی‌کند",
  transactional: "تراکنشی — می‌تواند از ذخیرهٔ تراکنشی استفاده کند",
};

/**
 * One line about the master's credit, saying how old it is and whether the last
 * read worked — because a figure with no age is a number an operator will
 * quote as if it were current.
 */
function masterBalanceLine(balance: MasterBalance): string {
  if (balance.state === "unknown" || balance.rial === null) {
    return "موجودی حساب اصلی: هنوز خوانده نشده است؛ پاس بعدی شارژ خودکار آن را می‌خواند.";
  }
  const age =
    balance.ageMinutes === null
      ? ""
      : balance.ageMinutes < 60
        ? ` (${formatPersianNumber(balance.ageMinutes)} دقیقه پیش)`
        : ` (${formatPersianNumber(Math.floor(balance.ageMinutes / 60))} ساعت پیش)`;
  const value = `موجودی حساب اصلی: ${tomanLabel(balance.rial)}${age}`;
  if (balance.state === "unreadable") {
    return `${value} — آخرین خواندن ناموفق بود؛ این عدد مربوط به آخرین خواندن موفق است.`;
  }
  if (balance.state === "stale") {
    return `${value} — قدیمی‌تر از ${formatPersianNumber(Math.floor(MASTER_BALANCE_STALE_HOURS))} ساعت؛ وضعیت فعلی حساب اصلی نامعلوم است.`;
  }
  return value;
}

const STRATEGY_LABELS: Record<ManagedPolicy["fundingStrategy"], string> = {
  jit: "به‌موقع (JIT) — هر بار زیر هدف",
  low_watermark: "خط آب پایین — فقط پس از افت به آستانه",
  scheduled: "زمان‌بندی‌شده — فقط در بازهٔ ساعتی",
  manual: "دستی — هرگز خودکار",
};

const DELIVERY_LABELS: Record<"healthy" | "degraded" | "attention" | "idle", string> = {
  healthy: "سالم",
  degraded: "نیازمند توجه",
  attention: "نرخ خطای بالا",
  idle: "بدون ارسال",
};

/**
 * Milliseconds as seconds, or «—» when nothing was measured.
 *
 * A `null` percentile is "no measurement", never `0 ms`: an operator reading
 * "0" concludes the end is fast, which is the one thing the report cannot say.
 */
function latencyLabel(stats: LatencyStats | null): string {
  if (!stats) return "—";
  const seconds = (ms: number) => (ms / 1000).toFixed(ms < 1_000 ? 2 : 1);
  return `${seconds(stats.p50)} / ${seconds(stats.p95)}`;
}

/**
 * The rule is the server's, imported rather than copied: `delivery-health.ts` is
 * pure, so the card can call the same function the reports call. It used to keep
 * its own copy of the thresholds with a comment saying it mirrored them, which is
 * how a rule becomes two rules.
 */
function healthOf(row: DeliveryRow): keyof typeof DELIVERY_LABELS {
  return deliveryHealth(row);
}

const JOB_LABELS: Record<string, string> = {
  provision: "ساخت",
  sync: "همگام‌سازی",
  suspend: "تعلیق",
  reactivate: "فعال‌سازی",
  rotate_key: "چرخش کلید",
  adopt: "پذیرش",
};

const dateTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value))
    : "—";

export function ManagedSmsAccountsCard({ canManage }: { canManage: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [policy, setPolicy] = useState<ManagedPolicy | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [transfer, setTransfer] = useState({ businessId: "", amountRial: "", reason: "" });
  const [probe, setProbe] = useState<{ eligible: boolean; code: string | null } | null>(null);
  // Issue #902 §5 — the operator's test send: one number, re-used per message.
  const [testReceptor, setTestReceptor] = useState("");
  const [testValues, setTestValues] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const result = await api<Snapshot>("/api/platform/sms/accounts");
    if (!result.ok) {
      setError(result.data.error ?? "دریافت حساب‌های مدیریت‌شده ممکن نشد.");
      return;
    }
    setSnapshot(result.data);
    setPolicy(result.data.policy);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const accounts = snapshot?.accounts ?? [];
    return {
      active: accounts.filter((account) => account.state === "active").length,
      attention: accounts.filter((account) => account.state === "attention_required").length,
      suspended: accounts.filter((account) => account.state === "suspended").length,
    };
  }, [snapshot]);

  // §9 item 1: queued work by business, so the account row can say why a child
  // was funded above its standing buffer.
  const demandByBusiness = useMemo(() => {
    const map = new Map<string, PendingDemand>();
    for (const row of snapshot?.pendingDemand ?? []) map.set(row.businessId, row);
    return map;
  }, [snapshot]);

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError("");
    setNotice("");
    const result = await api<{ error?: string; [key: string]: unknown }>(
      "/api/platform/sms/accounts",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    setBusy("");
    if (!result.ok) {
      setError(result.data.error ?? "عملیات انجام نشد.");
      return null;
    }
    await load();
    return result.data;
  }

  async function acknowledgeAlert(alertId: string) {
    await post({ action: "acknowledge_alert", alertId }, `ack:${alertId}`);
  }

  async function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!policy) return;
    const done = await post(
      {
        action: "policy",
        enabled: policy.enabled,
        planId: policy.planId,
        minAllowedCreditRial: policy.minAllowedCreditRial,
        senderLines: policy.senderLines.join(","),
        note: policy.note,
        fundingBufferMessages: policy.fundingBufferMessages,
        fundingChildCapRial: policy.fundingChildCapRial,
        fundingDailyCapRial: policy.fundingDailyCapRial,
        fundingMasterFloorRial: policy.fundingMasterFloorRial,
        fundingStrategy: policy.fundingStrategy,
        fundingLowWatermarkMessages: policy.fundingLowWatermarkMessages,
        fundingWindowStartHour: policy.fundingWindowStartHour,
        fundingWindowEndHour: policy.fundingWindowEndHour,
        fundingGlobalDailyCapRial: policy.fundingGlobalDailyCapRial,
        fundingTransactionalReserveRial: policy.fundingTransactionalReserveRial,
        fundingPurpose: policy.fundingPurpose,
      },
      "policy",
    );
    if (done) setNotice("سیاست حساب‌های مدیریت‌شده ذخیره شد.");
  }

  async function runProbe() {
    const result = await post({ action: "probe" }, "probe");
    if (!result) return;
    const value = result as { eligible?: boolean; code?: string | null };
    setProbe({ eligible: value.eligible === true, code: value.code ?? null });
  }

  async function runAction(businessId: string, action: string) {
    const done = await post({ action, businessId }, action + businessId);
    if (done) setNotice(`درخواست «${JOB_LABELS[action] ?? action}» ثبت شد.`);
  }

  async function submitTemplate(template: CatalogTemplate) {
    const done = await post({ action: "template_submit", templateId: template.id }, `template:${template.id}`);
    if (done) setNotice(`«${template.title}» برای بررسی ارسال شد.`);
  }

  async function toggleMasterTemplate(template: MasterTemplate) {
    // Enabling/disabling is not a new version: no business's approved copy
    // changes, so nothing needs re-approval.
    const done = await post(
      { action: "master_template_toggle", masterTemplateId: template.id, enabled: !template.enabled },
      `master:${template.id}`,
    );
    if (done) {
      setNotice(
        template.enabled
          ? `«${template.title}» از کتابخانه کنار گذاشته شد؛ نسخه‌های موجود کسب‌وکارها دست‌نخورده می‌مانند.`
          : `«${template.title}» برای کسب‌وکارهای هدف فعال شد.`,
      );
    }
  }

  /**
   * Issue #902 §5 — prove a message works before automation depends on it.
   *
   * The receptor and the values are the operator's; the send itself is the real
   * path (retail reserved, child key, settle once), so a success here means a
   * trigger will work too.
   */
  async function sendTest(template: CatalogTemplate) {
    if (!testReceptor.trim()) {
      setError("شمارهٔ آزمایشی را وارد کنید.");
      return;
    }
    const values: Record<string, string> = {};
    for (const name of template.variables) {
      const raw = (testValues[`${template.id}:${name}`] ?? "").trim();
      values[name] = raw || SAMPLE_VALUES[name] || "";
    }
    const result = await post(
      {
        action: "template_send_test",
        businessId: template.business_id,
        templateId: template.id,
        receptor: testReceptor.trim(),
        variables: values,
      },
      `send:${template.id}`,
    );
    if (!result) return;
    const outcome = (result as { outcome?: { status?: string; code?: string } }).outcome;
    setNotice(
      outcome?.status === "sent"
        ? `پیام آزمایشی «${template.title}» ارسال شد.`
        : outcome?.status === "unknown"
          ? `نتیجهٔ ارسال «${template.title}» نامشخص است؛ مبلغ رزروشده بازگردانده نشد.`
          : `ارسال «${template.title}» انجام نشد: ${SEND_BLOCK_LABELS[outcome?.code ?? ""] ?? outcome?.code ?? "نامشخص"}`,
    );
  }

  async function archiveTemplate(template: CatalogTemplate) {
    const done = await post({ action: "template_archive", templateId: template.id }, `archive:${template.id}`);
    if (done) {
      setNotice(
        template.last_sync_error
          ? `«${template.title}» از فهرست خارج شد؛ نسخهٔ ارائه‌دهنده نیاز به پاک‌سازی دستی دارد.`
          : `«${template.title}» از فهرست خارج و نسخهٔ ارائه‌دهنده حذف شد.`,
      );
    }
  }

  async function submitTransfer(event: FormEvent) {
    event.preventDefault();
    if (!transfer.businessId || !transfer.amountRial) return;
    const result = await post(
      {
        action: "transfer",
        businessId: transfer.businessId.trim(),
        amountRial: Number(transfer.amountRial),
        reason: transfer.reason || undefined,
        // A per-click key: a double click is answered from the committed row,
        // never by moving money twice.
        idempotencyKey: `console:${crypto.randomUUID()}`,
      },
      "transfer",
    );
    if (result) {
      setTransfer({ businessId: "", amountRial: "", reason: "" });
      setNotice("انتقال اعتبار ثبت شد؛ نتیجهٔ نهایی در فهرست انتقال‌های بازنشده دیده می‌شود.");
    }
  }

  if (!snapshot || !policy) return <Card title="حساب‌های مدیریت‌شده">{error ? <ErrorBox>{error}</ErrorBox> : null}در حال خواندن…</Card>;

  return (
    <div className="space-y-4">
      <Card title="حساب‌های مدیریت‌شدهٔ پیامک">
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        <div className="grid gap-3 text-sm sm:grid-cols-4">
          <p>فعال: <b>{formatPersianNumber(counts.active)}</b></p>
          <p>نیازمند اقدام: <b>{formatPersianNumber(counts.attention)}</b></p>
          <p>معلق: <b>{formatPersianNumber(counts.suspended)}</b></p>
          <p>کل: <b>{formatPersianNumber(snapshot.accounts.length)}</b></p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={() => void runProbe()} disabled={!canManage || busy === "probe"}>
            {busy === "probe" ? <Loader2Icon className="size-4 animate-spin" /> : <ShieldCheckIcon className="size-4" />}
            بررسی دسترسی حساب مادر
          </Button>
          <Button variant="ghost" onClick={() => void load()} disabled={busy !== ""}>
            <RefreshCwIcon className="size-4" /> تازه‌سازی
          </Button>
          {probe ? (
            <span className="text-sm">
              نتیجهٔ بررسی:{" "}
              <b>{probe.eligible ? "حساب مادر مجاز است" : `غیرمجاز (${probe.code ?? "نامشخص"})`}</b>
            </span>
          ) : null}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          حساب فرزند تنها پس از تأیید دسترسی حساب مادر و با روشن‌کردن سیاست زیر ساخته می‌شود.
          کلید فرزند هرگز نمایش داده نمی‌شود؛ فقط چهار رقم آخر آن برای تطبیق.
        </p>
      </Card>

      <Card title="سیاست ساخت و تأمین اعتبار">
        {/* §9 item 4: the balance behind every funding decision on this card,
            with its age — read, not asked for. */}
        <p
          className="mb-4 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          data-testid="master-balance-mirror"
        >
          {masterBalanceLine(snapshot.masterBalance)}
          {snapshot.masterBalance.checkedAt ? (
            <span dir="ltr"> · {dateTime(snapshot.masterBalance.checkedAt)}</span>
          ) : null}
        </p>
        <form onSubmit={savePolicy} className="grid gap-3 sm:grid-cols-2">
          <Field label="ساخت خودکار حساب فرزند" hint="تا روشن نشدن این گزینه هیچ حسابی ساخته نمی‌شود.">
            <select
              className={inputClass}
              value={policy.enabled ? "yes" : "no"}
              disabled={!canManage}
              onChange={(event) => setPolicy({ ...policy, enabled: event.target.value === "yes" })}
            >
              <option value="no">خاموش</option>
              <option value="yes">روشن</option>
            </select>
          </Field>
          <Field label="شناسهٔ تعرفهٔ ارائه‌دهنده" hint="خالی = تعرفهٔ پیش‌فرض حساب مادر.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.planId ?? ""}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({ ...policy, planId: event.target.value ? Number(event.target.value) : null })
              }
            />
          </Field>
          <Field label="حداقل اعتبار مجاز فرزند (ریال)">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.minAllowedCreditRial}
              disabled={!canManage}
              onChange={(event) => setPolicy({ ...policy, minAllowedCreditRial: Number(event.target.value) || 0 })}
            />
          </Field>
          <Field label="خطوط ارسال" hint="با کاما جدا کنید.">
            <input
              className={inputClass}
              dir="ltr"
              value={policy.senderLines.join(",")}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  senderLines: event.target.value.split(",").map((line) => line.trim()).filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="بافر پیام برای تأمین خودکار" hint="۰ = تأمین خودکار خاموش؛ عدد = تعداد پیام قابل ارسال که حساب فرزند باید داشته باشد.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingBufferMessages}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({ ...policy, fundingBufferMessages: Number(event.target.value) || 0 })
              }
            />
          </Field>
          <Field label="سقف اعتبار هر فرزند (ریال)" hint="خالی = بدون سقف.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingChildCapRial ?? ""}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  fundingChildCapRial: event.target.value ? Number(event.target.value) : null,
                })
              }
            />
          </Field>
          <Field label="سقف تأمین روزانه (ریال)" hint="خالی = بدون سقف.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingDailyCapRial ?? ""}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  fundingDailyCapRial: event.target.value ? Number(event.target.value) : null,
                })
              }
            />
          </Field>
          <Field
            label="ذخیرهٔ تراکنشی حساب مادر (ریال)"
            hint="بالای کف، سهمی که شارژ بازاریابی نمی‌تواند مصرف کند؛ برای بازگرداندن پیام ورود و پیام سفارش وقتی همهٔ حساب‌ها پر شده‌اند. ۰ = بدون ذخیره."
          >
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingTransactionalReserveRial}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  fundingTransactionalReserveRial: Number(event.target.value) || 0,
                })
              }
            />
          </Field>
          <Field
            label="دستهٔ مصرف این ناوگان"
            hint="بازاریابی از ذخیرهٔ تراکنشی استفاده نمی‌کند؛ تراکنشی می‌تواند. پیش‌فرض بازاریابی است تا فعال‌کردن ذخیره هرگز پول بیشتری آزاد نکند."
          >
            <select
              className={inputClass}
              value={policy.fundingPurpose}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  fundingPurpose: event.target.value as ManagedPolicy["fundingPurpose"],
                })
              }
            >
              {(Object.keys(FUNDING_PURPOSE_LABELS) as ManagedPolicy["fundingPurpose"][]).map(
                (key) => (
                  <option key={key} value={key}>
                    {FUNDING_PURPOSE_LABELS[key]}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="کف اعتبار حساب مادر (ریال)" hint="با مقدار مثبت، تأمین خودکار بدون موجودی مشخص انجام نمی‌شود.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingMasterFloorRial}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({ ...policy, fundingMasterFloorRial: Number(event.target.value) || 0 })
              }
            />
          </Field>
          <Field
            label="راهبرد تأمین اعتبار"
            hint="JIT هر بار که فرزند زیر هدف باشد تأمین می‌کند؛ خط آب پایین فقط پس از افت به آستانه؛ زمان‌بندی‌شده تنها در بازهٔ ساعتی (UTC)."
          >
            <select
              className={inputClass}
              value={policy.fundingStrategy}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  fundingStrategy: event.target.value as ManagedPolicy["fundingStrategy"],
                })
              }
            >
              {(Object.keys(STRATEGY_LABELS) as ManagedPolicy["fundingStrategy"][]).map((key) => (
                <option key={key} value={key}>
                  {STRATEGY_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="آستانهٔ خط آب پایین (پیام)" hint="۰ = همان بافر؛ مقدار بالاتر از بافر نادیده گرفته می‌شود.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingLowWatermarkMessages}
              disabled={!canManage || policy.fundingStrategy !== "low_watermark"}
              onChange={(event) =>
                setPolicy({ ...policy, fundingLowWatermarkMessages: Number(event.target.value) || 0 })
              }
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="شروع بازهٔ UTC" hint="۰ تا ۲۳">
              <input
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={policy.fundingWindowStartHour}
                disabled={!canManage || policy.fundingStrategy !== "scheduled"}
                onChange={(event) =>
                  setPolicy({ ...policy, fundingWindowStartHour: Number(event.target.value) || 0 })
                }
              />
            </Field>
            <Field label="پایان بازهٔ UTC" hint="برابر با شروع = تمام شبانه‌روز">
              <input
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={policy.fundingWindowEndHour}
                disabled={!canManage || policy.fundingStrategy !== "scheduled"}
                onChange={(event) =>
                  setPolicy({ ...policy, fundingWindowEndHour: Number(event.target.value) || 0 })
                }
              />
            </Field>
          </div>
          <Field
            label="سقف تأمین روزانهٔ همهٔ کسب‌وکارها (ریال)"
            hint="نگهبان مصرف جمعی: خالی = بدون سقف. پیش از سقف هر فرزند بررسی می‌شود."
          >
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingGlobalDailyCapRial ?? ""}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  fundingGlobalDailyCapRial: event.target.value ? Number(event.target.value) : null,
                })
              }
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="یادداشت سیاست">
              <textarea
                className={`${inputClass} h-20`}
                value={policy.note ?? ""}
                disabled={!canManage}
                onChange={(event) => setPolicy({ ...policy, note: event.target.value || null })}
              />
            </Field>
          </div>
          {canManage ? (
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy === "policy"}>
                {busy === "policy" ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}
                ذخیرهٔ سیاست
              </Button>
            </div>
          ) : null}
        </form>
      </Card>

      <Card title="انتقال اعتبار به حساب فرزند">
        <form onSubmit={submitTransfer} className="grid gap-3 sm:grid-cols-3">
          <Field label="شناسهٔ کسب‌وکار">
            <input
              className={inputClass}
              dir="ltr"
              value={transfer.businessId}
              disabled={!canManage}
              onChange={(event) => setTransfer({ ...transfer, businessId: event.target.value })}
            />
          </Field>
          <Field label="مبلغ (ریال)" hint="حداقل ۱۰۰۰ ریال.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={transfer.amountRial}
              disabled={!canManage}
              onChange={(event) => setTransfer({ ...transfer, amountRial: event.target.value })}
            />
          </Field>
          <Field label="دلیل">
            <input
              className={inputClass}
              value={transfer.reason}
              disabled={!canManage}
              onChange={(event) => setTransfer({ ...transfer, reason: event.target.value })}
            />
          </Field>
          {canManage ? (
            <div className="sm:col-span-3">
              <Button type="submit" disabled={busy === "transfer" || !transfer.businessId || !transfer.amountRial}>
                {busy === "transfer" ? <Loader2Icon className="size-4 animate-spin" /> : <WalletCardsIcon className="size-4" />}
                انتقال اعتبار
              </Button>
            </div>
          ) : null}
        </form>
        <p className="mt-3 text-xs text-muted-foreground">
          اعتبار ارائه‌دهنده پیش‌تأمین داخلی است و هرگز به‌عنوان اعتبار کسب‌وکار نمایش داده نمی‌شود؛
          موجودی قابل خرج کسب‌وکار همان کیف پول مرکزی است. هر انتقال یک ردیف دفتر با کلید یکتا دارد.
        </p>
      </Card>

      <Card title={`حساب‌ها (${formatPersianNumber(snapshot.accounts.length)})`}>
        {/* Issue #902 §6 — the dedicated audit view is the shared log, filtered
            rather than copied: the family filter narrows it to `sms.*`, so the
            operator reads this card's own actions instead of the whole console's. */}
        <p className="mb-2 text-xs text-muted-foreground">
          <Link
            href="/platform/audit?actionFamily=sms"
            className="text-sky-700 hover:underline dark:text-sky-300"
          >
            همهٔ رویدادهای پیامک مدیریت‌شده ←
          </Link>{" "}
          — ساخت حساب، تعلیق، تأمین اعتبار و تغییر الگوها، با دادهٔ کامل هر رویداد.
        </p>
        <div className="space-y-2">
          {snapshot.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">هنوز حسابی ساخته نشده است.</p>
          ) : (
            snapshot.accounts.map((account) => (
              <div key={account.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {account.businessName ?? account.businessId} • {STATE_LABELS[account.state]}
                    {account.attentionReason ? ` • ${account.attentionReason}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {account.username} • {account.keyHint ? `••••${account.keyHint.replace(/^•+/, "")}` : "بدون کلید"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  <Link
                    href={`/platform/audit?actionFamily=sms&businessId=${account.businessId}`}
                    className="text-sky-700 hover:underline dark:text-sky-300"
                  >
                    رویدادهای این حساب ←
                  </Link>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {(() => {
                    // §9 item 1: a child holding an approved queue is being
                    // funded for that queue, not just for the standing buffer.
                    // Without this line the transfer looks arbitrary.
                    const demand = demandByBusiness.get(account.businessId);
                    if (!demand || demand.messages === 0) return null;
                    return (
                      <>
                        صف فعال: {formatPersianNumber(demand.messages)} پیام (
                        {formatPersianNumber(demand.segments)} قطعه) در{" "}
                        {formatPersianNumber(demand.campaigns)} کمپین •{" "}
                      </>
                    );
                  })()}
                  تعرفه: {account.pricingName ?? "—"} • فارسی {tomanLabel(account.smsFarsiCostRial ?? 0)} • انگلیسی{" "}
                  {tomanLabel(account.smsEnglishCostRial ?? 0)} • موجودی داخلی{" "}
                  {account.providerBalanceRial === null ? "نامشخص" : tomanLabel(account.providerBalanceRial)} •{" "}
                  {dateTime(account.providerBalanceAt)}
                </p>
                {canManage ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => void runAction(account.businessId, "sync")}>
                      همگام‌سازی
                    </Button>
                    <Button variant="ghost" onClick={() => void runAction(account.businessId, "fund")}>
                      تأمین اعتبار
                    </Button>
                    <Button variant="ghost" onClick={() => void runAction(account.businessId, "reconcile")}>
                      تطبیق
                    </Button>
                    <Button variant="ghost" onClick={() => void runAction(account.businessId, "rotate_key")}>
                      چرخش کلید
                    </Button>
                    {account.state === "suspended" ? (
                      <Button variant="ghost" onClick={() => void runAction(account.businessId, "reactivate")}>
                        فعال‌سازی
                      </Button>
                    ) : (
                      <Button variant="danger" onClick={() => void runAction(account.businessId, "suspend")}>
                        تعلیق
                      </Button>
                    )}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </Card>

      {/* Issue #902 §3 — the attention ledger. Deliberately above the fleet and
          the delivery table: "what needs me" outranks "what is the state". */}
      <Card
        title={`نیازمند اقدام (${formatPersianNumber(snapshot.alertSummary?.total ?? 0)}${
          (snapshot.alertSummary?.critical ?? 0) > 0
            ? ` — ${formatPersianNumber(snapshot.alertSummary.critical)} بحرانی`
            : ""
        })`}
      >
        {(snapshot.alerts ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            هیچ موردی نیازمند اقدام نیست. شارژ خودکار، مغایرت‌گیری و وضعیت حساب‌ها سالم است.
          </p>
        ) : (
          <div className="space-y-2 text-sm">
            {(snapshot.alerts ?? []).map((alert) => {
              const copy = ALERT_COPY[alert.kind] ?? {
                title: alert.kind,
                action: "این مورد را در گزارش‌های سرویس بررسی کنید.",
              };
              const critical = alert.severity === "critical";
              return (
                <div
                  key={alert.id}
                  className={`rounded-lg border px-3 py-2 ${
                    critical ? "border-destructive/50 bg-destructive/5" : "border-border"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {copy.title}
                      {alert.businessName ? ` — ${alert.businessName}` : ""}
                    </span>
                    <span className={critical ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                      {SEVERITY_LABELS[alert.severity]} • {formatPersianNumber(alert.occurrences)} بار • آخرین{" "}
                      {dateTime(alert.lastSeenAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{copy.action}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {alert.acknowledgedAt ? (
                      <span className="text-xs text-muted-foreground">
                        بررسی شد در {dateTime(alert.acknowledgedAt)}
                        {alert.acknowledgementNote ? ` — ${alert.acknowledgementNote}` : ""}
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        disabled={!canManage || busy === `ack:${alert.id}`}
                        onClick={() => void acknowledgeAlert(alert.id)}
                      >
                        بررسی کردم
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          هر مورد یک ردیف باز است، نه یک گزارش تکراری؛ با برطرف‌شدن شرط، خودکار بسته می‌شود. «بررسی کردم»
          یعنی یک اپراتور آن را دیده است، نه اینکه برطرف شده.
        </p>
      </Card>

      {/* Issue #902 §6 — acceptance ≠ delivery. A child can be active and funded
          and still fail every send; this is the only view that shows it. */}
      <Card title="وضعیت تحویل پیام (۲۴ ساعت اخیر)">
        {(snapshot.delivery ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">در این بازه ارسالی ثبت نشده است.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="p-2 text-right">کسب‌وکار</th>
                  <th className="p-2 text-right">پذیرفته</th>
                  <th className="p-2 text-right">تحویل</th>
                  <th className="p-2 text-right">ناموفق</th>
                  <th className="p-2 text-right">در صف</th>
                  <th className="p-2 text-right">وضعیت</th>
                  <th className="p-2 text-right">آخرین تلاش</th>
                </tr>
              </thead>
              <tbody>
                {(snapshot.delivery ?? []).map((row) => {
                  const health = healthOf(row);
                  return (
                    <tr key={row.businessId} className="border-t border-border/60">
                      <td className="p-2">{row.businessName ?? row.businessId}</td>
                      <td className="p-2 tabular-nums">{formatPersianNumber(row.sent)}</td>
                      <td className="p-2 tabular-nums">{formatPersianNumber(row.delivered)}</td>
                      <td className={`p-2 tabular-nums ${row.failed > 0 ? "text-destructive" : ""}`}>
                        {formatPersianNumber(row.failed)}
                      </td>
                      <td className="p-2 tabular-nums">{formatPersianNumber(row.pending)}</td>
                      <td className={`p-2 ${health === "attention" ? "text-destructive" : "text-muted-foreground"}`}>
                        {DELIVERY_LABELS[health]}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">{dateTime(row.lastAttemptAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          «پذیرفته» یعنی ارائه‌دهنده پیام را قبول کرده؛ «تحویل» یعنی بعداً تأیید شده است. ردیف‌ها بر
          اساس بیشترین خطا مرتب شده‌اند.
        </p>
      </Card>

      {/* Issue #902 §9 item 2 — the fleet row above answers "are messages
          arriving"; this answers "is one campaign stuck, and at which end".
          Queue and send latency are shown apart on purpose: a backed-up drain
          and a slow carrier have opposite fixes, and one averaged number would
          hide which one is happening. */}
      <Card title={`تحویل به تفکیک کمپین (۷ روز اخیر)`}>
        {(snapshot.campaignDelivery ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">در این بازه کمپینی ارسال نشده است.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="p-2 text-right">کمپین</th>
                  <th className="p-2 text-right">کسب‌وکار</th>
                  <th className="p-2 text-right">پذیرفته</th>
                  <th className="p-2 text-right">تحویل</th>
                  <th className="p-2 text-right">ناموفق</th>
                  <th className="p-2 text-right">در صف</th>
                  <th className="p-2 text-right">تأخیر صف (میانه / صدک ۹۵)</th>
                  <th className="p-2 text-right">تأخیر ارائه‌دهنده (میانه / صدک ۹۵)</th>
                  <th className="p-2 text-right">وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {(snapshot.campaignDelivery ?? []).map((row) => (
                  <tr key={row.campaignId} className="border-t border-border/60">
                    <td className="p-2">
                      {row.campaignName ?? "—"}
                      <span className="ms-1 text-xs text-muted-foreground">
                        {row.channel === "email" ? "ایمیل" : "پیامک"}
                      </span>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {row.businessName ?? row.businessId ?? "—"}
                    </td>
                    <td className="p-2 tabular-nums">{formatPersianNumber(row.sent)}</td>
                    <td className="p-2 tabular-nums">{formatPersianNumber(row.delivered)}</td>
                    <td className={`p-2 tabular-nums ${row.failed > 0 ? "text-destructive" : ""}`}>
                      {formatPersianNumber(row.failed)}
                    </td>
                    <td className="p-2 tabular-nums">{formatPersianNumber(row.pending)}</td>
                    <td className="p-2 text-xs text-muted-foreground tabular-nums">
                      {latencyLabel(row.queueLatency)}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground tabular-nums">
                      {latencyLabel(row.sendLatency)}
                    </td>
                    <td
                      className={`p-2 ${row.health === "attention" ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {DELIVERY_LABELS[row.health]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          «تأخیر صف» مدت انتظار پیام در صف ارسال است و «تأخیر ارائه‌دهنده» مدت پاسخ ارائه‌دهنده.
          ردیف‌ها بر اساس بیشترین خطا مرتب شده‌اند.
        </p>
      </Card>

      {/* Issue #902 §9 item 2 — the long view. The two cards above answer "is
          anything failing now"; a series answers "did it get worse, and when".
          A bucket with no attempts is drawn as a gap and labelled «بدون داده»,
          never as a zero bar: silence and failure look identical on a chart that
          plots zeros, and only one of them is an emergency. */}
      <Card title={`روند تحویل (${formatPersianNumber(snapshot.deliveryTrend?.days ?? 90)} روز اخیر)`}>
        {(snapshot.deliveryTrend?.activeBuckets ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            در این بازه هیچ ارسالی ثبت نشده است؛ نبودِ داده با شکست یکی نیست.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span>
                پذیرفته: <b className="tabular-nums">{formatPersianNumber(snapshot.deliveryTrend.sent)}</b>
              </span>
              <span>
                تحویل: <b className="tabular-nums">{formatPersianNumber(snapshot.deliveryTrend.delivered)}</b>
              </span>
              <span className={snapshot.deliveryTrend.failed > 0 ? "text-destructive" : ""}>
                ناموفق: <b className="tabular-nums">{formatPersianNumber(snapshot.deliveryTrend.failed)}</b>
              </span>
              <span className="text-xs text-muted-foreground">
                نرخ خطا:{" "}
                {snapshot.deliveryTrend.failureRate === null
                  ? "—"
                  : `${formatPersianNumber(Math.round(snapshot.deliveryTrend.failureRate * 100))}٪`}
              </span>
              <span
                className={`text-xs ${
                  snapshot.deliveryTrend.worstHealth === "attention" ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                بدترین وضعیت: {TREND_HEALTH_LABELS[snapshot.deliveryTrend.worstHealth]}
              </span>
              <span className="text-xs text-muted-foreground">
                تأخیر صف (میانه / صدک ۹۵): {latencyLabel(snapshot.deliveryTrend.queueLatency)}
              </span>
            </div>
            <div className="mt-4 flex items-end gap-[2px]" role="img" aria-label="روند تحویل">
              {(snapshot.deliveryTrend.points ?? []).map((point) => {
                const max = Math.max(...snapshot.deliveryTrend.points.map((p) => p.decided + p.pending), 0);
                const height = point.hasData ? trendBarPercent(point.decided + point.pending, max) : null;
                const tone =
                  point.health === "attention"
                    ? "bg-destructive"
                    : point.health === "degraded"
                      ? "bg-amber-500"
                      : "bg-emerald-500";
                return (
                  <div
                    key={point.key}
                    className="flex min-w-0 flex-1 flex-col items-center gap-1"
                    title={`${point.label} — ${TREND_HEALTH_LABELS[point.health]}`}
                  >
                    {height === null ? (
                      <div className="h-16 w-full rounded-sm border border-dashed border-border/70" />
                    ) : (
                      <div
                        className={`w-full rounded-sm ${tone}`}
                        style={{ height: `${Math.max(4, Math.round((height / 100) * 64))}px` }}
                      />
                    )}
                    <span className="truncate text-[9px] text-muted-foreground">{point.label}</span>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              هر ستون یک بازه است؛ کادر خالی یعنی در آن بازه هیچ ارسالی ثبت نشده — نه اینکه همه
              شکست خورده باشند. نرخ خطا فقط روی ارسال‌هایی حساب می‌شود که نتیجه‌شان روشن شده است.
            </p>
          </>
        )}
      </Card>

      {/* Issue #902 §5 — the library the catalog is built from. An entry is
          offered only to the trades and plans it names, so a message a business
          does not need never appears on its screen; disabling one withdraws it
          from new businesses without touching a copy already approved. */}
      <Card title={`کتابخانهٔ الگوها (${formatPersianNumber((snapshot.masterTemplates ?? []).length)})`}>
        {(snapshot.masterTemplates ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">کتابخانه خالی است.</p>
        ) : (
          <div className="space-y-2 text-sm">
            {(snapshot.masterTemplates ?? []).map((template) => (
              <div key={template.id} className="rounded-lg border border-border px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words">
                    <b>{template.title}</b>
                    <span className="ms-2 text-xs text-muted-foreground">
                      {PURPOSE_LABELS[template.purpose]} • نسخهٔ {formatPersianNumber(template.version)}
                      {template.enabled ? "" : " • کنارگذاشته‌شده"}
                      {template.business_copies > 0
                        ? ` • ${formatPersianNumber(template.business_copies)} نسخه نزد کسب‌وکارها`
                        : ""}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {template.key}
                    </span>
                    {canManage ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-9"
                        disabled={busy === `master:${template.id}`}
                        onClick={() => void toggleMasterTemplate(template)}
                      >
                        {busy === `master:${template.id}` ? "…" : template.enabled ? "کنار گذاشتن" : "فعال‌سازی"}
                      </Button>
                    ) : null}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{template.sample}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  مخاطب: {template.industries.length ? template.industries.join("، ") : "همهٔ کسب‌وکارها"}
                  {" • "}
                  طرح: {template.plans.length ? template.plans.join("، ") : "همهٔ طرح‌ها"}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Issue #902 §5 — the catalog the tenants created. Approvals are the
          provider's; submission and retirement are ours. Rejected rows sort
          first in the API so the operator's next action is at the top. */}
      <Card title={`کاتالوگ الگوهای تأییدشده (${formatPersianNumber((snapshot.templates ?? []).length)})`}>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-muted-foreground">
            شمارهٔ آزمایشی (پیام آزمایشی با اعتبار همین کسب‌وکار ارسال می‌شود)
          </span>
          <input
            className="min-h-10 w-full rounded-md border border-border bg-background px-3 py-2"
            dir="ltr"
            inputMode="tel"
            placeholder="09121234567"
            value={testReceptor}
            onChange={(event) => setTestReceptor(event.target.value)}
          />
        </label>
        {(snapshot.templates ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز الگویی ساخته نشده است.</p>
        ) : (
          <div className="space-y-2 text-sm">
            {(snapshot.templates ?? []).map((template) => {
              const submitted = template.provider_template_id !== null;
              return (
                <div key={template.id} className="rounded-lg border border-border px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words">
                      <b>{template.title}</b>
                      <span className="ms-2 text-xs text-muted-foreground">
                        {template.business_name ?? template.business_id} • {TEMPLATE_STATE_LABELS[template.state]}
                        {template.revision > 0 ? ` • ویرایش ${formatPersianNumber(template.revision)}` : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground" dir="ltr">
                        {template.name}
                        {template.provider_template_id !== null ? `#${template.provider_template_id}` : ""}
                      </span>
                      {canManage && !template.archived_at && (template.state === "draft" || template.state === "rejected") ? (
                        <Button
                          type="button"
                          className="min-h-9"
                          disabled={busy === `template:${template.id}`}
                          onClick={() => void submitTemplate(template)}
                        >
                          {busy === `template:${template.id}` ? "…" : submitted ? "ارسال ویرایش برای بررسی" : "ارسال برای بررسی"}
                        </Button>
                      ) : null}
                      {canManage && template.state === "approved" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-9"
                          disabled={busy === `send:${template.id}`}
                          onClick={() => void sendTest(template)}
                        >
                          {busy === `send:${template.id}` ? "…" : "ارسال آزمایشی"}
                        </Button>
                      ) : null}
                      {canManage && !template.archived_at ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-9"
                          disabled={busy === `archive:${template.id}`}
                          onClick={() => void archiveTemplate(template)}
                        >
                          {busy === `archive:${template.id}` ? "…" : "خروج از فهرست"}
                        </Button>
                      ) : null}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{template.body}</p>
                  {canManage && template.state === "approved" && template.variables.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {template.variables.map((name, index) => (
                        <input
                          key={name}
                          className="min-h-9 w-36 rounded-md border border-border bg-background px-2 py-1 text-xs"
                          placeholder={`${VARIABLE_LABELS[name] ?? name} (%token${index === 0 ? "" : index + 1})`}
                          value={testValues[`${template.id}:${name}`] ?? ""}
                          onChange={(event) =>
                            setTestValues((current) => ({ ...current, [`${template.id}:${name}`]: event.target.value }))
                          }
                        />
                      ))}
                    </div>
                  ) : null}
                  {template.last_sync_error ? (
                    <p className="mt-1 text-xs text-destructive" dir="ltr">{template.last_sync_error}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="کارهای اخیر">
          <div className="space-y-2 text-sm">
            {snapshot.recentJobs.length === 0 ? (
              <p className="text-muted-foreground">کاری ثبت نشده است.</p>
            ) : (
              snapshot.recentJobs.slice(0, 10).map((job) => (
                <div key={job.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {JOB_LABELS[job.kind] ?? job.kind} • {job.state} • تلاش {formatPersianNumber(job.attempts)}
                  </span>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {job.lastErrorCode ?? "—"} • {dateTime(job.createdAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
        <Card title="انتقال‌های بازنشده">
          <div className="space-y-2 text-sm">
            {snapshot.unresolvedTransfers.length === 0 ? (
              <p className="text-muted-foreground">موردی نیست.</p>
            ) : (
              snapshot.unresolvedTransfers.map((row) => (
                <div key={row.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {tomanLabel(row.amountRial)} • {row.state}
                  </span>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {dateTime(row.createdAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card title="حاشیهٔ سود ۳۰ روز اخیر (فروش منهای هزینهٔ ارائه‌دهنده)">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="p-2 text-right">کسب‌وکار</th>
                <th className="p-2 text-right">فروش</th>
                <th className="p-2 text-right">هزینهٔ ارائه‌دهنده</th>
                <th className="p-2 text-right">حاشیه</th>
                <th className="p-2 text-right">ارسال</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.margin.length === 0 ? (
                <tr>
                  <td className="p-2 text-muted-foreground" colSpan={5}>
                    داده‌ای برای این بازه نیست.
                  </td>
                </tr>
              ) : (
                snapshot.margin.slice(0, 8).map((row) => (
                  <tr key={row.businessId} className="border-t border-border">
                    <td className="p-2">{row.businessName ?? row.businessId}</td>
                    <td className="p-2 tabular-nums">{tomanLabel(row.retailChargedRial)}</td>
                    <td className="p-2 tabular-nums">{tomanLabel(row.providerCostRial)}</td>
                    <td className={`p-2 tabular-nums ${row.marginRial < 0 ? "text-destructive" : ""}`}>
                      {tomanLabel(row.marginRial)}
                    </td>
                    <td className="p-2 tabular-nums">{formatPersianNumber(row.sends)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="تطبیق‌های اخیر">
        <div className="space-y-2 text-sm">
          {snapshot.reconciliation.length === 0 ? (
            <p className="text-muted-foreground">تطبیقی اجرا نشده است.</p>
          ) : (
            snapshot.reconciliation.slice(0, 8).map((row) => (
              <div key={row.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {row.business_id} • {row.state === "ok" ? "مطابق" : row.state === "drift" ? "اختلاف" : "ناقص"}
                </span>
                <span className="text-xs text-muted-foreground" dir="ltr">
                  Δ {row.delta_rial === null ? "—" : tomanLabel(Number(row.delta_rial))} •{" "}
                  {dateTime(row.created_at)}
                </span>
              </div>
            ))
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          موجودی داخلی در برابر دفتر ما: انتقال‌های تأییدشده منهای هزینهٔ ثبت‌شدهٔ ارسال‌ها. اختلاف با
          تلورانس مشخص گزارش می‌شود، نه با گرد کردن.
        </p>
      </Card>
    </div>
  );
}
