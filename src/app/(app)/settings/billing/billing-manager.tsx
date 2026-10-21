"use client";

/**
 * The platform's billing surface: wallet balance, credit top-up through the
 * payment gateway (Zarinpal) and the business's payment history.
 *
 * Money is platform-owned, so this lives at `/settings/billing` — inside the
 * platform settings area — rather than inside any app. Accounting, Growth and
 * the website builder all link *here* for credit, and their links say so; none
 * of them keeps a billing screen of its own. The plan catalogue moved next door
 * to `/settings/subscription`, because "top up my credit" and "change my plan"
 * are two different errands that were sharing one long page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2Icon, WalletIcon, XCircleIcon } from "lucide-react";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { PLATFORM_BILLING_HREF, PLATFORM_SUBSCRIPTION_HREF } from "@/lib/app-routes";
import { formatJalali } from "@/lib/jalali";
import { Button } from "@/components/ui/button";
import { SectionCard, SectionCardSkeleton, cardClass } from "@/app/dashboard/page-chrome";
import { cn } from "@/lib/utils";
import { ErrorBox, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";

interface UsageMeter {
  meterKey: string;
  name: string;
  used: number;
  included: number | null;
  estimatedRial: number;
}

interface Wallet {
  balanceRial: number;
  totalToppedUpRial: number;
  totalSpentRial: number;
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
}

const STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  redirect: "هدایت به درگاه",
  verified: "پرداخت موفق",
  failed: "ناموفق",
  cancelled: "لغو شده",
};

export function BillingManager() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [meters, setMeters] = useState<UsageMeter[]>([]);
  const [loading, setLoading] = useState(true);
  const money = useMoney();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [customAmountToman, setCustomAmountToman] = useState<string>("");
  const verifiedRef = useRef(false);

  const load = useCallback(async () => {
    const [walletRes, pkgRes, payRes, usageRes] = await Promise.all([
      api<{ wallet: Wallet }>("/api/billing/wallet"),
      api<{ packages: Pkg[] }>("/api/billing/packages"),
      api<{ payments: Payment[] }>("/api/billing/payments"),
      api<{ usage: { meters: UsageMeter[] } }>("/api/billing/usage"),
    ]);
    if (walletRes.ok) setWallet(walletRes.data.wallet);
    if (pkgRes.ok) setPackages(pkgRes.data.packages ?? []);
    if (payRes.ok) setPayments(payRes.data.payments ?? []);
    if (usageRes.ok) setMeters(usageRes.data.usage?.meters ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Gateway return: ?payment=…&Authority=…&Status=… (Zarinpal)
  useEffect(() => {
    const paymentId = searchParams.get("payment");
    const authority = searchParams.get("Authority");
    const status = searchParams.get("Status");
    if (!paymentId || !authority || verifiedRef.current) return;
    verifiedRef.current = true;
    (async () => {
      setBusy("verify");
      const { ok, data } = await api<{ payment?: { status: string; creditRial: number }; message?: string }>(
        "/api/billing/payments/verify",
        {
          method: "POST",
          body: JSON.stringify({ paymentId, authority, status: status ?? "NOK" }),
        },
      );
      setBusy(null);
      if (ok && data.payment?.status === "verified") {
        setInfo("پرداخت با موفقیت انجام شد و اعتبار شما افزوده شد.");
      } else {
        setError(data.message ?? "پرداخت تأیید نشد. اگر مبلغ کسر شده، حداکثر پس از ۲۴ ساعت بازمی‌گردد.");
      }
      router.replace(PLATFORM_BILLING_HREF);
      void load();
    })();
  }, [searchParams, load, router]);

  async function startPayment(body: Record<string, unknown>, busyKey: string) {
    setError("");
    setInfo("");
    setBusy(busyKey);
    try {
      const { ok, data } = await api<{ redirectUrl?: string | null; gateway?: string; error?: string; message?: string }>(
        "/api/billing/payments",
        { method: "POST", body: JSON.stringify(body) },
      );
      if (!ok) {
        setError(data.message ?? errorMessage(data.error));
        setBusy(null);
        return;
      }
      if (data.redirectUrl) {
        // Full navigation to the gateway; it returns to our callback.
        window.location.assign(data.redirectUrl);
        return;
      }
      // Manual gateway: no redirect — inform the owner.
      setInfo("درخواست پرداخت ثبت شد و پس از تأیید مدیر سامانه، اعتبار شما افزوده می‌شود.");
      void load();
      setBusy(null);
    } catch {
      setError("خطا در ثبت پرداخت. دوباره تلاش کنید.");
      setBusy(null);
    }
  }

  function topupPackage(pkg: Pkg) {
    void startPayment({ kind: "topup", packageId: pkg.id }, `pkg-${pkg.id}`);
  }

  function topupCustom() {
    const amountToman = Math.floor(Number(toLatinDigits(customAmountToman || "0")));
    if (!Number.isFinite(amountToman) || amountToman < 10_000) {
      setError("حداقل مبلغ شارژ ۱۰٬۰۰۰ تومان است.");
      return;
    }
    void startPayment({ kind: "topup", amountRial: amountToman * 10 }, "custom");
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="در حال بارگذاری">
        <SectionCardSkeleton label="اعتبار فعلی" rows={2} />
        <SectionCardSkeleton label="شارژ اعتبار" rows={4} />
        <SectionCardSkeleton label="تاریخچهٔ پرداخت‌ها" rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBox>{error}</ErrorBox>}
      {info && <InfoBox>{info}</InfoBox>}

      {meters.length > 0 && (
        <SectionCard title="مصرف این دوره">
          <ul className="space-y-2 text-sm">
            {meters.map((meter) => (
              <li key={meter.meterKey} className="flex items-center justify-between gap-3">
                <span>{meter.name}</span>
                <span className="tabular-nums">
                  {toPersianDigits(String(meter.used))}
                  {meter.included != null ? ` / ${toPersianDigits(String(meter.included))}` : ""}
                  {meter.estimatedRial > 0 ? ` · ${money.format(meter.estimatedRial)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* Balance */}
      <SectionCard title="اعتبار فعلی">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <WalletIcon className="size-6" />
            </span>
            <div>
              <p className="text-2xl font-extrabold tabular-nums">
                {money.format(wallet?.balanceRial ?? 0)}
              </p>
              <p className="text-xs text-muted-foreground">
                مجموع شارژ: {money.format(wallet?.totalToppedUpRial ?? 0)} · مجموع مصرف:{" "}
                {money.format(wallet?.totalSpentRial ?? 0)}
              </p>
            </div>
          </div>
          {busy === "verify" && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              در حال بررسی نتیجهٔ پرداخت…
            </span>
          )}
        </div>
      </SectionCard>

      {/* Top-up packages */}
      <SectionCard title="شارژ اعتبار">
        <p className="mb-3 text-sm text-muted-foreground">
          یکی از بسته‌ها را انتخاب کنید یا مبلغ دلخواه وارد کنید. پرداخت از طریق درگاه امن زرین‌پال انجام می‌شود.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {packages.map((pkg) => {
            const bonus = pkg.creditRial - pkg.priceRial;
            return (
              <div
                key={pkg.id}
                className={cn("flex flex-col p-4", cardClass)}
              >
                <p className="font-bold">{pkg.name}</p>
                <p className="mt-2 text-xl font-extrabold tabular-nums">
                  {money.format(pkg.creditRial)}{" "}
                  <span className="text-sm font-normal">اعتبار</span>
                </p>
                {bonus > 0 && (
                  <p className="mt-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    {money.format(bonus)} هدیه
                  </p>
                )}
                <Button
                  className="mt-3 w-full"
                  disabled={busy !== null}
                  onClick={() => topupPackage(pkg)}
                >
                  {busy === `pkg-${pkg.id}`
                    ? "در حال انتقال به درگاه…"
                    : `پرداخت ${money.format(pkg.priceRial)}`}
                </Button>
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded-2xl border border-dashed border-border p-4">
          <p className="mb-2 text-sm font-semibold">شارژ با مبلغ دلخواه</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-56">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">مبلغ (تومان)</label>
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                placeholder="مثلاً ۲۰۰٬۰۰۰"
                value={customAmountToman}
                onChange={(e) => setCustomAmountToman(e.target.value)}
              />
            </div>
            <Button variant="secondary" disabled={busy !== null} onClick={topupCustom}>
              {busy === "custom" ? "در حال انتقال…" : "پرداخت و شارژ"}
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* The plans themselves are one page over — see the note at the top. */}
      <SectionCard title="اشتراک">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm leading-6 text-muted-foreground">
            طرح اشتراک این کسب‌وکار و ارتقای آن، در صفحهٔ اشتراک پلتفرم مدیریت می‌شود.
          </p>
          <Button variant="secondary" asChild>
            <Link href={PLATFORM_SUBSCRIPTION_HREF}>مشاهدهٔ اشتراک</Link>
          </Button>
        </div>
      </SectionCard>

      {/* Payment history */}
      <SectionCard title="تاریخچهٔ پرداخت‌ها">
        {payments.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">هنوز پرداختی ثبت نشده است.</p>
        ) : (
          <ul className="divide-y divide-border">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.description || STATUS_LABELS[p.status]}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatJalali(p.createdAt, { withMonthName: true, withTime: true })}
                    {p.gatewayRef ? ` · کد پیگیری: ${toPersianDigits(p.gatewayRef)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="font-semibold tabular-nums">{money.format(p.amountRial)}</span>
                  {p.status === "verified" ? (
                    <CheckCircle2Icon className="size-5 text-emerald-600 dark:text-emerald-400" />
                  ) : p.status === "failed" || p.status === "cancelled" ? (
                    <XCircleIcon className="size-5 text-destructive" />
                  ) : (
                    <span className="size-2.5 rounded-full bg-muted-foreground/50" aria-label="در انتظار" />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
