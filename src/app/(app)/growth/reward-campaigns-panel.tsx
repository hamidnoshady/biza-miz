"use client";

/**
 * Growth → Campaigns → «کمپین بازگشت وجه» (issue #901).
 *
 * The promotion form beside this panel discounts a cart. This panel creates a
 * *reward* campaign: a settled sale earns the customer cashback, which becomes
 * spendable after its return hold and is paid out from its own liability. The
 * rules are `campaign-builder.ts` and the money is `campaign-reward-service.ts`;
 * this screen only composes them and shows what the ledger says.
 *
 * It is deliberately the simple mode the issue asks for: one screen, the six
 * decisions that matter (هدف، شرایط، پاداش، بودجه، مهلت، شعبه) and a review
 * sentence. The advanced cause/condition/action editor is a later wave and is
 * not pretended here.
 *
 * Two things the screen must never imply:
 *
 *  - **Approved is not live.** A campaign can be approved and still pay
 *    nothing until it is activated; the status label says which.
 *  - **"used" is not "paid".** Budget consumed is paid out *or still owed*;
 *    the outstanding liability is shown separately, because they answer
 *    different questions.
 */

import { useCallback, useEffect, useState } from "react";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";

interface RewardCampaign {
  id: string;
  name: string;
  status: "draft" | "pending_approval" | "approved" | "live" | "paused" | "completed" | "archived";
  schedule: { startsAt: string | null; endsAt: string | null };
  lifecycle: { submittedAt: string | null; approvedAt: string | null; activatedAt: string | null; pausedAt: string | null };
  version: {
    number: number;
    locked: boolean;
    definition: {
      trigger: { type: string; minNetPaidRial: number; locationIds: string[] | null };
      reward:
        | { type: "cashback"; mode: "percent"; percentBps: number; basis: string; maxPerOrderRial: number | null; holdDays: number }
        | { type: "cashback"; mode: "fixed"; fixedRial: number; basis: string; maxPerOrderRial: number | null; holdDays: number };
      limits: { totalBudgetRial: number; perCustomerCapRial: number | null };
    };
  };
}

interface RewardReportRow {
  campaignId: string;
  name: string;
  status: string;
  budgetRial: number;
  usedRial: number;
  remainingBudgetRial: number;
  earnedRial: number;
  availableRial: number;
  pendingRial: number;
  redeemedRial: number;
  expiredRial: number;
  reversedRial: number;
  unrecoveredRial: number;
  customers: number;
  orders: number;
  budgetExhausted: boolean;
}

interface LiabilitySummary {
  earnedRial: number;
  redeemedRial: number;
  reversedRial: number;
  expiredRial: number;
  outstandingRial: number;
}

const STATUS_LABEL: Record<RewardCampaign["status"], string> = {
  draft: "پیش‌نویس",
  pending_approval: "در انتظار تأیید",
  approved: "تأییدشده — فعال نشده",
  live: "در حال اجرا",
  paused: "متوقف",
  completed: "پایان‌یافته",
  archived: "بایگانی",
};

const STATUS_TONE: Record<RewardCampaign["status"], "active" | "positive" | "neutral" | "danger"> = {
  draft: "neutral",
  pending_approval: "active",
  approved: "active",
  live: "positive",
  paused: "danger",
  completed: "neutral",
  archived: "neutral",
};

const BASIS_LABEL: Record<string, string> = {
  net_paid: "مبلغ خالص پرداخت‌شده",
  net_paid_excl_tax: "مبلغ خالص پرداخت‌شده بدون مالیات",
};

