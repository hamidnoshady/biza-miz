"use client";

/**
 * Issue #903 §3 and §8 — the managed-storage margin report, on the console page
 * that owns the service's storage and supplier cost.
 *
 * The report itself has existed since the billing jobs landed
 * (`computeBackupMargin`, read by `backupMarginReport`); until now it was a
 * function with no way in, so "what does backup storage earn against what it
 * costs us" was only answerable from a shell. Three choices shape this card:
 *
 *  1. **The assumption is an input, never a constant.** The provider cost per
 *     GB-month is not stored anywhere: the operator states it, and an empty box
 *     means "not stated" — which the card says out loud, because a margin of
 *     100 % computed against a zero cost is not a profit, it is a missing number.
 *  2. **Nothing is billed from here.** This is a read over settled usage events;
 *     no wallet, price or invoice is touched. Pricing itself lives in the
 *     Billing Control Center.
 *  3. **Unpriced lines are labelled.** A business whose meter never got a price
 *     shows «بدون قیمت» instead of counting as pure margin — the same rule the
 *     report carries internally.
 *
 * Shamsi dates: the pickers report ISO while the operator only ever sees a
 * Jalali calendar, exactly like the audit log's filters.
 */
import { useMemo, useState } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { formatPersianNumber } from "@/lib/digits";
import { tomanLabel } from "@/lib/platform-money";
import { usePlatformQuery } from "../../_lib/use-platform-data";
import { Button, Card, EmptyState, ErrorBox, Field, InfoBox, inputClass, useCan, SkeletonRows } from "../../ui";

interface MarginLine {
  businessId: string;
  businessName: string | null;
  byteDays: number;
  revenueRial: number;
  costRial: number;
  marginRial: number;
  marginPercent: number | null;
  notPriced: boolean;
  /** Byte-days in the line whose events were never rated, so revenue omits them. */
  unpricedByteDays: number;
}

