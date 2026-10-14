"use client";

/**
 * The Growth app's commission section (Phase 36b) — the old
 * /dashboard/commission page as a section. Each sale line accrues to the
 * employee whose rule is most specific (item beats brand beats category beats
 * everything), a margin-basis rule uses the same cost the COGS posting used so
 * commission can never disagree with the ledger, and the moment a line
 * accrues, «پورسانت فروش» (۵۲۱۰) is debited and «حقوق پرداختنی» (۲۳۰۰)
 * credited through the same domain-event engine every other auto-posting uses.
 *
 * The owner manages the rules here (a rule is retired, never deleted, so the
 * accrual rows that pointed at it keep their history) and reads the per-staff
 * leaderboard over an optional Jalali date range — the same Σ of signed
 * accruals the payroll liability ties back to.
 */

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { computeCommissionAccrual } from "@/lib/commission";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import {
  CardTitle,
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, errorMessage, Field, InfoBox, inputClass } from "@/app/dashboard/ui";

interface CommissionRuleRow {
  id: string;
  employeeId: string;
  employeeName: string | null;
  kind: "percent" | "fixed";
  basis: "net" | "margin";
  value: number;
  itemIds: string[] | null;
  brandIds: string[] | null;
  categoryIds: string[] | null;
  activeFrom: string | null;
  activeTo: string | null;
  priority: number;
  isActive: boolean;
}

interface StaffMember {
  id: string;
  fullName: string;
}

interface ReportRow {
  employeeId: string;
  employeeName: string;
  amount: number;
  basisAmount: number;
  lineCount: number;
}

const BASIS_LABELS: Record<string, string> = {
  net: "روی مبلغ خط",
  margin: "روی سود (مبلغ خط منهای بهای تمام‌شده)",
};

/** One phrase for a rule's scope axis — the editor creates catch-all rules, but seeded/service-created rules can scope. */
function scopeLabel(rule: Pick<CommissionRuleRow, "itemIds" | "brandIds" | "categoryIds">): string {
  if (rule.itemIds?.length) return `${formatPersianNumber(rule.itemIds.length)} کالا`;
  if (rule.brandIds?.length) return `${formatPersianNumber(rule.brandIds.length)} برند`;
  if (rule.categoryIds?.length) return `${formatPersianNumber(rule.categoryIds.length)} دسته`;
  return "همهٔ کالاها";
}

/**
 * Compensation data: reading needs `commission.view`, writing a rule
 * `commission.manage` (issue #764) — never the broad Growth or campaign keys.
 */
