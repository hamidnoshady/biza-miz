"use client";

/**
 * One business's complete commercial page (migration 0176) — the consolidation
 * of the old «پلن و مصرف» and «صورت‌حساب و پرداخت» sections into one tabbed
 * surface:
 *
 *   ?tab=subscription — subscription state, plan assignment (through the ONE
 *                       `changeBusinessPlan` path), the renewal breakdown and
 *                       per-business limit overrides,
 *   ?tab=wallet       — balance, manual adjust, the immutable ledger, payments,
 *   ?tab=invoices     — the invoice ledger,
 *   ?tab=usage        — feature usage, entitlements, AI allowance/LiteLLM
 *                       spend, messaging credit and media storage.
 *
 * The retired `/plan` section redirects to `?tab=subscription`.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Loader2Icon, RefreshCwIcon, SparklesIcon, WalletIcon } from "lucide-react";
import { formatJalali } from "@/lib/jalali";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  BILLING_ALWAYS_INCLUDED,
  BILLING_TAB_INCLUDES,
  BILLING_TAB_READY_KEYS,
  type BillingIncludeKey,
} from "@/lib/platform-billing-includes";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { PlatformStatusBadge } from "@/components/platform/status-badge";
import { PlatformConfirmDialog } from "@/components/platform/dialogs";
import { parseSafeIntInput, tomanLabel } from "@/lib/platform-money";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, selectClass, useCan } from "../../../ui";

// ---------------------------------------------------------------------------
// Data shapes — the contract of GET /api/platform/billing/businesses/[id]
// ---------------------------------------------------------------------------

interface BusinessBillingData {
  business: { id: string; name: string; plan: string };
  subscription: {
    businessId: string;
    planKey: string;
    status: "trialing" | "active" | "past_due" | "cancelled" | "expired";
    startedAt: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    trialEnd: string | null;
    graceEnd: string | null;
    cancelAtPeriodEnd: boolean;
    autoRenew: boolean;
    cancelledAt: string | null;
    lastRenewalAt: string | null;
  } | null;
  recurring: {
    baseRial: number;
    addonsRial: number;
    discountRial: number;
    taxRial: number;
    totalRial: number;
    lines: { kind: string; description: string; quantity: number; unitAmountRial: number; amountRial: number; featureKey: string | null }[];
  } | null;
  wallet: {
    balanceRial: number;
    aiDebtRial?: number;
    netBalanceRial?: number;
    aiAllowanceRemainingRial?: number;
    usableAiCreditRial?: number;
    totalToppedUpRial?: number;
    totalSpentRial?: number;
    totalCreditedRial?: number;
    totalDebitedRial?: number;
  };
  ledger: {
    id: string;
    kind: string;
    direction: "credit" | "debit";
    amountRial: number;
    note: string | null;
    featureKey: string | null;
    createdAt: string;
  }[];
  entitlements: {
    featureKey: string;
    source: string;
    expiresAt: string | null;
    freeUntil: string | null;
    freeLimit: number | null;
  }[];
  payments: {
    id: string;
    purpose: string;
    amountRial: number;
    status: string;
    gatewayRef: string | null;
    description: string;
    createdAt: string;
  }[];
  invoices: {
    id: string;
    invoiceNumber: string;
    status: string;
    totalRial: number;
    paidRial: number;
    dueAt: string | null;
    createdAt: string;
  }[];
  litellm: {
    costingEnabled: boolean;
    usdRialRate: number | null;
    totalSpendUsd: number;
    totalSpendRial: number;
    keys: {
      locationId: string | null;
      keyAlias: string | null;
      effectiveModel: string;
      hasVirtualKey: boolean;
      spendUsd: number;
      spendRial: number;
      syncedAt: string | null;
      syncError: string | null;
    }[];
  };
  ai: {
    allowance: {
      monthlyCreditRial: number;
      configuredCreditRial?: number;
      effectiveCreditRial?: number;
      usedRial: number;
      remainingRial: number;
    };
    walletSpentRial: number;
    aiDebtRial?: number;
    usableAiCreditRial?: number;
  };
  messaging: { balanceRial: number };
  media: { usage: { totalBytes: number; assetCount: number; byKind: Record<string, { count: number; bytes: number }> } };
  overrides: {
    id: string;
    kind: string;
    target: string;
    valueInt: number | null;
    valueBool: boolean | null;
    reason: string;
    expiresAt: string | null;
    createdAt: string;
    createdBy: string | null;
    state: "active" | "expired" | "removed";
  }[];
  /** Expired and removed overrides — accountability, not effective access. */
  overrideHistory: {
    id: string;
    kind: string;
    target: string;
    valueInt: number | null;
    valueBool: boolean | null;
    reason: string;
    expiresAt: string | null;
    createdAt: string;
    createdBy: string | null;
    state: "active" | "expired" | "removed";
  }[];
  usage: { featureKey: string; usedCount: number; chargedCount: number; spentRial: number }[];
  /** Which sections rode along, and how much of each paged list there is. */
  meta?: {
    includes: BillingIncludeKey[];
    ledger: ListPageInfo;
    payments: ListPageInfo;
    invoices: ListPageInfo;
  };
}

interface ListPageInfo {
  total: number;
  limit: number;
  offset: number;
}

/** One page of a paged list — the unit every "load more" fetches. */
const PAGE_SIZE = 50;

/**
 * Concatenated pages, with repeated ids dropped.
 *
 * A row can move between pages when something is written while the operator is
 * paging (the lists are newest-first), so page two can legitimately repeat a row
 * page one already showed. Without this, React key collisions would show the
 * ledger twice.
 */
function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

/**
 * The shape every tab renders against, with shape-complete empties. Sections
 * that were not requested stay at their empty value but are never *shown*: the
 * tab gates on BILLING_TAB_READY_KEYS first.
 */