export function RewardCampaignsPanel({
  canManage,
  canApprove,
}: {
  canManage: boolean;
  canApprove: boolean;
}) {
  const money = useMoney();
  const [campaigns, setCampaigns] = useState<RewardCampaign[]>([]);
  const [report, setReport] = useState<RewardReportRow[]>([]);
  const [liability, setLiability] = useState<LiabilitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [builder, rewards] = await Promise.all([
      api<{ campaigns: RewardCampaign[] }>("/api/growth/campaign-builder"),
      api<{ campaigns: RewardReportRow[]; liability: LiabilitySummary }>("/api/growth/campaign-rewards"),
    ]);
    if (!builder.ok) {
      setError(errorMessage((builder.data as { error?: string }).error));
      setLoading(false);
      return;
    }
    if (!rewards.ok) {
      setError(errorMessage((rewards.data as { error?: string }).error));
      setLoading(false);
      return;
    }
    setCampaigns(builder.data.campaigns);
    setReport(rewards.data.campaigns);
    setLiability(rewards.data.liability);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: string) => {
    setBusy(`${id}:${action}`);
    setError(null);
    const response = await api<{ campaign?: RewardCampaign; error?: string }>(
      `/api/growth/campaign-builder/${id}/lifecycle`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      },
    );
    setBusy(null);
    if (!response.ok) {
      setError(errorMessage(response.data.error));
      return;
    }
    await load();
  };

  const runNow = async (id: string) => {
    setBusy(`${id}:run`);
    setError(null);
    const response = await api<{ result?: { granted: number; grantedRial: number }; error?: string }>(
      `/api/growth/campaign-builder/${id}/run`,
      { method: "POST" },
    );
    setBusy(null);
    if (!response.ok) {
      setError(errorMessage(response.data.error));
      return;
    }
    await load();
  };

  const reportById = new Map(report.map((row) => [row.campaignId, row]));

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {liability ? (
        <KpiRow>
          <KpiCard
            label="بدهی بازگشت وجه (مانده)"
            value={money.format(liability.outstandingRial)}
            hint="مبلغی که به مشتریان بدهکاریم و هنوز خرج یا منقضی نشده است."
          />
          <KpiCard label="پاداش صادرشده" value={money.format(liability.earnedRial)} hint="جمع بازگشت وجه تعهدشده." />
          <KpiCard label="پرداخت‌شده به مشتری" value={money.format(liability.redeemedRial)} hint="از صندوق یا بانک." />
          <KpiCard
            label="برگشتی و منقضی"
            value={money.format(liability.reversedRial + liability.expiredRial)}
            hint="مرجوعی‌ها و پاداش‌هایی که مهلتشان تمام شد."
          />
        </KpiRow>
      ) : null}

      {canManage ? <CreateRewardCampaign onCreated={load} /> : null}

      <SectionCard
        title="کمپین‌های بازگشت وجه"
        description="هر فروش تسویه‌شده در بازهٔ اجرای کمپین، یک پاداش برای مشتری ثبت می‌کند. پاداش تا پایان مهلت مرجوعی قابل خرج نیست."
      >
        {loading ? (
          <SectionCardSkeleton rows={3} />
        ) : campaigns.length === 0 ? (
          <EmptyState title="هنوز کمپین بازگشت وجهی نساخته‌اید">
            با فرم بالا اولین کمپین را بسازید؛ ساخت کمپین هیچ پولی جابه‌جا نمی‌کند تا وقتی تأیید و فعال شود.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/70">
            {campaigns.map((campaign) => {
              const row = reportById.get(campaign.id);
              const def = campaign.version.definition;
              const rewardText =
                def.reward.mode === "percent"
                  ? `${toPersianDigits(def.reward.percentBps / 100)}٪ از ${BASIS_LABEL[def.reward.basis] ?? "مبلغ پرداخت‌شده"}`
                  : `${money.format(def.reward.fixedRial)} ثابت`;
              return (
                <li key={campaign.id} className="space-y-3 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-foreground">{campaign.name}</p>
                        <StatusBadge tone={STATUS_TONE[campaign.status]}>{STATUS_LABEL[campaign.status]}</StatusBadge>
                        {campaign.version.locked ? (
                          <StatusBadge tone="neutral">نسخهٔ {toPersianDigits(campaign.version.number)} قفل‌شده</StatusBadge>
                        ) : null}
                        {row?.budgetExhausted ? <StatusBadge tone="danger">بودجه تمام شده</StatusBadge> : null}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {rewardText} · مهلت مرجوعی {toPersianDigits(def.reward.holdDays)} روز · بودجه {money.format(def.limits.totalBudgetRial)}
                        {def.limits.perCustomerCapRial !== null
                          ? ` · سقف هر مشتری ${money.format(def.limits.perCustomerCapRial)}`
                          : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {campaign.lifecycle.activatedAt
                          ? `فعال از ${formatJalali(campaign.lifecycle.activatedAt)}`
                          : "هنوز فعال نشده است"}
                        {campaign.schedule.endsAt ? ` · پایان ${formatJalali(campaign.schedule.endsAt)}` : ""}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {campaign.status === "draft" && canManage ? (
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act(campaign.id, "submit")}>
                          ارسال برای تأیید
                        </Button>
                      ) : null}
                      {campaign.status === "pending_approval" && canApprove ? (
                        <Button size="sm" disabled={busy !== null} onClick={() => act(campaign.id, "approve")}>
                          تأیید
                        </Button>
                      ) : null}
                      {campaign.status === "approved" && canApprove ? (
                        <Button size="sm" disabled={busy !== null} onClick={() => act(campaign.id, "activate")}>
                          فعال‌سازی
                        </Button>
                      ) : null}
                      {campaign.status === "live" && canManage ? (
                        <>
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act(campaign.id, "pause")}>
                            توقف
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => runNow(campaign.id)}>
                            اجرای پاداش
                          </Button>
                        </>
                      ) : null}
                      {campaign.status === "paused" && canManage ? (
                        <>
                          <Button size="sm" disabled={busy !== null} onClick={() => act(campaign.id, "resume")}>
                            ادامه
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act(campaign.id, "complete")}>
                            پایان کمپین
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {row ? (
                    <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
                      <div>
                        <dt className="text-muted-foreground">بودجهٔ مصرف‌شده</dt>
                        <dd className="font-medium tabular-nums">{money.format(row.usedRial)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">بودجهٔ باقی‌مانده</dt>
                        <dd className="font-medium tabular-nums">{money.format(row.remainingBudgetRial)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">قابل خرج</dt>
                        <dd className="font-medium tabular-nums">{money.format(row.availableRial)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">در مهلت مرجوعی</dt>
                        <dd className="font-medium tabular-nums">{money.format(row.pendingRial)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">مشتری / فروش</dt>
                        <dd className="font-medium tabular-nums">
                          {formatPersianNumber(row.customers)} / {formatPersianNumber(row.orders)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">ماندهٔ بدهی</dt>
                        <dd className="font-medium tabular-nums">
                          {money.format(Math.max(0, row.earnedRial - row.redeemedRial - row.reversedRial - row.expiredRial))}
                        </dd>
                      </div>
                    </dl>
                  ) : null}

                  {row && row.unrecoveredRial > 0 ? (
                    <InfoBox>
                      {money.format(row.unrecoveredRial)} از پاداش مرجوعی قابل بازیافت نبود، چون مشتری آن را خرج کرده بود. این
                      مبلغ در گزارش به‌عنوان کسری ثبت شده است.
                    </InfoBox>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * The guided form: هدف (بازگشت وجه)، شرایط (حداقل فروش و شعبه)، پاداش، بودجه و
 * مهلت. Everything it sends is validated again by `parseCampaignDefinition`, so
 * a value this form lets through can never become an invalid stored campaign.
 */
function CreateRewardCampaign({ onCreated }: { onCreated: () => Promise<void> }) {
  const money = useMoney();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"percent" | "fixed">("percent");
  const [percent, setPercent] = useState("5");
  const [fixed, setFixed] = useState("");
  const [basis, setBasis] = useState<"net_paid" | "net_paid_excl_tax">("net_paid");
  const [minNetPaid, setMinNetPaid] = useState("");
  const [maxPerOrder, setMaxPerOrder] = useState("");
  const [holdDays, setHoldDays] = useState("7");
  const [budget, setBudget] = useState("");
  const [customerCap, setCustomerCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("نام کمپین را بنویسید.");
      return;
    }
    const reward =
      mode === "percent"
        ? {
            type: "cashback",
            mode: "percent",
            // The field is a whole percent; the engine stores basis points.
            percentBps: Math.round(Number(percent) * 100),
            basis,
            maxPerOrderRial: maxPerOrder ? money.fromInput(Number(maxPerOrder)) : null,
            holdDays: Number(holdDays || "0"),
          }
        : {
            type: "cashback",
            mode: "fixed",
            fixedRial: money.fromInput(Number(fixed || "0")),
            basis,
            maxPerOrderRial: maxPerOrder ? money.fromInput(Number(maxPerOrder)) : null,
            holdDays: Number(holdDays || "0"),
          };

    const definition = {
      trigger: {
        type: "pos_sale_settled",
        minNetPaidRial: minNetPaid ? money.fromInput(Number(minNetPaid)) : 0,
        locationIds: null,
      },
      reward,
      limits: {
        totalBudgetRial: money.fromInput(Number(budget || "0")),
        perCustomerCapRial: customerCap ? money.fromInput(Number(customerCap)) : null,
      },
    };

    setBusy(true);
    const response = await api<{ campaign?: RewardCampaign; error?: string; problems?: { message: string }[] }>(
      "/api/growth/campaign-builder",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, definition }),
      },
    );
    setBusy(false);
    if (!response.ok) {
      setError(response.data.problems?.[0]?.message ?? errorMessage(response.data.error));
      return;
    }
    setName("");
    setBudget("");
    setCustomerCap("");
    setMinNetPaid("");
    setMaxPerOrder("");
    setOpen(false);
    await onCreated();
  };

  if (!open) {
    return (
      <SectionCard
        title="کمپین بازگشت وجه تازه"
        description="پاداشی که با هر فروش تسویه‌شده برای مشتری ثبت می‌شود. پس از ساخت، کمپین باید تأیید و فعال شود؛ تا آن زمان هیچ پاداشی صادر نمی‌شود."
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            ساخت کمپین
          </Button>
        }
      />
    );
  }

  return (
    <SectionCard
      title="کمپین بازگشت وجه تازه"
      description="۱) هدف ۲) شرایط فروش ۳) پاداش ۴) بودجه و مهلت — سپس تأیید و فعال‌سازی."
      actions={
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          بستن
        </Button>
      }
    >
      <div className="space-y-1">
        {error ? <ErrorBox>{error}</ErrorBox> : null}

        <Field label="نام کمپین">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="مثلاً بازگشت وجه مشتریان تازه"
          />
        </Field>

        <Field label="نوع پاداش" hint="درصدی از مبلغ فروش، یا مبلغ ثابت به ازای هر فروش.">
          <select className={inputClass} value={mode} onChange={(event) => setMode(event.target.value as "percent" | "fixed")}>
            <option value="percent">درصدی</option>
            <option value="fixed">مبلغ ثابت</option>
          </select>
        </Field>

        {mode === "percent" ? (
          <Field label="درصد پاداش" hint="بین ۰٫۰۱ تا ۱۰۰ درصد از مبنای انتخاب‌شده.">
            <PersianNumberInput className={inputClass} allowDecimal value={percent} onChange={(event) => setPercent(event.target.value)} />
          </Field>
        ) : (
          <Field label={`مبلغ ثابت پاداش (${money.unitLabel})`}>
            <PersianNumberInput className={inputClass} value={fixed} onChange={(event) => setFixed(event.target.value)} />
          </Field>
        )}

        <Field label="مبنای محاسبه" hint="مبلغ خالص پرداخت‌شده هرگز شامل فروش نسیه یا مرجوعی پرداخت‌نشده نیست.">
          <select className={inputClass} value={basis} onChange={(event) => setBasis(event.target.value as typeof basis)}>
            <option value="net_paid">مبلغ خالص پرداخت‌شده</option>
            <option value="net_paid_excl_tax">مبلغ خالص پرداخت‌شده بدون مالیات</option>
          </select>
        </Field>

        <Field label={`حداقل مبلغ فروش (${money.unitLabel})`} hint="خالی یعنی هر فروش پرداخت‌شده واجد شرط است.">
          <PersianNumberInput className={inputClass} value={minNetPaid} onChange={(event) => setMinNetPaid(event.target.value)} />
        </Field>

        <Field label={`سقف پاداش هر سفارش (${money.unitLabel})`} hint="برای پاداش درصدی، سقف را مشخص کنید تا یک فروش بزرگ بودجه را نبلعد.">
          <PersianNumberInput className={inputClass} value={maxPerOrder} onChange={(event) => setMaxPerOrder(event.target.value)} />
        </Field>

        <Field label="مهلت مرجوعی (روز)" hint="پاداش تا پایان این مهلت قابل خرج نیست، تا مرجوعی‌ها اول تسویه شوند.">
          <PersianNumberInput className={inputClass} value={holdDays} onChange={(event) => setHoldDays(event.target.value)} />
        </Field>

        <Field label={`بودجهٔ کل کمپین (${money.unitLabel})`} hint="سخت‌گیرانه است: پاداشی که در بودجه جا نشود صادر نمی‌شود.">
          <PersianNumberInput className={inputClass} value={budget} onChange={(event) => setBudget(event.target.value)} />
        </Field>

        <Field label={`سقف پاداش هر مشتری (${money.unitLabel})`} hint="اختیاری؛ کل پاداشی که یک مشتری در این کمپین می‌گیرد.">
          <PersianNumberInput className={inputClass} value={customerCap} onChange={(event) => setCustomerCap(event.target.value)} />
        </Field>

        <div className="flex flex-wrap gap-2 pt-2">
          <Button disabled={busy} onClick={submit}>
            ذخیرهٔ پیش‌نویس
          </Button>
          <p className="self-center text-xs text-muted-foreground">
            ذخیره هیچ پاداشی صادر نمی‌کند؛ صدور پس از تأیید و فعال‌سازی آغاز می‌شود.
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