export function CommissionSection({ canManage }: { canManage: boolean }) {
  const money = useMoney();
  const [rules, setRules] = useState<CommissionRuleRow[] | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loadError, setLoadError] = useState("");
  const [report, setReport] = useState<ReportRow[] | null>(null);
  const [reportError, setReportError] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError("");
    // `api` never rejects: a dropped connection comes back ok:false with error
    // "network_error", which errorMessage renders in Persian.
    const { ok, data } = await api<{ rules?: CommissionRuleRow[]; staff?: StaffMember[]; error?: string }>(
      "/api/commission/rules",
    );
    if (ok && data.rules) {
      setRules(data.rules);
      setStaff(data.staff ?? []);
    } else {
      // The old code never surfaced this: a failed GET left `rules` null, so
      // the section showed its skeleton forever with no message and no way to
      // retry.
      setLoadError(errorMessage(data.error));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const rangeInvalid = Boolean(from && to && from > to);
  const loadReport = useCallback(async () => {
    setReportError("");
    if (from && to && from > to) {
      // Don't fire a query the API would (rightly) refuse with invalid_range;
      // say so beside the filters instead.
      setReport(null);
      return;
    }
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    const { ok, data } = await api<{ report?: ReportRow[]; error?: string }>(
      `/api/commission/report${qs ? `?${qs}` : ""}`,
    );
    // A failed report read previously rendered as «هنوز پورسانتی ثبت نشده
    // است» — indistinguishable from a true empty leaderboard.
    if (ok && data.report) setReport(data.report);
    else setReportError(errorMessage(data.error));
  }, [from, to]);
  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  async function toggleRule(rule: CommissionRuleRow) {
    setTogglingId(rule.id);
    setError("");
    setDone("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/commission/rules", {
      method: "PATCH",
      body: JSON.stringify({ ruleId: rule.id, isActive: !rule.isActive }),
    });
    setTogglingId(null);
    if (!ok) {
      setError(data.message ?? errorMessage(data.error));
    } else {
      setDone(rule.isActive ? "قانون غیرفعال شد و از این پس پورسانتی نمی‌سازد." : "قانون دوباره فعال شد.");
      void load();
    }
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <ErrorBox>{loadError}</ErrorBox>
        <div>
          <Button variant="outline" className="min-h-11" onClick={() => void load()}>
            تلاش دوباره
          </Button>
        </div>
      </div>
    );
  }
  if (!rules) {
    return <SectionCardSkeleton rows={4} />;
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {done ? <InfoBox>{done}</InfoBox> : null}

      <div className={canManage ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
        {canManage ? (
        <RuleForm
          staff={staff}
          onSaved={(m) => {
            setDone(m);
            setError("");
            void load();
          }}
          onError={(m) => {
            setError(m);
            setDone("");
          }}
        />
        ) : null}
        <SectionCard
          title={<CardTitle eyebrow="گزارش پورسانت" title="رتبه‌بندی فروشندگان" />}
          description="مجموع پورسانت انباشته — همان عددی که به‌عنوان بدهی حقوق ثبت شده است"
        >
          <div className="mb-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
            <Field label="از تاریخ">
              <JalaliDatePicker value={from} onChange={setFrom} ariaLabel="از تاریخ" />
            </Field>
            <Field label="تا تاریخ">
              <JalaliDatePicker value={to} onChange={setTo} ariaLabel="تا تاریخ" />
            </Field>
            {from || to ? (
              <Button variant="ghost" size="sm" className="col-span-2 justify-self-start sm:col-span-1" onClick={() => { setFrom(""); setTo(""); }}>
                همهٔ دوره‌ها
              </Button>
            ) : null}
          </div>
          {rangeInvalid ? (
            <ErrorBox>{errorMessage("invalid_range")}</ErrorBox>
          ) : reportError ? (
            <div className="space-y-2">
              <ErrorBox>{reportError}</ErrorBox>
              <Button variant="ghost" size="sm" onClick={() => void loadReport()}>
                تلاش دوباره
              </Button>
            </div>
          ) : report === null ? (
            // Bare rows, not SectionCardSkeleton — a card-in-card placeholder
            // inside this card would read as a nested panel, not as loading.
            <LoadingSkeleton rows={3} compact />
          ) : report.length === 0 ? (
            <EmptyState>
              {from || to ? "در این بازه پورسانتی ثبت نشده است." : "هنوز پورسانتی ثبت نشده است."}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {report.map((r, i) => (
                <li key={r.employeeId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5">
                  <div className="min-w-0 flex-1 basis-48">
                    <span className="font-medium text-foreground">
                      {formatPersianNumber(i + 1)}. {r.employeeName}
                    </span>
                    <span className="mr-2 text-xs text-muted-foreground">
                      {formatPersianNumber(r.lineCount)} خط · مبنا {money.format(r.basisAmount)}
                    </span>
                  </div>
                  <span className="shrink-0 font-semibold text-emerald-700 dark:text-emerald-300">{money.format(r.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title={<CardTitle eyebrow="مقررات مالی" title="قوانین پورسانت" />}
        description="هر خط فروش به خاص‌ترین قانون می‌رسد: کالا، بعد برند، بعد دسته و در پایان قانون کلی؛ میان قوانین هم‌سطح، اولویت بزرگ‌تر برنده است. قانون حذف نمی‌شود — غیرفعالش کنید تا تاریخچهٔ تسویه حفظ شود."
      >
        {rules.length === 0 ? (
          <EmptyState>هنوز قانونی تعریف نشده است؛ از فرم «قانون جدید» اولین قانون را بسازید.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5">
                <div className="min-w-0 flex-1 basis-56">
                  <span className="font-medium text-foreground">{r.employeeName ?? "نامشخص"}</span>
                  <span className="mr-2 text-xs text-muted-foreground">
                    {r.kind === "percent" ? `${formatPersianNumber(r.value)}٪` : money.format(r.value)} ·{" "}
                    {BASIS_LABELS[r.basis]} · {scopeLabel(r)} · اولویت {formatPersianNumber(r.priority)}
                    {r.activeFrom || r.activeTo
                      ? ` · ${r.activeFrom ? `از ${toPersianDigits(formatJalali(r.activeFrom.slice(0, 10)))}` : ""} ${r.activeTo ? `تا ${toPersianDigits(formatJalali(r.activeTo.slice(0, 10)))}` : ""}`
                      : ""}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge tone={r.isActive ? "positive" : "neutral"}>{r.isActive ? "فعال" : "غیرفعال"}</StatusBadge>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={togglingId === r.id}
                      onClick={() => void toggleRule(r)}
                    >
                      {r.isActive ? "غیرفعال کردن" : "فعال کردن"}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function RuleForm({
  staff,
  onSaved,
  onError,
}: {
  staff: StaffMember[];
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [employeeId, setEmployeeId] = useState("");
  const [kind, setKind] = useState<"percent" | "fixed">("percent");
  const [basis, setBasis] = useState<"net" | "margin">("net");
  const [value, setValue] = useState("");
  const [priority, setPriority] = useState("0");
  const [busy, setBusy] = useState(false);
  // A sample sale for the preview — never saved, only fed to the engine.
  const [sampleNet, setSampleNet] = useState("");
  const [sampleCost, setSampleCost] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!employeeId || !trimmed) return;

    // Validate before the server has to: the old form let a decimal percent
    // through (the input even hinted at it) and the owner only learned that
    // percentages must be whole from the server's refusal. `money.parse`
    // throws on unparseable input — catch it rather than crash the submit.
    let parsed: number;
    try {
      parsed = kind === "percent" ? Number(trimmed) : money.parse(trimmed);
    } catch {
      onError(kind === "percent" ? "درصد پورسانت باید یک عدد صحیح بین ۰ تا ۱۰۰ باشد." : "مبلغ پورسانت نامعتبر است.");
      return;
    }
    if (kind === "percent" && (!Number.isInteger(parsed) || parsed < 0 || parsed > 100)) {
      onError("درصد پورسانت باید یک عدد صحیح بین ۰ تا ۱۰۰ باشد.");
      return;
    }
    if (kind === "fixed" && (!Number.isInteger(parsed) || parsed < 0)) {
      onError("مبلغ پورسانت باید یک عدد صحیح غیرمنفی باشد.");
      return;
    }

    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/commission/rules", {
      method: "POST",
      body: JSON.stringify({
        employeeId,
        kind,
        basis,
        value: parsed,
        priority: Number(priority) || 0,
      }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? errorMessage(data.error));
    else {
      setValue("");
      onSaved("قانون پورسانت ذخیره شد.");
    }
  }

  /**
   * What this rule would accrue on a sample sale, computed by the same
   * `computeCommissionAccrual` that books real commissions (issue #764), so
   * the preview can never disagree with the ledger.
   */
  const preview = (() => {
    const read = (raw: string): number | null => {
      if (!raw.trim()) return null;
      try {
        return money.parse(raw);
      } catch {
        return null;
      }
    };
    const net = read(sampleNet);
    const ruleValue = kind === "percent" ? Number(value) : read(value);
    if (net === null || ruleValue === null || !Number.isFinite(ruleValue)) return null;
    const cost = basis === "margin" ? read(sampleCost) ?? 0 : null;
    return computeCommissionAccrual({ net, cost }, [{ id: "preview", kind, value: ruleValue, basis }]).amount;
  })();

  return (
    <SectionCard title="قانون جدید" bodyClassName="space-y-3 p-4 sm:p-5">
      <form onSubmit={submit} className="grid gap-3">
        <Field label="فروشنده">
          <select className={inputClass} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
            <option value="">انتخاب کنید…</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="نوع">
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as "percent" | "fixed")}>
              <option value="percent">درصدی</option>
              <option value="fixed">مبلغ ثابت ({money.unitLabel})</option>
            </select>
          </Field>
          <Field label={kind === "percent" ? "درصد (عدد صحیح ۰ تا ۱۰۰)" : `مبلغ (${money.unitLabel})`}>
            <PersianNumberInput
              inputMode="numeric"
              allowNegative={false}
              className={inputClass}
              dir="ltr"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </Field>
        </div>
        <Field label="مبنا">
          <select className={inputClass} value={basis} onChange={(e) => setBasis(e.target.value as "net" | "margin")}>
            <option value="net">{BASIS_LABELS.net}</option>
            <option value="margin">{BASIS_LABELS.margin}</option>
          </select>
        </Field>
        <Field label="اولویت (بیشتر = زودتر)">
          <PersianNumberInput
            inputMode="numeric"
            allowNegative={false}
            grouping={false}
            className={inputClass}
            dir="ltr"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </Field>
        <fieldset className="grid gap-2 rounded-xl border border-border/80 p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">پیش‌نمایش روی یک فروش نمونه</legend>
          <div className={basis === "margin" ? "grid gap-2 sm:grid-cols-2" : "grid gap-2"}>
            <Field label={`فروش خالص خط (${money.unitLabel})`}>
              <PersianNumberInput
                inputMode="numeric"
                allowNegative={false}
                className={inputClass}
                dir="ltr"
                value={sampleNet}
                onChange={(e) => setSampleNet(e.target.value)}
              />
            </Field>
            {basis === "margin" ? (
              <Field label={`بهای تمام‌شده (${money.unitLabel})`}>
                <PersianNumberInput
                  inputMode="numeric"
                  allowNegative={false}
                  className={inputClass}
                  dir="ltr"
                  value={sampleCost}
                  onChange={(e) => setSampleCost(e.target.value)}
                />
              </Field>
            ) : null}
          </div>
          <p aria-live="polite" className="text-sm text-foreground">
            {preview === null ? (
              <span className="text-muted-foreground">مبلغ فروش و مقدار قانون را وارد کنید تا پورسانت محاسبه شود.</span>
            ) : (
              <>
                پورسانت این فروش: <b>{money.format(preview)}</b>
              </>
            )}
          </p>
        </fieldset>
        <Button type="submit" disabled={busy} className="min-h-11 w-full">
          ذخیره قانون
        </Button>
      </form>
    </SectionCard>
  );
}
