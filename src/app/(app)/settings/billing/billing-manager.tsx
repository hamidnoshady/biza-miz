"use client";

/**
 * Billing surface — `/settings/billing` (P1/P2 wallet & billing UI shortcomings fixed).
 * - Distinguishes load failure vs 0 balance; retry
 * - canManage vs billing.view permission gating
 * - Ledger entries, invoice list, payment pagination/filters/retry, usage with spend policy
 * - Gateway-neutral copy, manual pending confirmation
 * - Safe Rial conversion with server-side quote
 * - Jalali dates, RTL, Toman display
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircleIcon, CheckCircle2Icon, ClockIcon, RefreshCwIcon, WalletIcon, XCircleIcon } from "lucide-react";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { PLATFORM_BILLING_HREF, PLATFORM_SUBSCRIPTION_HREF } from "@/lib/app-routes";
import { formatJalali } from "@/lib/jalali";
import { Button } from "@/components/ui/button";
import { SectionCard, SectionCardSkeleton, cardClass } from "@/app/dashboard/page-chrome";
import { cn } from "@/lib/utils";
import { ErrorBox, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";


const STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  redirect: "هدایت به درگاه",
  verified: "پرداخت موفق",
  failed: "ناموفق",
  cancelled: "لغو شده",
};
const PURPOSE_LABELS: Record<string, string> = {
  top_up: "شارژ اعتبار",
  plan_purchase: "خرید اشتراک",
  addon_purchase: "خرید افزونه",
};

interface Wallet {
  balanceRial: number;
  totalToppedUpRial: number;
  totalSpentRial: number;
  aiDebtRial?: number;
  netBalanceRial?: number;
}
interface Pkg {
  id: string;
  name: string;
  priceRial: number;
  creditRial: number;
}
interface Payment {
  id: string;
  purpose: "top_up" | "plan_purchase" | "addon_purchase";
  amountRial: number;
  creditRial: number;
  status: string;
  gateway: string;
  gatewayRef: string | null;
  description: string;
  createdAt: string;
  fulfilmentStatus?: string;
}
interface LedgerEntry {
  id: string;
  kind: string;
  direction: "credit" | "debit";
  amountRial: number;
  balanceAfterRial: number;
  note: string | null;
  createdAt: string;
}
interface Invoice {
  id: string;
  invoiceNumber: string;
  status: string;
  totalRial: number;
  paidRial: number;
  dueAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  lines?: { description: string; amountRial: number }[];
}
interface UsageMeter {
  meterKey: string;
  name: string;
  used: number;
  included: number | null;
  estimatedRial: number;
  overage?: number;
}
interface SubscriptionBrief {
  planKey: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  autoRenew: boolean;
}

export function BillingManager() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const money = useMoney();

  // Data
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [pkgError, setPkgError] = useState<string | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [payTotal, setPayTotal] = useState<number | null>(null);
  const [payFilter, setPayFilter] = useState<string>("all");
  const [payOffset, setPayOffset] = useState(0);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState<number | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoiceTotal, setInvoiceTotal] = useState<number | null>(null);
  const [meters, setMeters] = useState<UsageMeter[]>([]);
  const [subscription, setSubscription] = useState<SubscriptionBrief | null>(null);
  const [spend, setSpend] = useState<{ budgetRial: number | null; spentRial: number; action: string | null } | null>(null);
  const [canManage, setCanManage] = useState(true);
  const [gatewayMode, setGatewayMode] = useState<string>("zarinpal");
  const [loading, setLoading] = useState(true);
  const [minTopUpRial, setMinTopUpRial] = useState(100_000);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [customAmountToman, setCustomAmountToman] = useState<string>("");
  const [quotePreview, setQuotePreview] = useState<{ totalRial: number; taxRial: number; creditRial?: number } | null>(null);
  const verifiedRef = useRef(false);

  const loadWallet = useCallback(async () => {
    const res = await api<{ wallet: Wallet; ledger: LedgerEntry[] }>("/api/billing/wallet");
    if (res.ok) {
      setWallet(res.data.wallet);
      setWalletError(null);
      if ((res.data as unknown as { canManage?: boolean }).canManage === false) setCanManage(false);
    } else {
      setWalletError(errorMessage((res.data as { error?: string })?.error) || "بارگذاری کیف پول ممکن نشد");
    }
  }, []);
  const loadAll = useCallback(async () => {
    setLoading(true);
    const [walletRes, pkgRes, usageRes, subRes, ledgerRes, invRes] = await Promise.all([
      api<{ wallet: Wallet }>("/api/billing/wallet"),
      api<{ packages: Pkg[] }>("/api/billing/packages"),
      api<{ usage: { meters: UsageMeter[] }; wallet: Wallet; subscription: SubscriptionBrief | null; spend: { budgetRial: number | null; spentRial: number; action: string | null } }>("/api/billing/usage"),
      api<{ subscription: SubscriptionBrief | null; canManage: boolean }>("/api/billing/subscription"),
      api<{ entries: LedgerEntry[]; total: number }>("/api/billing/ledger?limit=20"),
      api<{ invoices: Invoice[]; total: number }>("/api/billing/invoices?limit=20"),
    ]);
    if (walletRes.ok) {
      setWallet(walletRes.data.wallet);
      setWalletError(null);
    } else setWalletError(errorMessage((walletRes.data as { error?: string })?.error) || "خطا در دریافت موجودی");
    if (pkgRes.ok) setPackages(pkgRes.data.packages ?? []);
    else setPkgError(errorMessage((pkgRes.data as { error?: string })?.error) || "خطا در بسته‌ها");
    if (usageRes.ok) {
      setMeters(usageRes.data.usage?.meters ?? []);
      setSpend(usageRes.data.spend ?? null);
      if (usageRes.data.subscription) setSubscription(usageRes.data.subscription as never);
    }
    if (subRes.ok) {
      const sd = subRes.data as unknown as { subscription?: SubscriptionBrief | null; canManage?: boolean; planKey?: string };
      if (sd.subscription) {
        setSubscription(sd.subscription);
      } else if ((sd as unknown as SubscriptionBrief)?.planKey) {
        setSubscription(sd as unknown as SubscriptionBrief);
      }
      if (typeof (subRes.data as unknown as { canManage?: boolean }).canManage === "boolean") setCanManage((subRes.data as unknown as { canManage: boolean }).canManage);
    }
    if (ledgerRes.ok) {
      setLedger(ledgerRes.data.entries ?? []);
      setLedgerTotal(ledgerRes.data.total ?? null);
    }
    if (invRes.ok) {
      setInvoices(invRes.data.invoices ?? []);
      setInvoiceTotal(invRes.data.total ?? null);
    }
    // Fetch commercial settings for min top-up to enforce safe bound
    try {
      const q = await api<{ minimumTopUpRial?: number }>("/api/billing/quote", { method: "POST", body: JSON.stringify({ kind: "topup", amountRial: 1000 }) });
      // ignore, fallback to 10k tomans
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Paginated payment history: re-fetch when the selected page changes (#928 P2).
  // The endpoint now returns `total` so the Next button knows whether another
  // page exists; the old code was pinned to offset=0 and never advanced.
  const loadPayments = useCallback(async (offset: number) => {
    const res = await api<{ payments: Payment[]; total?: number; gateway: string }>(`/api/billing/payments?limit=50&offset=${offset}`);
    if (res.ok) {
      setPayments(res.data.payments ?? []);
      setGatewayMode(res.data.gateway ?? "manual");
      setPayTotal(res.data.total ?? res.data.payments?.length ?? 0);
    }
  }, []);

  useEffect(() => {
    void loadPayments(payOffset);
  }, [loadPayments, payOffset]);

  // Gateway return handling — distinguish wallet vs plan/addon verification
  useEffect(() => {
    const paymentId = searchParams.get("payment");
    const authority = searchParams.get("Authority") ?? searchParams.get("authority");
    const status = searchParams.get("Status") ?? searchParams.get("status");
    const payStatus = searchParams.get("paymentStatus");
    if (!paymentId) {
      // Also handle gateway callback via /api/billing/payments/callback redirect params
      if (payStatus === "verified") setInfo(payStatus ? "پرداخت با موفقیت تأیید شد." : "");
      return;
    }
    if (!authority || verifiedRef.current) {
      if (payStatus === "verified") setInfo("پرداخت تأیید شد.");
      return;
    }
    verifiedRef.current = true;
    (async () => {
      setBusy("verify");
      const res = await api<{ payment?: { status: string; creditRial: number; purpose: string; fulfilmentStatus?: string }; message?: string }>(
        "/api/billing/payments/verify",
        { method: "POST", body: JSON.stringify({ paymentId, authority, status: status ?? "NOK" }) },
      );
      setBusy(null);
      if (res.ok && res.data.payment?.status === "verified") {
        if (res.data.payment.purpose === "top_up" && res.data.payment.creditRial > 0) {
          setInfo(`پرداخت موفق — ${money.format(res.data.payment.creditRial)} به کیف پول شما افزوده شد.`);
        } else if (res.data.payment.purpose === "plan_purchase") {
          setInfo("پرداخت موفق — اشتراک شما فعال شد." + (res.data.payment.fulfilmentStatus === "succeeded" ? "" : " فعال‌سازی در حال انجام است."));
        } else if (res.data.payment.purpose === "addon_purchase") {
          setInfo("پرداخت موفق — افزونه فعال شد.");
        } else setInfo("پرداخت با موفقیت انجام شد.");
      } else {
        setError(res.data?.message ?? "پرداخت تأیید نشد. اگر مبلغی کسر شده، از پشتیبانی پیگیری کنید.");
      }
      router.replace(PLATFORM_BILLING_HREF);
      void loadAll();
      void loadPayments(0);
      setPayOffset(0);
    })();
  }, [searchParams, loadAll, loadPayments, money, router]);

  const filteredPayments = useMemo(() => {
    if (payFilter === "all") return payments;
    return payments.filter((p) => p.status === payFilter);
  }, [payments, payFilter]);

  async function startPaymentWithQuote(body: Record<string, unknown>, busyKey: string) {
    setError("");
    setInfo("");
    // First get authoritative quote to show breakdown
    const quoteRes = await api<{ totalRial: number; taxRial: number; totalToman?: number; creditRial?: number; error?: string }>(
      "/api/billing/quote",
      { method: "POST", body: JSON.stringify(body) },
    );
    if (!quoteRes.ok) {
      setError((quoteRes.data as { message?: string })?.message ?? errorMessage((quoteRes.data as { error?: string })?.error));
      return;
    }
    setQuotePreview({ totalRial: quoteRes.data.totalRial, taxRial: quoteRes.data.taxRial, creditRial: (quoteRes.data as { creditRial?: number }).creditRial });
    // Proceed to payment with expected amount for stale-quote protection
    setBusy(busyKey);
    try {
      const idempotencyKey = `${busyKey}:${quoteRes.data.totalRial}:${Date.now()}`;
      const res = await api<{ redirectUrl?: string | null; gateway?: string; error?: string; message?: string }>(
        "/api/billing/payments",
        { method: "POST", body: JSON.stringify({ ...body, expectedAmountRial: quoteRes.data.totalRial, quoteId: (quoteRes.data as { quoteId?: string }).quoteId, idempotencyKey }) },
      );
      if (!res.ok) {
        if ((res.data as { error?: string })?.error === "stale_quote") {
          setError("قیمت به‌روز شده است؛ لطفاً دوباره تلاش کنید.");
        } else setError((res.data as { message?: string })?.message ?? errorMessage((res.data as { error?: string })?.error));
        setBusy(null);
        return;
      }
      if (res.data.redirectUrl) {
        // Use system browser for Cloud/Hybrid as designed; Local shows offline message handled by outer gate
        window.location.assign(res.data.redirectUrl);
        return;
      }
      setInfo("درخواست شما ثبت شد و در انتظار تأیید مدیر سامانه است. پس از تأیید، نتیجه در همین صفحه نمایش داده می‌شود.");
      setPayOffset(0);
      void loadAll();
      void loadPayments(0);
      setBusy(null);
    } catch {
      setError("خطا در ثبت پرداخت.");
      setBusy(null);
    }
  }

  function topupPackage(pkg: Pkg) {
    if (!canManage) { setError("برای پرداخت به دسترسی مدیریت مالی نیاز دارید."); return; }
    void startPaymentWithQuote({ kind: "topup", packageId: pkg.id }, `pkg-${pkg.id}`);
  }
  function topupCustom() {
    if (!canManage) { setError("برای پرداخت به دسترسی مدیریت مالی نیاز دارید."); return; }
    const raw = toLatinDigits(customAmountToman || "0").replace(/[^\d]/g, "");
    const amountToman = Math.floor(Number(raw || "0"));
    if (!Number.isFinite(amountToman) || amountToman <= 0) { setError("مبلغ را به تومان وارد کنید."); return; }
    if (amountToman * 10 > 5_000_000_000) { setError("مبلغ بیش از سقف مجاز است."); return; }
    const minToman = Math.ceil(minTopUpRial / 10);
    if (amountToman < minToman) { setError(`حداقل مبلغ شارژ ${toPersianDigits(String(minToman))} تومان است.`); return; }
    void startPaymentWithQuote({ kind: "topup", amountRial: amountToman * 10 }, "custom");
  }
  async function retryPayment(p: Payment) {
    setError("");
    setBusy(`retry-${p.id}`);
    const res = await api<{ payment?: Payment }>(`/api/billing/payments/reconcile`, { method: "POST", body: JSON.stringify({ paymentId: p.id }) });
    setBusy(null);
    if (res.ok) {
      setInfo("بازبینی انجام شد و وضعیت پرداخت به‌روز شد.");
      void loadAll();
      void loadPayments(0);
      setPayOffset(0);
    } else setError(errorMessage((res.data as { error?: string })?.error));
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="در حال بارگذاری">
        <SectionCardSkeleton label="اعتبار فعلی" rows={2} />
        <SectionCardSkeleton label="شارژ اعتبار" rows={4} />
        <SectionCardSkeleton label="مصرف این دوره" rows={3} />
        <SectionCardSkeleton label="تاریخچهٔ پرداخت‌ها" rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-4" dir="rtl">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {info ? <InfoBox>{info}</InfoBox> : null}

      {/* Usage with spend policy */}
      {meters.length > 0 || spend ? (
        <SectionCard title="مصرف و هزینهٔ این دوره">
          {spend?.budgetRial != null ? (
            <div className="mb-3 rounded-lg border p-2 text-xs">
              <p>بودجهٔ ماهانه: {money.format(spend.budgetRial)} · مصرف: {money.format(spend.spentRial)} {spend.budgetRial ? `(${toPersianDigits(String(Math.round((spend.spentRial / spend.budgetRial) * 100)))}٪)` : ""}</p>
              {spend.action === "block_noncritical" && spend.spentRial >= (spend.budgetRial ?? Infinity) ? <p className="mt-1 text-amber-600 dark:text-amber-400">سقف بودجه پر شده — برخی سرویس‌ها ممکن است محدود شوند.</p> : null}
            </div>
          ) : null}
          <ul className="space-y-2 text-sm">
            {meters.map((meter) => (
              <li key={meter.meterKey} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">{meter.name} {meter.included != null && meter.used > meter.included ? <AlertCircleIcon className="size-4 text-amber-500 dark:text-amber-400" aria-label="تجاوز از سهمیه" /> : null}</span>
                <span className="tabular-nums">
                  {toPersianDigits(String(meter.used))}
                  {meter.included != null ? ` / ${toPersianDigits(String(meter.included))} (مازاد: ${toPersianDigits(String(Math.max(0, meter.used - meter.included)))})` : ""}
                  {meter.estimatedRial > 0 ? ` · ${money.format(meter.estimatedRial)}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">بازهٔ صورت‌حساب از اول ماه تا امروز (جلالی) — هزینهٔ تخمینی تا تسویه نهایی ممکن است تغییر کند.</p>
        </SectionCard>
      ) : null}

      {/* Balance with error distinction */}
      <SectionCard title="اعتبار فعلی">
        {walletError ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive flex items-center gap-2"><AlertCircleIcon className="size-4" /> بارگذاری اعتبار ناموفق: {walletError}</p>
            <Button variant="secondary" onClick={() => void loadWallet()}><RefreshCwIcon className="size-4" /> تلاش دوباره</Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"><WalletIcon className="size-6" /></span>
              <div>
                <p className="text-2xl font-extrabold tabular-nums" aria-live="polite">{money.format(wallet?.balanceRial ?? 0)}</p>
                <p className="text-xs text-muted-foreground">مجموع شارژ: {money.format(wallet?.totalToppedUpRial ?? 0)} · مجموع مصرف: {money.format(wallet?.totalSpentRial ?? 0)} {wallet?.aiDebtRial ? `· بدهی هوش: ${money.format(wallet.aiDebtRial)}` : ""}</p>
              </div>
            </div>
            {busy === "verify" && <span className="flex items-center gap-2 text-sm text-muted-foreground">در حال بررسی نتیجهٔ پرداخت…</span>}
          </div>
        )}
      </SectionCard>

      {/* Top-up packages — gateway-neutral copy */}
      <SectionCard title="شارژ اعتبار">
        <p className="mb-3 text-sm text-muted-foreground">
          {gatewayMode === "manual" ? "یکی از بسته‌ها را انتخاب کنید یا مبلغ دلخواه وارد کنید. پرداخت به‌صورت کارت‌به‌کارت ثبت می‌شود و مدیر سامانه آن را تأیید می‌کند." : "یکی از بسته‌ها را انتخاب کنید یا مبلغ دلخواه وارد کنید. پرداخت از طریق درگاه امن انجام می‌شود."}
          {!canManage ? <span className="block text-amber-600 dark:text-amber-400">برای پرداخت نیاز به مجوز «مدیریت مالی» دارید.</span> : null}
        </p>
        {pkgError ? <p className="text-sm text-destructive">{pkgError} <Button variant="secondary" size="sm" onClick={() => void loadAll()}>تلاش دوباره</Button></p> : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {packages.map((pkg) => {
            const bonus = pkg.creditRial - pkg.priceRial;
            const priceWithTaxNote = gatewayMode === "manual" ? "قابل پرداخت دستی" : "پرداخت آنلاین";
            return (
              <div key={pkg.id} className={cn("flex flex-col p-4", cardClass)}>
                <p className="font-bold">{pkg.name}</p>
                <p className="mt-2 text-xl font-extrabold tabular-nums">{money.format(pkg.creditRial)} <span className="text-sm font-normal">اعتبار</span></p>
                {bonus > 0 && <p className="mt-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">{money.format(bonus)} هدیه</p>}
                <p className="mt-1 text-xs text-muted-foreground">قابل پرداخت: {money.format(pkg.priceRial)} · {priceWithTaxNote}</p>
                <Button className="mt-3 w-full" disabled={!canManage || busy !== null} aria-label={`پرداخت ${pkg.name}`} onClick={() => topupPackage(pkg)}>
                  {busy === `pkg-${pkg.id}` ? "در حال پردازش…" : `پرداخت ${money.format(pkg.priceRial)}`}
                </Button>
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded-2xl border border-dashed border-border p-4">
          <p className="mb-2 text-sm font-semibold">شارژ با مبلغ دلخواه</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-56">
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="customToman">مبلغ (تومان)</label>
              <PersianNumberInput id="customToman" className={inputClass} inputMode="numeric" placeholder="مثلاً ۲۰۰٬۰۰۰" value={customAmountToman} onChange={(e) => setCustomAmountToman(e.target.value)} aria-describedby="customHint" />
              <p id="customHint" className="mt-1 text-xs text-muted-foreground">حداقل {toPersianDigits(String(Math.ceil(minTopUpRial / 10)))} تومان · مالیات در پیش‌نمایش اضافه می‌شود</p>
            </div>
            {quotePreview && busy !== "custom" ? <div className="text-xs">مبلغ نهایی با مالیات: {money.format(quotePreview.totalRial)}</div> : null}
            <Button variant="secondary" disabled={!canManage || busy !== null} onClick={topupCustom}>{busy === "custom" ? "در حال پردازش…" : "نمایش قیمت و پرداخت"}</Button>
          </div>
        </div>
      </SectionCard>

      {/* Ledger */}
      <SectionCard title="دفتر کیف پول">
        {ledger.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">هنوز تراکنشی ثبت نشده.</p> : (
          <>
            <ul className="divide-y divide-border">
              {ledger.map((e) => (
                <li key={e.id} className="flex justify-between gap-3 py-2 text-sm">
                  <div>
                    <p className="font-medium">{e.note ?? e.kind} {e.direction === "credit" ? " +" : " −"}</p>
                    <p className="text-xs text-muted-foreground">{formatJalali(e.createdAt, { withMonthName: true, withTime: true })}</p>
                  </div>
                  <span className={cn("font-semibold tabular-nums", e.direction === "credit" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>{e.direction === "credit" ? "+" : "−"}{money.format(e.amountRial)}</span>
                </li>
              ))}
            </ul>
            {ledgerTotal != null && ledgerTotal > ledger.length ? <p className="mt-2 text-xs text-muted-foreground">{toPersianDigits(String(ledger.length))} از {toPersianDigits(String(ledgerTotal))} تراکنش</p> : null}
          </>
        )}
      </SectionCard>

      {/* Invoices */}
      <SectionCard title="صورت‌حساب‌ها">
        {invoices.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">صورت‌حسابی یافت نشد.</p> : (
          <ul className="divide-y divide-border">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-medium">{inv.invoiceNumber} — {inv.status}</p>
                  <p className="text-xs text-muted-foreground">{formatJalali(inv.createdAt, { withMonthName: true })} {inv.periodStart && inv.periodEnd ? `· دوره: ${formatJalali(inv.periodStart)} تا ${formatJalali(inv.periodEnd)}` : ""}</p>
                  {inv.lines?.slice(0, 2).map((l, i) => <p key={i} className="text-xs text-muted-foreground">{l.description}: {money.format(l.amountRial)}</p>)}
                </div>
                <div className="text-end">
                  <p className="font-semibold">{money.format(inv.totalRial)}</p>
                  <p className="text-xs">پرداخت‌شده: {money.format(inv.paidRial)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {invoiceTotal != null ? <p className="mt-2 text-xs text-muted-foreground">{toPersianDigits(String(invoices.length))} از {toPersianDigits(String(invoiceTotal))} صورت‌حساب</p> : null}
      </SectionCard>

      <SectionCard title="اشتراک">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm leading-6 text-muted-foreground">طرح اشتراک این کسب‌وکار و ارتقای آن، در صفحهٔ اشتراک پلتفرم مدیریت می‌شود.</p>
          <Button variant="secondary" asChild><Link href={PLATFORM_SUBSCRIPTION_HREF}>مشاهدهٔ اشتراک</Link></Button>
        </div>
      </SectionCard>

      {/* Payment history with filters, pagination, status labels, retry */}
      <SectionCard title="تاریخچهٔ پرداخت‌ها">
        <div className="mb-3 flex flex-wrap gap-2">
          {["all", "pending", "redirect", "verified", "failed", "cancelled"].map((s) => (
            <Button key={s} size="sm" variant={payFilter === s ? "secondary" : "outline"} onClick={() => { setPayFilter(s); setPayOffset(0); }}>{s === "all" ? "همه" : STATUS_LABELS[s] ?? s}</Button>
          ))}
        </div>
        {filteredPayments.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">هنوز پرداختی با این وضعیت نیست.</p> : (
          <ul className="divide-y divide-border">
            {filteredPayments.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-medium flex items-center gap-2">{(p.description || PURPOSE_LABELS[p.purpose] || STATUS_LABELS[p.status] || p.status)} <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{PURPOSE_LABELS[p.purpose] ?? p.purpose}</span></p>
                  <p className="text-xs text-muted-foreground">{formatJalali(p.createdAt, { withMonthName: true, withTime: true })} {p.gatewayRef ? `· کد پیگیری: ${toPersianDigits(p.gatewayRef)}` : ""} · {STATUS_LABELS[p.status] ?? p.status}{p.fulfilmentStatus ? ` · اجرا: ${p.fulfilmentStatus}` : ""}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-semibold tabular-nums">{money.format(p.amountRial)}</span>
                  {p.status === "verified" ? <CheckCircle2Icon className="size-5 text-emerald-600 dark:text-emerald-400" /> : p.status === "failed" || p.status === "cancelled" ? <XCircleIcon className="size-5 text-destructive" /> : <ClockIcon className="size-5 text-muted-foreground" />}
                  {(p.status === "failed" || p.status === "cancelled" || p.status === "redirect") && canManage ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void retryPayment(p)}>{busy === `retry-${p.id}` ? "…" : "بازبینی/تلاش دوباره"}</Button> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex items-center justify-between">
          <Button variant="secondary" size="sm" disabled={payOffset === 0} onClick={() => setPayOffset((o) => Math.max(0, o - 50))}>قبلی</Button>
          <span className="text-xs text-muted-foreground">صفحه {toPersianDigits(String(Math.floor(payOffset / 50) + 1))} {payTotal != null ? `از ${toPersianDigits(String(Math.ceil(payTotal / 50)))}` : ""}</span>
          <Button variant="secondary" size="sm" disabled={payTotal != null && payOffset + 50 >= payTotal} onClick={() => setPayOffset((o) => o + 50)}>بعدی</Button>
        </div>
      </SectionCard>
    </div>
  );
}