function emptyBilling(businessId: string): BusinessBillingData {
  return {
    business: { id: businessId, name: "", plan: "" },
    subscription: null,
    recurring: null,
    wallet: { balanceRial: 0, totalToppedUpRial: 0, totalSpentRial: 0 },
    ledger: [],
    entitlements: [],
    payments: [],
    invoices: [],
    litellm: {
      costingEnabled: false,
      usdRialRate: null,
      totalSpendUsd: 0,
      totalSpendRial: 0,
      keys: [],
    },
    ai: { allowance: { monthlyCreditRial: 0, usedRial: 0, remainingRial: 0 }, walletSpentRial: 0 },
    messaging: { balanceRial: 0 },
    media: { usage: { totalBytes: 0, assetCount: 0, byKind: {} } },
    overrides: [],
    overrideHistory: [],
    usage: [],
  };
}

const KIND_LABELS: Record<string, string> = {
  top_up: "شارژ",
  payment: "پرداخت",
  admin_grant: "شارژ دستی",
  refund: "بازگشت وجه",
  feature_charge: "هزینهٔ قابلیت",
  addon_purchase: "خرید افزونه",
  plan_fee: "هزینهٔ پلن",
  subscription: "اشتراک",
  admin_adjust: "تعدیل دستی",
  free_promo: "استفادهٔ رایگان",
};

const SUB_STATUS_LABELS: Record<string, string> = {
  trialing: "دورهٔ آزمایشی",
  active: "فعال",
  past_due: "عقب‌افتاده",
  cancelled: "لغو شده",
  expired: "منقضی",
};
const SUB_STATUS_TONES: Record<string, "success" | "info" | "warning" | "danger" | "muted"> = {
  trialing: "info",
  active: "success",
  past_due: "warning",
  cancelled: "muted",
  expired: "danger",
};

const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: "پیش‌نویس",
  open: "باز",
  paid: "تسویه شده",
  partially_paid: "تسویه جزئی",
  overdue: "معوق",
  void: "باطل",
};
const INVOICE_STATUS_TONES: Record<string, "success" | "info" | "warning" | "danger" | "muted"> = {
  draft: "muted",
  open: "info",
  paid: "success",
  partially_paid: "warning",
  overdue: "danger",
  void: "muted",
};

const OVERRIDE_TARGET_LABELS: Record<string, string> = {
  branch_limit: "سقف شعبه‌ها",
  member_limit: "سقف اعضا",
  monthly_order_limit: "سقف سفارش ماهانه",
};

const TABS = [
  { key: "subscription", label: "اشتراک و پلن" },
  { key: "wallet", label: "کیف پول و پرداخت‌ها" },
  { key: "invoices", label: "فاکتورها" },
  { key: "usage", label: "مصرف و اعتبار" },
] as const;

type Tab = (typeof TABS)[number]["key"];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "۰ بایت";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} گیگابایت`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} مگابایت`;
  if (bytes < 1024) return `${toPersianDigits(Math.round(bytes))} بایت`;
  return `${(bytes / 1024).toFixed(1)} کیلوبایت`;
}

/**
 * "N of M" plus a real load-more. The lists used to stop at 50 with nothing
 * saying so — an operator reading a 300-row ledger drawer had no way to tell
 * the difference between "that is the ledger" and "that is the newest 50".
 */
function LoadMoreButton({
  shown,
  total,
  onClick,
}: {
  shown: number;
  total: number;
  onClick: () => void;
}) {
  return (
    <div className="mt-3 flex justify-center">
      <Button variant="ghost" onClick={onClick}>
        نمایش {toPersianDigits(Math.min(PAGE_SIZE, total - shown))} ردیف بیشتر ({toPersianDigits(shown)} از {toPersianDigits(total)})
      </Button>
    </div>
  );
}

/**
 * Media usage is read from a separate service that can fail on its own; the
 * fallback is shape-complete now, but the UI stays null-safe so a partial or
 * older payload can never crash the recovery path it exists to serve.
 */
function mediaKindCount(
  usage: BusinessBillingData["media"]["usage"] | undefined,
  kind: string,
): number {
  return usage?.byKind?.[kind]?.count ?? 0;
}

