"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { cardClass } from "@/app/dashboard/page-chrome";
import { inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import {
  MAX_TAX_BRACKETS,
  payrollSettingsApplyDeductions,
  type PayrollSettings,
} from "@/lib/payroll-gross-to-net";

interface BracketDraft {
  key: number;
  upTo: string;
  rate: string;
}

interface Draft {
  employeeInsurancePercent: string;
  employerInsurancePercent: string;
  unemploymentInsurancePercent: string;
  insuranceCeiling: string;
  taxExemptThreshold: string;
  nonTaxableAllowancesInsurable: boolean;
  deductEmployeeInsuranceFromTaxable: boolean;
  brackets: BracketDraft[];
}

let bracketKey = 0;

function percentText(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * «تنظیمات بیمه و مالیات حقوق» — the business's own payroll rates (audit F11).
 *
 * Every field starts empty and an empty field is *not applied*: this screen
 * never pre-fills a statutory figure, the same principle the VAT rate follows.
 * Money is shown and typed in the business's chosen unit and converted to
 * Rial before it is sent; percentages are plain numbers with up to two
 * decimals. Validation is the server's (`parsePayrollSettings`), so the form
 * and the API cannot disagree about what is a valid bracket list.
 */
export function PayrollSettingsPanel({
  settings,
  onSave,
}: {
  settings: PayrollSettings;
  /** Persists the document; resolves to a Persian error, or null once saved. */
  onSave: (settings: PayrollSettings) => Promise<string | null>;
}) {
  const money = useMoney();
  const headingId = useId();

  const fromSettings = useMemo(
    () =>
      (s: PayrollSettings): Draft => ({
        employeeInsurancePercent: percentText(s.employeeInsurancePercent),
        employerInsurancePercent: percentText(s.employerInsurancePercent),
        unemploymentInsurancePercent: percentText(s.unemploymentInsurancePercent),
        insuranceCeiling: s.insuranceCeilingRial === null ? "" : String(money.toInput(s.insuranceCeilingRial)),
        taxExemptThreshold: s.taxExemptThresholdRial === null ? "" : String(money.toInput(s.taxExemptThresholdRial)),
        nonTaxableAllowancesInsurable: s.nonTaxableAllowancesInsurable,
        deductEmployeeInsuranceFromTaxable: s.deductEmployeeInsuranceFromTaxable,
        brackets: s.taxBrackets.map((b) => ({
          key: ++bracketKey,
          upTo: b.upToRial === null ? "" : String(money.toInput(b.upToRial)),
          rate: String(b.ratePercent),
        })),
      }),
    [money],
  );

  const [draft, setDraft] = useState<Draft>(() => fromSettings(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  // Re-seed from the server copy only when it actually changed (a save, or a
  // ریال↔تومان switch) — not on every refresh of the section, which would wipe
  // a half-typed bracket list.
  const settingsKey = JSON.stringify(settings);
  useEffect(() => {
    setDraft(fromSettings(JSON.parse(settingsKey) as PayrollSettings));
  }, [settingsKey, fromSettings]);

  const configured = payrollSettingsApplyDeductions(settings);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function setBracket(key: number, patch: Partial<BracketDraft>) {
    setDraft((prev) => ({ ...prev, brackets: prev.brackets.map((b) => (b.key === key ? { ...b, ...patch } : b)) }));
  }

  function parsePercent(raw: string): number | null | "bad" {
    const text = raw.trim();
    if (!text) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : "bad";
  }

  function parseRial(raw: string): number | null | "bad" {
    const text = raw.trim();
    if (!text) return null;
    try {
      const rial = money.parse(text);
      return Number.isSafeInteger(rial) && rial >= 0 ? rial : "bad";
    } catch {
      return "bad";
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const percents = {
      employeeInsurancePercent: parsePercent(draft.employeeInsurancePercent),
      employerInsurancePercent: parsePercent(draft.employerInsurancePercent),
      unemploymentInsurancePercent: parsePercent(draft.unemploymentInsurancePercent),
    };
    if (Object.values(percents).includes("bad")) return setError("درصدها باید عدد باشند.");
    const insuranceCeilingRial = parseRial(draft.insuranceCeiling);
    const taxExemptThresholdRial = parseRial(draft.taxExemptThreshold);
    if (insuranceCeilingRial === "bad" || taxExemptThresholdRial === "bad") return setError("مبلغ وارد‌شده معتبر نیست.");
    const taxBrackets: Array<{ upToRial: number | null; ratePercent: number }> = [];
    for (const [i, b] of draft.brackets.entries()) {
      const upTo = parseRial(b.upTo);
      const rate = parsePercent(b.rate);
      if (upTo === "bad" || rate === "bad" || rate === null) {
        return setError(`پلهٔ ${toPersianDigits(i + 1)} مالیات کامل یا معتبر نیست.`);
      }
      taxBrackets.push({ upToRial: upTo, ratePercent: rate });
    }

    setSaving(true);
    const failure = await onSave({
      ...percents,
      insuranceCeilingRial,
      taxExemptThresholdRial,
      nonTaxableAllowancesInsurable: draft.nonTaxableAllowancesInsurable,
      deductEmployeeInsuranceFromTaxable: draft.deductEmployeeInsuranceFromTaxable,
      taxBrackets,
    } as PayrollSettings);
    setSaving(false);
    if (failure) setError(failure);
  }

  const percentField = (key: "employeeInsurancePercent" | "employerInsurancePercent" | "unemploymentInsurancePercent", label: string) => (
    <label className="block text-sm font-medium">
      <span className="mb-1.5 block text-xs text-muted-foreground">{label}</span>
      <PersianNumberInput
        className={inputClass + " w-full"}
        dir="ltr"
        inputMode="decimal"
        allowDecimal
        value={draft[key]}
        onChange={(e) => set(key, e.target.value)}
        placeholder="اعمال نمی‌شود"
        aria-label={label}
      />
    </label>
  );

  return (
    <section aria-labelledby={headingId} className={cardClass}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">قواعد کسور</p>
          <h2 id={headingId} className="mt-1 text-base font-semibold text-foreground">تنظیمات بیمه و مالیات حقوق</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {configured
              ? "نرخ‌هایی که این کسب‌وکار وارد کرده در محاسبهٔ ناخالص به خالص اعمال می‌شوند."
              : "هنوز نرخی وارد نشده است؛ تا وقتی خالی است، هیچ کسری اعمال نمی‌شود و خالص پرداختی برابر ناخالص است."}
          </p>
        </div>
        <SecondaryButton onClick={() => setOpen((v) => !v)}>{open ? "بستن" : "ویرایش نرخ‌ها"}</SecondaryButton>
      </header>

      {open ? (
        <form onSubmit={save} className="space-y-5 p-4 sm:p-5">
          <p className="text-xs leading-5 text-muted-foreground">
            هیچ نرخی از پیش فرض نشده است؛ نرخ‌های قانونی جاری را خودتان وارد کنید. هر فیلد خالی یعنی «اعمال نمی‌شود».
          </p>

          <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <legend className="mb-2 text-sm font-semibold text-foreground">بیمه تأمین اجتماعی</legend>
            {percentField("employeeInsurancePercent", "سهم بیمه کارگر (٪)")}
            {percentField("employerInsurancePercent", "سهم بیمه کارفرما (٪)")}
            {percentField("unemploymentInsurancePercent", "بیمه بیکاری سهم کارفرما (٪، اختیاری)")}
            <label className="block text-sm font-medium">
              <span className="mb-1.5 block text-xs text-muted-foreground">سقف مبنای بیمه ({money.unitLabel}، اختیاری)</span>
              <PersianNumberInput
                className={inputClass + " w-full"}
                dir="ltr"
                inputMode="numeric"
                allowDecimal={false}
                value={draft.insuranceCeiling}
                onChange={(e) => set("insuranceCeiling", e.target.value)}
                placeholder="بدون سقف"
                aria-label="سقف مبنای بیمه"
              />
            </label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-4">
              <input
                type="checkbox"
                checked={draft.nonTaxableAllowancesInsurable}
                onChange={(e) => set("nonTaxableAllowancesInsurable", e.target.checked)}
              />
              <span>مزایای غیرمشمول مالیات هم مشمول بیمه باشند</span>
            </label>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-semibold text-foreground">مالیات حقوق (ماهانه)</legend>
            <label className="block max-w-xs text-sm font-medium">
              <span className="mb-1.5 block text-xs text-muted-foreground">سقف معافیت ماهانه ({money.unitLabel})</span>
              <PersianNumberInput
                className={inputClass + " w-full"}
                dir="ltr"
                inputMode="numeric"
                allowDecimal={false}
                value={draft.taxExemptThreshold}
                onChange={(e) => set("taxExemptThreshold", e.target.value)}
                placeholder="بدون معافیت"
                aria-label="سقف معافیت مالیات حقوق"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.deductEmployeeInsuranceFromTaxable}
                onChange={(e) => set("deductEmployeeInsuranceFromTaxable", e.target.checked)}
              />
              <span>سهم بیمه کارگر پیش از محاسبهٔ مالیات از درآمد مشمول کسر شود</span>
            </label>

            <div className="space-y-2">
              <p className="text-xs leading-5 text-muted-foreground">
                پله‌ها به ترتیب صعودی؛ «تا سقف» مبلغ ماهانهٔ مشمول است و پلهٔ آخر بدون سقف می‌ماند. مالیات فقط روی مازاد بر سقف معافیت محاسبه می‌شود.
              </p>
              {draft.brackets.length === 0 ? (
                <p className="text-sm text-muted-foreground">پله‌ای تعریف نشده است؛ مالیات حقوق اعمال نمی‌شود.</p>
              ) : (
                <ul className="space-y-2">
                  {draft.brackets.map((b, i) => {
                    const isLast = i === draft.brackets.length - 1;
                    return (
                      <li key={b.key} className="grid gap-2 rounded-xl border border-border/80 bg-muted/60 p-3 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,8rem)_auto] sm:items-end">
                        <span className="text-xs font-medium text-muted-foreground">پلهٔ {toPersianDigits(i + 1)}</span>
                        <label className="block text-sm">
                          <span className="mb-1 block text-xs text-muted-foreground">
                            تا سقف ({money.unitLabel}){isLast ? " — پلهٔ آخر خالی بماند" : ""}
                          </span>
                          <PersianNumberInput
                            className={inputClass + " w-full"}
                            dir="ltr"
                            inputMode="numeric"
                            allowDecimal={false}
                            value={b.upTo}
                            onChange={(e) => setBracket(b.key, { upTo: e.target.value })}
                            placeholder={isLast ? "بدون سقف" : "۰"}
                            aria-label={`سقف پلهٔ ${i + 1}`}
                          />
                        </label>
                        <label className="block text-sm">
                          <span className="mb-1 block text-xs text-muted-foreground">نرخ (٪)</span>
                          <PersianNumberInput
                            className={inputClass + " w-full"}
                            dir="ltr"
                            inputMode="decimal"
                            allowDecimal
                            value={b.rate}
                            onChange={(e) => setBracket(b.key, { rate: e.target.value })}
                            aria-label={`نرخ پلهٔ ${i + 1}`}
                          />
                        </label>
                        <SecondaryButton
                          onClick={() => setDraft((prev) => ({ ...prev, brackets: prev.brackets.filter((x) => x.key !== b.key) }))}
                        >
                          حذف
                        </SecondaryButton>
                      </li>
                    );
                  })}
                </ul>
              )}
              <SecondaryButton
                disabled={draft.brackets.length >= MAX_TAX_BRACKETS}
                onClick={() =>
                  setDraft((prev) => ({ ...prev, brackets: [...prev.brackets, { key: ++bracketKey, upTo: "", rate: "" }] }))
                }
              >
                افزودن پله
              </SecondaryButton>
            </div>
          </fieldset>

          <div aria-live="assertive" role="alert">
            {error ? (
              <p className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>
            ) : null}
          </div>
          <div className="min-w-40">
            <PrimaryButton disabled={saving}>{saving ? "در حال ذخیره…" : "ذخیره تنظیمات"}</PrimaryButton>
          </div>
        </form>
      ) : null}
    </section>
  );
}