interface MarginReport {
  from: string;
  to: string;
  lines: MarginLine[];
  totals: {
    byteDays: number;
    revenueRial: number;
    costRial: number;
    marginRial: number;
    marginPercent: number | null;
  };
  assumptions: { providerCostRialPerGbMonth: number; priced: boolean };
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_window: "بازهٔ تاریخ معتبر نیست؛ تاریخ شروع باید پیش از پایان باشد.",
  window_too_long: "بازه بیش از یک سال است؛ بازهٔ کوتاه‌تری انتخاب کنید.",
  invalid_provider_cost: "هزینهٔ تأمین‌کننده باید عدد صحیح نامنفی ریال باشد.",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO day (YYYY-MM-DD) — what the picker reports and the route accepts. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function percentLabel(value: number | null): string {
  return value === null ? "—" : `${formatPersianNumber(value)}٪`;
}

export function MarginPanel() {
  const canRead = useCan()("tenant_backup.policy");
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(() => isoDay(new Date(today.getTime() - 30 * DAY_MS)));
  const [to, setTo] = useState(() => isoDay(today));
  const [cost, setCost] = useState("");
  // The window that is actually being queried, so typing in a picker does not
  // fire a request per keystroke: the button applies the draft.
  const [applied, setApplied] = useState(() => ({
    from: isoDay(new Date(today.getTime() - 30 * DAY_MS)),
    to: isoDay(today),
    providerCostRialPerGbMonth: "",
  }));

  const url = canRead
    ? `/api/platform/backup/service/margin?from=${applied.from}&to=${applied.to}` +
      (applied.providerCostRialPerGbMonth === ""
        ? ""
        : `&providerCostRialPerGbMonth=${applied.providerCostRialPerGbMonth}`)
    : null;
  const { data, loading, refreshing, errorText } = usePlatformQuery<{ report: MarginReport }>(
    url,
    [],
    { enabled: canRead, errorMessages: ERROR_MESSAGES },
  );

  if (!canRead) return null;

  const report = data?.report ?? null;
  // Biggest margin first: the operator is looking for the rows that matter, and
  // the report's own order is by business id, which means nothing to a human.
  const lines = report ? [...report.lines].sort((a, b) => b.marginRial - a.marginRial) : [];
  const windowInvalid = from !== "" && to !== "" && from >= to;

  return (
    <Card>
      <div className="flex items-center gap-2">
        <RefreshCwIcon className="h-4 w-4" />
        <h2 className="text-sm font-semibold">گزارش حاشیهٔ سود ذخیره‌سازی</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        درآمد ثبت‌شده در کنتور نگهداری نسخه‌ها، در برابر هزینهٔ فرض‌شدهٔ تأمین‌کننده. این گزارش فقط
        می‌خواند؛ هیچ کیف پول یا فاکتوری را تغییر نمی‌دهد.
      </p>

      {errorText ? <ErrorBox>{errorText}</ErrorBox> : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="از تاریخ">
          <JalaliDatePicker
            value={from}
            onChange={setFrom}
            ariaLabel="از تاریخ"
            className={inputClass}
            popoverClass="border-border bg-popover text-foreground"
          />
        </Field>
        <Field label="تا تاریخ (این روز هم شامل است)">
          <JalaliDatePicker
            value={to}
            onChange={setTo}
            ariaLabel="تا تاریخ"
            className={inputClass}
            popoverClass="border-border bg-popover text-foreground"
          />
        </Field>
        <Field label="هزینهٔ تأمین‌کننده (ریال بر گیگابایت-ماه)" hint="خالی = اعلام‌نشده (صفر)">
          <PersianNumberInput
            className={inputClass}
            inputMode="numeric"
            value={cost}
            onChange={(event) => setCost(event.target.value)}
          />
        </Field>
        <div className="flex items-end">
          <Button
            onClick={() => setApplied({ from, to, providerCostRialPerGbMonth: cost })}
            disabled={refreshing || windowInvalid}
          >
            {refreshing ? <Loader2Icon className="h-4 w-4 animate-spin" /> : null}
            محاسبه
          </Button>
        </div>
      </div>
      {windowInvalid ? (
        <p className="text-xs text-destructive">تاریخ شروع باید پیش از تاریخ پایان باشد.</p>
      ) : null}

      {loading ? <SkeletonRows rows={3} /> : null}

      {!loading && report ? (
        <div className="mt-4 space-y-3">
          <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">بایت-روز نگهداری‌شده</div>
              <div className="font-semibold tabular-nums">{formatPersianNumber(report.totals.byteDays)}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">درآمد ثبت‌شده</div>
              <div className="font-semibold">{tomanLabel(report.totals.revenueRial)}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">هزینهٔ تأمین‌کننده</div>
              <div className="font-semibold">{tomanLabel(report.totals.costRial)}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">حاشیه</div>
              <div className="font-semibold">
                {tomanLabel(report.totals.marginRial)}{" "}
                <span className="text-xs text-muted-foreground">({percentLabel(report.totals.marginPercent)})</span>
              </div>
            </div>
          </div>

          {/* The two honesty notes: without them the numbers above would read as
              profit when the cost was never stated, or when a meter has no price. */}
          {report.assumptions.providerCostRialPerGbMonth === 0 ? (
            <InfoBox>
              هزینهٔ تأمین‌کننده اعلام نشده است؛ ستون هزینه صفر و «حاشیه» در واقع همان درآمد است. برای
              دیدن حاشیهٔ واقعی، هزینهٔ ریال بر گیگابایت-ماه را وارد کنید.
            </InfoBox>
          ) : null}
          {!report.assumptions.priced ? (
            <InfoBox>
              برخی خط‌ها قیمت مصوب ندارند و با برچسب «بدون قیمت» نشان داده می‌شوند؛ درآمد آن‌ها صفر
              حساب شده، نه سود کامل.
            </InfoBox>
          ) : null}

          {lines.length === 0 ? (
            <EmptyState
              title="در این بازه مصرف اندازه‌گیری‌شده‌ای ثبت نشده است"
              hint="اگر کسب‌وکارها نسخهٔ ابری نگه می‌دارند، ابتدا نمونه‌گیری ساعتی و سپس تسویهٔ شبانه باید اجرا شده باشد."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 font-medium">کسب‌وکار</th>
                    <th className="py-2 font-medium">بایت-روز</th>
                    <th className="py-2 font-medium">درآمد</th>
                    <th className="py-2 font-medium">هزینه</th>
                    <th className="py-2 font-medium">حاشیه</th>
                    <th className="py-2 font-medium">درصد</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.businessId} className="border-b last:border-0">
                      <td className="py-2">
                        {line.businessName ?? (
                          <span className="text-muted-foreground" dir="ltr">
                            {line.businessId.slice(0, 8)}…
                          </span>
                        )}
                        {line.notPriced ? (
                          <span className="mr-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                            بدون قیمت
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 tabular-nums">{formatPersianNumber(line.byteDays)}</td>
                      <td className="py-2">
                        {tomanLabel(line.revenueRial)}
                        {/* A partly rated line is neither priced nor flagged: say
                            exactly how much of it the revenue does not cover. */}
                        {line.unpricedByteDays > 0 ? (
                          <span className="block text-xs text-muted-foreground">
                            {formatPersianNumber(line.unpricedByteDays)} بایت-روز بدون قیمت
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2">{tomanLabel(line.costRial)}</td>
                      <td className="py-2">{tomanLabel(line.marginRial)}</td>
                      <td className="py-2 tabular-nums">{percentLabel(line.marginPercent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}