export default function BusinessBillingPage() {
  const params = useParams<{ id: string }>();
  const businessId = decodeURIComponent(params.id);
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get("tab") ?? "subscription";
  const tab: Tab = TABS.some((t) => t.key === rawTab) ? (rawTab as Tab) : "subscription";
  const can = useCan();
  // Capabilities are read per action, not folded into one `canAdjust`. The API
  // enforces exactly these, and each may be granted independently in the future
  // — a wallet/override desk without price policy, or a payments reviewer
  // without either.
  //   subscription / plan / auto-renew / cancel  -> billing.manage
  //   wallet adjustment                          -> adjustments.manage
  //   business overrides                         -> adjustments.manage
  //   LiteLLM spend refresh (the POST action)    -> adjustments.manage
  const canManageSubscription = can("billing.manage");
  const canAdjustWallet = can("adjustments.manage");
  const canOverride = can("adjustments.manage");
  const canRefreshSpend = can("adjustments.manage");

  const [data, setData] = useState<Partial<BusinessBillingData>>({});
  const [activePlans, setActivePlans] = useState<{ key: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const setTab = (next: Tab) => router.replace(`?tab=${next}`, { scroll: false });

  /**
   * `appendSection` is how "load more" works: fetch the *next* page of one list
   * by offset and concatenate it, rather than re-requesting a longer list.
   *
   * The first version grew `limit` instead, which silently capped out: the route
   * clamps a page size to 200, so past 200 rows every click re-fetched the same
   * rows, the shown count never reached `total`, and rows 201+ were unreachable.
   */
  const load = useCallback(
    async (
      which: Tab,
      append?: { section: "ledger" | "payments" | "invoices"; offset: number },
    ) => {
      const sp = new URLSearchParams({
        include: [BILLING_ALWAYS_INCLUDED, ...BILLING_TAB_INCLUDES[which]].join(","),
        ledgerLimit: String(PAGE_SIZE),
        paymentsLimit: String(PAGE_SIZE),
        invoicesLimit: String(PAGE_SIZE),
      });
      if (append) {
        sp.set(`${append.section}Offset`, String(append.offset));
      }
      const { ok, data: res } = await api<Partial<BusinessBillingData> & { error?: string }>(
        `/api/platform/billing/businesses/${businessId}?${sp.toString()}`,
      );
      if (!ok) {
        setError(res.error === "business_not_found" ? "کسب‌وکار یافت نشد." : res.error ?? "بارگذاری انجام نشد.");
        return;
      }
      // Merge rather than replace: the other tabs' already-loaded sections stay
      // put, so switching tabs never flashes a half-empty page.
      setData((prev) => {
        const next = { ...prev, ...res };
        if (!append) return next;
        // Newest-first lists, so the next page goes on the end — with the ids
        // de-duplicated, because a row can move between pages when something is
        // written while the operator is paging.
        if (append.section === "ledger") {
          next.ledger = dedupeById([...(prev.ledger ?? []), ...(res.ledger ?? [])]);
        } else if (append.section === "payments") {
          next.payments = dedupeById([...(prev.payments ?? []), ...(res.payments ?? [])]);
        } else {
          next.invoices = dedupeById([...(prev.invoices ?? []), ...(res.invoices ?? [])]);
        }
        return next;
      });
    },
    [businessId],
  );

  const reload = useCallback(async () => {
    await load(tab);
  }, [load, tab]);

  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  /**
   * Fetch one more page of a list instead of hiding the rest.
   *
   * Resets the section to its first page afterwards on the next tab load, which
   * is what an operator expects from re-opening a tab — and means a wallet
   * adjustment refreshes exactly what is on screen rather than a stale count.
   */
  function loadMore(section: "ledger" | "payments" | "invoices") {
    const shown =
      section === "ledger"
        ? (data.ledger?.length ?? 0)
        : section === "payments"
          ? (data.payments?.length ?? 0)
          : (data.invoices?.length ?? 0);
    void load(tab, { section, offset: shown });
  }

  useEffect(() => {
    void api<{ plans: { key: string; name: string; status: string }[]; error?: string }>(
      "/api/platform/billing/plans",
    ).then(({ ok, data: res }) => {
      if (ok) setActivePlans(res.plans.filter((p) => p.status === "active"));
    });
  }, []);

  async function subscriptionAction(body: Record<string, unknown>, message: string) {
    setBusy("subscription");
    setError("");
    setInfo("");
    const { ok, data: res } = await api<{ error?: string }>("/api/platform/billing/subscriptions", {
      method: "POST",
      body: JSON.stringify({ businessId, ...body }),
    });
    setBusy(null);
    if (ok) {
      setInfo(message);
      await load(tab);
    } else {
      setError(res.error === "subscription_not_found" ? "اشتراکی ثبت نشده است." : `انجام نشد: ${res.error ?? ""}`);
    }
  }

  if (!data.business) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2Icon className="size-6 animate-spin" />
      </div>
    );
  }

  const view: BusinessBillingData = { ...emptyBilling(businessId), ...data };
  const ready = BILLING_TAB_READY_KEYS[tab].every((key) => key in data);

  return (
    <div className="space-y-4 sm:space-y-6">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {info && <InfoBox>{info}</InfoBox>}

      <nav aria-label="بخش‌های صورت‌حساب کسب‌وکار" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? "page" : undefined}
            className={
              tab === t.key
                ? "shrink-0 whitespace-nowrap rounded-lg bg-sky-500/15 px-3.5 py-2 text-sm font-medium text-sky-700 dark:text-sky-300"
                : "shrink-0 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </nav>

      {!ready ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2Icon className="size-6 animate-spin" />
        </div>
      ) : (
        <>
          {tab === "subscription" && (
            <SubscriptionTab
              data={view}
              activePlans={activePlans}
              canManageSubscription={canManageSubscription}
              canOverride={canOverride}
              busy={busy}
              onBusy={setBusy}
              onSubscriptionAction={subscriptionAction}
              onReload={reload}
              onError={setError}
              confirmCancel={confirmCancel}
              setConfirmCancel={setConfirmCancel}
            />
          )}
          {tab === "wallet" && (
            <WalletTab
              data={view}
              businessId={businessId}
              canAdjustWallet={canAdjustWallet}
              canRefreshSpend={canRefreshSpend}
              busy={busy}
              onLoadMore={loadMore}
              onBusy={setBusy}
              onReload={reload}
              onError={setError}
              onInfo={setInfo}
            />
          )}
          {tab === "invoices" && (
            <InvoicesTab invoices={view.invoices} pageInfo={view.meta?.invoices} onLoadMore={loadMore} />
          )}
          {tab === "usage" && <UsageTab data={view} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscription tab
// ---------------------------------------------------------------------------

function SubscriptionTab({
  data,
  activePlans,
  canManageSubscription,
  canOverride,
  busy,
  onBusy,
  onSubscriptionAction,
  onReload,
  onError,
  confirmCancel,
  setConfirmCancel,
}: {
  data: BusinessBillingData;
  activePlans: { key: string; name: string }[];
  canManageSubscription: boolean;
  canOverride: boolean;
  busy: string | null;
  onBusy: (key: string | null) => void;
  onSubscriptionAction: (body: Record<string, unknown>, message: string) => Promise<void>;
  onReload: () => Promise<void>;
  onError: (message: string) => void;
  confirmCancel: boolean;
  setConfirmCancel: (open: boolean) => void;
}) {
  const [planChoice, setPlanChoice] = useState(data.business.plan);
  const sub = data.subscription;

  // Override form state
  const [ovTarget, setOvTarget] = useState("branch_limit");
  const [ovUnlimited, setOvUnlimited] = useState(false);
  const [ovValue, setOvValue] = useState("");
  const [ovReason, setOvReason] = useState("");
  // ISO date, chosen through the Shamsi calendar — the server stores and
  // compares ISO, the operator only ever sees Jalali.
  const [ovExpiry, setOvExpiry] = useState("");

  async function saveOverride(ev: FormEvent) {
    ev.preventDefault();
    onError("");
    const body: Record<string, unknown> = {
      action: "set",
      kind: "limit",
      target: ovTarget,
      reason: ovReason.trim(),
      // End of the chosen day, so an override that expires "today" is still
      // effective today instead of lapsing at midnight UTC.
      expiresAt: ovExpiry ? new Date(`${ovExpiry}T23:59:59.999Z`).toISOString() : null,
    };
    if (ovUnlimited) body.unlimited = true;
    else {
      const value = Number(toLatinDigits(ovValue || "0"));
      if (!Number.isSafeInteger(value) || value < 0) {
        onError("مقدار استثنا باید عدد صحیح و نامنفی باشد.");
        return;
      }
      body.value = value;
    }
    onBusy("override");
    const { ok, data: res } = await api<{ error?: string }>(
      `/api/platform/billing/businesses/${data.business.id}/overrides`,
      { method: "POST", body: JSON.stringify(body) },
    );
    onBusy(null);
    if (ok) {
      setOvReason("");
      setOvValue("");
      setOvExpiry("");
      await onReload();
    } else {
      onError(res.error === "missing_fields" ? "دلیل استثنا (حداقل ۴ نویسه) و مقدار الزامی است." : res.error === "invalid_limit" ? "مقدار استثنا معتبر نیست." : `ثبت استثنا انجام نشد: ${res.error ?? ""}`);
    }
  }

  async function removeOverride(override: BusinessBillingData["overrides"][number]) {
    onBusy(`override-remove-${override.target}`);
    // kind + id, matching the uniqueness key: target alone could delete a
    // capability override that merely shares a name with the limit one.
    await api(`/api/platform/billing/businesses/${data.business.id}/overrides`, {
      method: "POST",
      body: JSON.stringify({ action: "remove", target: override.target, kind: override.kind, id: override.id }),
    });
    onBusy(null);
    await onReload();
  }

  return (
    <div className="space-y-4">
      <Card title="اشتراک">
        {sub ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <PlatformStatusBadge label={SUB_STATUS_LABELS[sub.status] ?? sub.status} tone={SUB_STATUS_TONES[sub.status] ?? "neutral"} dot />
              <span className="text-sm text-foreground">
                پلن فعلی: <strong>{sub.planKey}</strong>
              </span>
              {sub.cancelAtPeriodEnd && (
                <span className="text-xs text-amber-700 dark:text-amber-300">لغو در پایان دورهٔ جاری</span>
              )}
              {sub.graceEnd && (
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  مهلت بازپرداخت تا {formatJalali(sub.graceEnd, { withMonthName: true })}
                </span>
              )}
            </div>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">شروع اشتراک</dt>
                <dd className="tabular-nums">{formatJalali(sub.startedAt, { withMonthName: true })}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">دورهٔ جاری</dt>
                <dd className="tabular-nums">
                  {formatJalali(sub.currentPeriodStart)} تا {formatJalali(sub.currentPeriodEnd)}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">آخرین تمدید</dt>
                <dd className="tabular-nums">{sub.lastRenewalAt ? formatJalali(sub.lastRenewalAt, { withMonthName: true }) : "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">تمدید خودکار</dt>
                <dd>
                  {canManageSubscription ? (
                    <button
                      type="button"
                      className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-muted"
                      disabled={busy === "subscription"}
                      onClick={() =>
                        void onSubscriptionAction(
                          { action: "set_auto_renew", autoRenew: !sub.autoRenew },
                          sub.autoRenew ? "تمدید خودکار خاموش شد." : "تمدید خودکار روشن شد.",
                        )
                      }
                    >
                      {busy === "subscription" ? <Loader2Icon className="inline size-3 animate-spin" /> : sub.autoRenew ? "خاموش" : "روشن"}
                    </button>
                  ) : (
                    (sub.autoRenew ? "روشن" : "خاموش")
                  )}
                </dd>
              </div>
            </dl>
            {canManageSubscription && sub.status !== "cancelled" && sub.status !== "expired" && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="danger" onClick={() => setConfirmCancel(true)} disabled={busy === "subscription"}>
                  لغو اشتراک
                </Button>
                {(sub.cancelAtPeriodEnd || sub.status === "past_due") && (
                  <Button
                    onClick={() =>
                      void onSubscriptionAction({ action: "reactivate" }, "اشتراک دوباره فعال شد.")
                    }
                    disabled={busy === "subscription"}
                  >
                    فعال‌سازی دوباره
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            این کسب‌وکار اشتراک فعال ندارد؛ با انتساب پلن زیر، اشتراک ساخته می‌شود.
          </p>
        )}
      </Card>

      {canManageSubscription && (
        <Card title="انتساب / تغییر پلن">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (planChoice && planChoice !== data.business.plan) {
                void onSubscriptionAction({ action: "change_plan", planKey: planChoice }, `پلن به «${planChoice}» تغییر کرد.`);
              }
            }}
          >
            <Field label="پلن" hint="فقط پلن‌های فعال قابل انتساب‌اند؛ تخصیص از طریق سرویس واحد تغییر پلن انجام می‌شود.">
              <select className={selectClass + " w-64"} value={planChoice} onChange={(e) => setPlanChoice(e.target.value)}>
                {activePlans.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" disabled={busy === "subscription" || !planChoice || planChoice === data.business.plan}>
              {busy === "subscription" ? <Loader2Icon className="size-4 animate-spin" /> : null}
              ثبت تغییر پلن
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            ویرایش خودِ پلن‌ها (قیمت، سقف‌ها، قابلیت‌ها) در <Link href="/platform/billing?tab=plans" className="underline">مرکز صورت‌حساب</Link> انجام می‌شود.
          </p>
        </Card>
      )}

      {data.recurring && (
        <Card title="تفکیک هزینهٔ دورهٔ بعد">
          <table className="w-full text-sm">
            <thead className="text-right text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-1">شرح</th>
                <th className="py-2">نوع</th>
                <th className="py-2">تعداد</th>
                <th className="py-2">مبلغ واحد</th>
                <th className="py-2">مبلغ</th>
              </tr>
            </thead>
            <tbody>
              {data.recurring.lines.map((line, i) => (
                <tr key={`${line.kind}-${line.description}-${i}`} className="border-b border-border">
                  <td className="py-2 pr-1">{line.description}</td>
                  <td className="py-2">{line.kind}</td>
                  <td className="py-2 tabular-nums">{line.quantity}</td>
                  <td className="py-2 tabular-nums">{tomanLabel(line.unitAmountRial)}</td>
                  <td className="py-2 tabular-nums">{tomanLabel(line.amountRial)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4} className="py-2 pl-1 text-left font-medium">جمع دوره:</td>
                <td className="py-2 tabular-nums font-bold">{tomanLabel(data.recurring.totalRial)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">
            این ارقام را سرویس مرکزی محاسبه می‌کند (هزینهٔ پایهٔ پلن + افزونه‌های ماهانه)؛ رابط کاربری خودش جمع نمی‌زند.
          </p>
        </Card>
      )}

      <Card title="استثناهای این کسب‌وکار (Override)">
        <p className="mb-3 text-xs text-muted-foreground">
          استثنا فقط برای همین کسب‌وکار است، پلن عمومی را تغییر نمی‌دهد؛ ثبت دلیل الزامی است و همهٔ تغییرات در
          تاریخچه ثبت می‌شود. پس از انقضا، استثنا خودبه‌خور غیرفعال است.
        </p>
        {data.overrides.length > 0 ? (
          <ul className="mb-4 divide-y divide-border text-sm">
            {data.overrides.map((ov) => (
              <li key={ov.id} className="flex items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-foreground">
                    {OVERRIDE_TARGET_LABELS[ov.target] ?? ov.target}:{" "}
                    <strong>
                      {ov.valueInt == null ? "نامحدود" : toPersianDigits(ov.valueInt)}
                    </strong>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {ov.reason} • {ov.createdBy ?? "—"} • {formatJalali(ov.createdAt, { withMonthName: true })}
                    {ov.expiresAt ? ` • تا ${formatJalali(ov.expiresAt, { withMonthName: true })}` : " • بدون انقضا"}
                  </p>
                </div>
                {canOverride && (
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10"
                    disabled={busy === `override-remove-${ov.target}`}
                    onClick={() => void removeOverride(ov)}
                  >
                    حذف
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-sm text-muted-foreground">استثنای فعالی برای این کسب‌وکار ثبت نشده است.</p>
        )}
        {(data.overrideHistory ?? []).length > 0 ? (
          <details className="mb-4 rounded-xl border border-border bg-muted/30 p-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              تاریخچهٔ استثناهای منقضی/حذف‌شده ({toPersianDigits((data.overrideHistory ?? []).length)})
            </summary>
            <ul className="mt-2 divide-y divide-border text-sm">
              {(data.overrideHistory ?? []).map((ov) => (
                <li key={ov.id} className="flex items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="text-muted-foreground">
                      {OVERRIDE_TARGET_LABELS[ov.target] ?? ov.target}:{" "}
                      <strong>{ov.valueInt == null ? "نامحدود" : toPersianDigits(ov.valueInt)}</strong>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {ov.state === "expired" ? "منقضی" : "حذف‌شده"}
                      {ov.expiresAt ? ` • انقضا ${formatJalali(ov.expiresAt, { withMonthName: true })}` : ""}
                      {" "}• {ov.reason}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {canOverride && (
          <form onSubmit={saveOverride} className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
            <Field label="محدودیت">
              <select className={selectClass} value={ovTarget} onChange={(e) => setOvTarget(e.target.value)}>
                <option value="branch_limit">سقف شعبه‌ها</option>
                <option value="member_limit">سقف اعضا</option>
                <option value="monthly_order_limit">سقف سفارش ماهانه</option>
              </select>
            </Field>
            <Field label="مقدار">
              {ovUnlimited ? (
                <input className={inputClass} value="نامحدود" disabled />
              ) : (
                <PersianNumberInput className={inputClass} inputMode="numeric" value={ovValue} onChange={(e) => setOvValue(e.target.value)} placeholder="مثلاً ۵" />
              )}
            </Field>
            <label className="flex items-center gap-2 pb-4 text-sm text-foreground">
              <input type="checkbox" checked={ovUnlimited} onChange={(e) => setOvUnlimited(e.target.checked)} className="size-4" />
              نامحدود
            </label>
            <Field label="دلیل (الزامی)">
              <input className={inputClass} value={ovReason} onChange={(e) => setOvReason(e.target.value)} placeholder="مثلاً قرارداد سازمانی، جبران اختلال" />
            </Field>
            <Field label="انقضا (اختیاری — شمسی)">
              <JalaliDatePicker
                value={ovExpiry}
                onChange={setOvExpiry}
                className={inputClass}
                ariaLabel="تاریخ انقضای استثنا"
              />
            </Field>
            <div className="lg:col-span-5">
              <Button type="submit" disabled={busy === "override"}>
                {busy === "override" ? <Loader2Icon className="size-4 animate-spin" /> : null}
                ثبت استثنا
              </Button>
            </div>
          </form>
        )}
      </Card>

      <PlatformConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="لغو اشتراک"
        description={`اشتراک «${data.business.name}» در پایان دورهٔ جاری لغو شود؟ دسترسی‌ها تا پایان دوره باقی می‌مانند.`}
        confirmLabel="لغو اشتراک"
        variant="destructive"
        busy={busy === "subscription"}
        onConfirm={async () => {
          setConfirmCancel(false);
          await onSubscriptionAction({ action: "cancel", atPeriodEnd: true }, "اشتراک در پایان دوره لغو می‌شود.");
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wallet tab
// ---------------------------------------------------------------------------

function WalletTab({
  data,
  businessId,
  canAdjustWallet,
  canRefreshSpend,
  busy,
  onLoadMore,
  onBusy,
  onReload,
  onError,
  onInfo,
}: {
  data: BusinessBillingData;
  businessId: string;
  canAdjustWallet: boolean;
  canRefreshSpend: boolean;
  busy: string | null;
  onLoadMore: (section: "ledger" | "payments" | "invoices") => void;
  onBusy: (key: string | null) => void;
  onReload: () => Promise<void>;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
}) {
  const [amountToman, setAmountToman] = useState("");
  const [note, setNote] = useState("");
  const [syncing, setSyncing] = useState(false);

  async function adjust(ev: FormEvent) {
    ev.preventDefault();
    onError("");
    const amount = parseSafeIntInput(amountToman, { min: -Number.MAX_SAFE_INTEGER });
    if (amount === null || amount === 0) {
      onError("مبلغ معتبر (عدد صحیح غیرصفر؛ برای کسر منفی) وارد کنید.");
      return;
    }
    onBusy("adjust");
    const { ok, data: res } = await api<{ error?: string; debtPaidRial?: number }>(
      `/api/platform/billing/businesses/${businessId}`,
      { method: "POST", body: JSON.stringify({ amountRial: amount * 10, note: note.trim() || undefined }) },
    );
    onBusy(null);
    if (ok) {
      const debtMsg =
        res.debtPaidRial && res.debtPaidRial > 0
          ? ` (${tomanLabel(res.debtPaidRial)} بابت بدهی معوق هوش مصنوعی تسویه شد.)`
          : "";
      onInfo((amount > 0 ? "اعتبار افزوده شد." : "اعتبار کسر شد.") + debtMsg);
      setAmountToman("");
      setNote("");
      await onReload();
    } else {
      onError(res.error === "insufficient_credits" ? "موجودی برای کسر این مبلغ کافی نیست." : "عملیات انجام نشد.");
    }
  }

  async function syncLiteLlm() {
    setSyncing(true);
    onError("");
    const { ok, data: res } = await api<{ litellm?: BusinessBillingData["litellm"]; error?: string }>(
      `/api/platform/billing/businesses/${businessId}`,
      { method: "POST", body: JSON.stringify({ action: "sync_litellm_spend" }) },
    );
    setSyncing(false);
    if (ok && res.litellm) {
      setDataLiteLlm(res.litellm);
      onInfo("مصرف LiteLLM به‌روزرسانی شد.");
    } else {
      onError(res.error ?? "به‌روزرسانی مصرف LiteLLM انجام نشد.");
    }
  }

  // Keep the LiteLLM panel in local state so a sync doesn't refetch everything.
  const [liteLlmLocal, setLiteLlmLocal] = useState<BusinessBillingData["litellm"] | null>(null);
  const liteLlm = liteLlmLocal ?? data.litellm;
  function setDataLiteLlm(next: BusinessBillingData["litellm"]) {
    setLiteLlmLocal(next);
  }

  return (
    <div className="space-y-4">
      <Card title={`کیف پول — ${data.business.name}`}>
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-700 dark:text-amber-300">
            <WalletIcon className="size-6" />
          </span>
          <div>
            <p className="text-2xl font-extrabold tabular-nums text-foreground">{tomanLabel(data.wallet.balanceRial)}</p>
            <p className="text-xs text-muted-foreground">
              مجموع شارژ: {tomanLabel(data.wallet.totalCreditedRial ?? data.wallet.totalToppedUpRial ?? 0)} • مجموع مصرف: {tomanLabel(data.wallet.totalDebitedRial ?? data.wallet.totalSpentRial ?? 0)}
            </p>
            {((data.wallet.aiDebtRial ?? 0) > 0 || data.wallet.usableAiCreditRial != null) && (
              <p className="mt-1 text-xs text-muted-foreground">
                بدهی هوش مصنوعی:{" "}
                <strong className={(data.wallet.aiDebtRial ?? 0) > 0 ? "text-amber-700 dark:text-amber-300" : "text-foreground"}>
                  {tomanLabel(data.wallet.aiDebtRial ?? 0)}
                </strong>
                {" • "}ماندهٔ خالص کیف پول: <strong>{tomanLabel(data.wallet.netBalanceRial ?? data.wallet.balanceRial)}</strong>
                {data.wallet.usableAiCreditRial != null && (
                  <>
                    {" • "}اعتبار قابل استفادهٔ AI: <strong>{tomanLabel(data.wallet.usableAiCreditRial)}</strong>
                  </>
                )}
              </p>
            )}
          </div>
        </div>

        {canAdjustWallet && (
          <form onSubmit={adjust} className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-3 sm:items-end">
            <Field label="مبلغ (تومان — برای کسر منفی)">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                allowNegative
                value={amountToman}
                onChange={(e) => setAmountToman(e.target.value)}
                placeholder="مثلاً ۵۰۰٬۰۰۰ یا ۱۰۰٬۰۰۰-"
              />
            </Field>
            <Field label="یادداشت (اختیاری)">
              <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Button type="submit" disabled={busy === "adjust"}>
              {busy === "adjust" ? <Loader2Icon className="size-4 animate-spin" /> : null}
              اعمال شارژ/کسر
            </Button>
          </form>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          هر تغییر (حتی دستی) یک ردیف تغییرناپذیر در دفتر زیر ثبت می‌کند و با نام اپراتور در تاریخچه ثبت می‌شود.
        </p>

        <ul className="mt-4 divide-y divide-border text-sm">
          {data.ledger.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-foreground">{l.note || KIND_LABELS[l.kind] || l.kind}</p>
                <p className="text-xs text-muted-foreground">
                  {formatJalali(l.createdAt, { withMonthName: true, withTime: true })}
                  {l.featureKey ? ` • ${l.featureKey}` : ""}
                </p>
              </div>
              <span
                className={`shrink-0 tabular-nums font-semibold ${
                  l.direction === "credit" ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"
                }`}
              >
                {l.direction === "credit" ? "+" : "−"}
                {tomanLabel(l.amountRial)}
              </span>
            </li>
          ))}
          {data.ledger.length === 0 && <li className="py-4 text-center text-muted-foreground">تراکنشی ثبت نشده است.</li>}
        </ul>
        {data.meta && data.ledger.length < data.meta.ledger.total ? (
          <LoadMoreButton
            shown={data.ledger.length}
            total={data.meta.ledger.total}
            onClick={() => onLoadMore("ledger")}
          />
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          {toPersianDigits(data.ledger.length)} ردیف آخر از {toPersianDigits(data.meta?.ledger.total ?? data.ledger.length)} ردیف دفتر نمایش داده شده است.
        </p>
      </Card>

      <Card title="پرداخت‌ها">
        <ul className="divide-y divide-border text-sm">
          {data.payments.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-foreground">{p.description || p.purpose}</p>
                <p className="text-xs text-muted-foreground">
                  {formatJalali(p.createdAt, { withMonthName: true, withTime: true })}
                  {p.gatewayRef ? ` • پیگیری: ${p.gatewayRef}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="tabular-nums">{tomanLabel(p.amountRial)}</span>
                <PlatformStatusBadge
                  label={
                    p.status === "verified" ? "موفق" : p.status === "failed" ? "ناموفق" : p.status === "cancelled" ? "لغو" : p.status === "redirect" ? "در انتظار درگاه" : "در انتظار"
                  }
                  tone={p.status === "verified" ? "success" : p.status === "failed" || p.status === "cancelled" ? "danger" : "warning"}
                />
              </div>
            </li>
          ))}
          {data.payments.length === 0 && <li className="py-4 text-center text-muted-foreground">پرداختی نیست.</li>}
        </ul>
        {data.meta && data.payments.length < data.meta.payments.total ? (
          <LoadMoreButton
            shown={data.payments.length}
            total={data.meta.payments.total}
            onClick={() => onLoadMore("payments")}
          />
        ) : null}
      </Card>

      <Card title="هزینهٔ واقعی هوش مصنوعی (LiteLLM)">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-700 dark:text-violet-300">
              <SparklesIcon className="size-5" />
            </span>
            <div>
              <p className="text-lg font-extrabold tabular-nums text-foreground">
                {liteLlm.usdRialRate ? tomanLabel(liteLlm.totalSpendRial) : "—"}
                <span className="mr-2 text-xs font-normal text-muted-foreground" dir="ltr">
                  {toPersianDigits(liteLlm.totalSpendUsd.toFixed(4))} $
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                هزینهٔ گزارش‌شدهٔ LiteLLM برای این کسب‌وکار
                {liteLlm.costingEnabled ? " • تسویه فعال است" : " • تسویه غیرفعال است"}
              </p>
            </div>
          </div>
          {/* The POST action needs `adjustments.manage`; a read-only admin who
              holds only `billing.view` still sees the stored figures below but
              is not offered a button guaranteed to return 403. */}
          {canRefreshSpend ? (
            <Button type="button" onClick={() => void syncLiteLlm()} disabled={syncing}>
              {syncing ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
              به‌روزرسانی مصرف
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">آخرین ارقام ذخیره‌شده — به‌روزرسانی نیازمند دسترسی تعدیل است.</span>
          )}
        </div>

        {liteLlm.keys.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            هنوز کلید مجازی LiteLLM برای این کسب‌وکار صادر نشده است.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-right text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-1">کلید / شعبه</th>
                  <th className="py-2">مدل</th>
                  <th className="py-2">هزینه ($)</th>
                  <th className="py-2">هزینه (تومان)</th>
                  <th className="py-2">به‌روزرسانی</th>
                </tr>
              </thead>
              <tbody>
                {liteLlm.keys.map((k, idx) => (
                  <tr key={`${k.keyAlias ?? "biz"}-${k.locationId ?? "all"}-${idx}`} className="border-b border-border">
                    <td className="py-2 pr-1">
                      <span dir="ltr" className="font-medium text-foreground">
                        {k.keyAlias ?? "—"}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {k.locationId ? `شعبه: ${k.locationId.slice(0, 8)}` : "کل کسب‌وکار"}
                      </span>
                    </td>
                    <td className="py-2" dir="ltr">{k.effectiveModel}</td>
                    <td className="py-2 tabular-nums" dir="ltr">{toPersianDigits(k.spendUsd.toFixed(4))}</td>
                    <td className="py-2 tabular-nums">{liteLlm.usdRialRate ? tomanLabel(k.spendRial) : "—"}</td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {k.syncError ? (
                        <span className="text-red-700 dark:text-red-300">{k.syncError}</span>
                      ) : k.syncedAt ? (
                        formatJalali(k.syncedAt, { withMonthName: true, withTime: true })
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoices tab
// ---------------------------------------------------------------------------

function InvoicesTab({
  invoices,
  pageInfo,
  onLoadMore,
}: {
  invoices: BusinessBillingData["invoices"];
  pageInfo?: ListPageInfo;
  onLoadMore: (section: "ledger" | "payments" | "invoices") => void;
}) {
  return (
    <Card title="فاکتورها">
      {invoices.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">فاکتوری صادر نشده است.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-right text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-1">شماره</th>
                <th className="py-2">وضعیت</th>
                <th className="py-2">مبلغ کل</th>
                <th className="py-2">پرداخت‌شده</th>
                <th className="py-2">سرسید</th>
                <th className="py-2">تاریخ صدور</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-border">
                  <td className="py-2 pr-1 font-mono text-xs" dir="ltr">{inv.invoiceNumber}</td>
                  <td className="py-2">
                    <PlatformStatusBadge label={INVOICE_STATUS_LABELS[inv.status] ?? inv.status} tone={INVOICE_STATUS_TONES[inv.status] ?? "neutral"} />
                  </td>
                  <td className="py-2 tabular-nums">{tomanLabel(inv.totalRial)}</td>
                  <td className="py-2 tabular-nums">{tomanLabel(inv.paidRial)}</td>
                  <td className="py-2 tabular-nums">{inv.dueAt ? formatJalali(inv.dueAt) : "—"}</td>
                  <td className="py-2 tabular-nums">{formatJalali(inv.createdAt, { withTime: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pageInfo && invoices.length < pageInfo.total ? (
        <LoadMoreButton
          shown={invoices.length}
          total={pageInfo.total}
          onClick={() => onLoadMore("invoices")}
        />
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">
        ردیف‌های هر فاکتور در لحظهٔ صدور ثبت می‌شوند و با تغییر پلن یا تعرفه دوباره قیمت نمی‌خورند؛ فهرست کامل
        پلتفرم در <Link href="/platform/billing?tab=invoices" className="underline">مرکز صورت‌حساب</Link> است.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Usage tab
// ---------------------------------------------------------------------------

function UsageTab({ data }: { data: BusinessBillingData }) {
  const allowance = data.ai.allowance;

  // Operational snapshot against the plan's ceilings — the figures the old
  // «پلن و مصرف» section showed (orders, members, locations, menu, ledger).
  const [operational, setOperational] = useState<{
    orders: number;
    openOrders: number;
    members: number;
    locations: number;
    menuItems: number;
    journalEntries: number;
    lastActivity: string | null;
  } | null>(null);
  useEffect(() => {
    void api<{ usage: NonNullable<typeof operational> } & { error?: string }>(
      `/api/platform/businesses/${data.business.id}/usage`,
    ).then(({ ok, data: res }) => {
      if (ok) setOperational(res.usage);
    });
  }, [data.business.id]);
  const allowancePct = allowance.monthlyCreditRial > 0 ? Math.min(100, Math.round((allowance.usedRial / allowance.monthlyCreditRial) * 100)) : null;

  return (
    <div className="space-y-4">
      <Card title="مصرف و فعالیت (مقایسه با سقف پلن)">
        {operational ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              { label: "سفارش‌ها", value: toPersianDigits(operational.orders) },
              { label: "سفارش‌های باز", value: toPersianDigits(operational.openOrders) },
              { label: "اعضای فعال", value: toPersianDigits(operational.members) },
              { label: "شعبه‌ها", value: toPersianDigits(operational.locations) },
              { label: "اقلام منو", value: toPersianDigits(operational.menuItems) },
              { label: "اسناد دفتر کل", value: toPersianDigits(operational.journalEntries) },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="mt-1 text-lg font-bold tabular-nums">{s.value}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">در حال بارگذاری آمار فعالیت…</p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          آخرین فعالیت:{" "}
          {operational?.lastActivity ? formatJalali(operational.lastActivity, { withTime: true }) : "—"}
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="اعتبار ماهانهٔ هوش مصنوعی">
          <p className="text-2xl font-extrabold tabular-nums text-foreground">{tomanLabel(allowance.remainingRial)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            سهمیهٔ مؤثر این ماه: {tomanLabel(allowance.effectiveCreditRial ?? allowance.monthlyCreditRial)}
            {allowance.configuredCreditRial != null &&
              allowance.configuredCreditRial !== (allowance.effectiveCreditRial ?? allowance.monthlyCreditRial) && (
                <> (پلن تنظیم‌شده: {tomanLabel(allowance.configuredCreditRial)})</>
              )}
            {" • "}مصرف‌شده: {tomanLabel(allowance.usedRial)}
          </p>
          {allowancePct != null && (
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full ${allowancePct >= 90 ? "bg-red-500" : allowancePct >= 70 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${allowancePct}%` }}
              />
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            مصرف ماه از این اعتبار کسر می‌شود؛ مازاد آن به هزینهٔ کیف پول می‌رود (مجموع تا امروز: {tomanLabel(data.ai.walletSpentRial)}).
            {(data.ai.aiDebtRial ?? 0) > 0 && (
              <> • بدهی معوق AI: {tomanLabel(data.ai.aiDebtRial ?? 0)}</>
            )}
          </p>
        </Card>

        <Card title="اعتبار پیام‌رسانی">
          <p className="text-2xl font-extrabold tabular-nums text-foreground">{tomanLabel(data.messaging.balanceRial)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            اعتبار اختصاصی پیامک/ایمیل. تعرفه و بسته‌ها در{" "}
            <Link href="/platform/billing?tab=usage" className="underline">مرکز صورت‌حساب</Link> تعریف می‌شوند.
          </p>
        </Card>

        <Card title="نگهداری رسانه">
          <p className="text-2xl font-extrabold tabular-nums text-foreground">
            {formatBytes(data.media?.usage?.totalBytes ?? 0)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {toPersianDigits(data.media?.usage?.assetCount ?? 0)} فایل
            {mediaKindCount(data.media?.usage, "image") > 0 &&
              ` • تصویر: ${toPersianDigits(mediaKindCount(data.media?.usage, "image"))}`}
            {mediaKindCount(data.media?.usage, "video") > 0 &&
              ` • ویدیو: ${toPersianDigits(mediaKindCount(data.media?.usage, "video"))}`}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            هزینهٔ روزانهٔ نگهداری بر پایهٔ تعرفهٔ رسانه از کیف پول کسر می‌شود.
          </p>
        </Card>
      </div>

      <Card title="مصرف قابلیت‌های پولی">
        {data.usage.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">هنوز مصرفی ثبت نشده است.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-right text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-1">قابلیت</th>
                <th className="py-2">تعداد استفاده</th>
                <th className="py-2">استفادهٔ پولی</th>
                <th className="py-2">هزینه</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.map((u) => (
                <tr key={u.featureKey} className="border-b border-border">
                  <td className="py-2 pr-1 text-foreground">{u.featureKey}</td>
                  <td className="py-2 tabular-nums">{toPersianDigits(u.usedCount)}</td>
                  <td className="py-2 tabular-nums">{toPersianDigits(u.chargedCount)}</td>
                  <td className="py-2 tabular-nums">{tomanLabel(u.spentRial)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="قابلیت‌های فعال (اشتراک/خرید/هدیه)">
        {data.entitlements.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">قابلیت فعال مستقیمی ثبت نشده است.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {data.entitlements.map((e) => (
              <li key={e.featureKey} className="flex items-center justify-between gap-2 py-2">
                <span className="text-foreground">{e.featureKey}</span>
                <span className="text-xs text-muted-foreground">
                  {e.source}
                  {e.freeUntil ? ` • رایگان تا ${formatJalali(e.freeUntil, { withMonthName: true })}` : ""}
                  {e.freeLimit != null ? ` • ${toPersianDigits(e.freeLimit)} استفادهٔ رایگان` : ""}
                  {e.expiresAt ? ` • انقضا ${formatJalali(e.expiresAt, { withMonthName: true })}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
