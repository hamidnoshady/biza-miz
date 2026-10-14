"use client";

import { useId, useState } from "react";
import { EmptyState, StatusBadge, cardClass } from "@/app/dashboard/page-chrome";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { inputClass, PrimaryButton } from "@/app/dashboard/ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { INVALID_DRAFT, draftDisplayText, draftRial, exceedsJsonAmount, type AmountDraft } from "@/lib/payroll-amount-drafts";
import type { PayrollAdvance, PayrollPaymentAccount, StaffWage } from "@/lib/payroll-types";

/** A date the server sent, as Shamsi — or a dash: a malformed one should cost a dash, not the screen. */
function jalaliOrDash(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return toPersianDigits(formatJalali(value));
  } catch {
    return "—";
  }
}

/** The old shorthand, offered only when the chart has no cash or bank account to pick. */
const SHORTHAND = [
  { value: "method:cash", label: "صندوق (نقدی)" },
  { value: "method:bank", label: "بانکی" },
];

/**
 * «مساعده کارکنان» — salary advances paid ahead of the month's pay.
 *
 * An advance leaves a real cash, bank or petty-cash account (the same list a
 * payroll payment chooses from) and is recovered, up to the month's remaining
 * pay, by the next accrual. Voiding one posts an exact mirror and is refused
 * once any of it has been recovered.
 *
 * The amount is a draft that remembers the unit it was typed in, and the
 * request carries its digits as a JSON number built from them — never through
 * `Number` — refusing anything a JSON number would round. Recording and voiding
 * go through the section (`onRecord`, `onVoid`), which owns the runner, the
 * busy state and the notices.
 */
export function PayrollAdvancesPanel({
  staff,
  advances,
  paymentAccounts,
  readOnly,
  busy,
  workingId,
  onRecord,
  onVoid,
  onError,
}: {
  staff: StaffWage[];
  advances: PayrollAdvance[];
  paymentAccounts: PayrollPaymentAccount[];
  /** `payroll.view` without `payroll.manage`: the list is shown, nothing can be recorded or voided. */
  readOnly: boolean;
  busy: boolean;
  /** The advance a void is in flight for, so only its button locks. */
  workingId: string | null;
  /** Posts the JSON body of a new advance; resolves true when it was recorded. */
  onRecord: (body: string) => Promise<boolean>;
  onVoid: (advance: PayrollAdvance) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const money = useMoney();
  const dateFieldId = useId();

  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState<AmountDraft>({ text: "", unit: money.unit });
  const [account, setAccount] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [voidTarget, setVoidTarget] = useState<PayrollAdvance | null>(null);

  const accountOptions =
    paymentAccounts.length > 0
      ? paymentAccounts.map((a) => ({ value: a.id, label: `${a.name} (${toPersianDigits(a.code)})` }))
      : SHORTHAND;
  // Cash is the usual source of an advance; fall back to the first account on offer.
  const defaultAccount = paymentAccounts.find((a) => a.role === "cash")?.id ?? accountOptions[0].value;
  const selectedAccount = accountOptions.some((o) => o.value === account) ? account : defaultAccount;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!userId) return onError("کارمند را انتخاب کنید.");

    const rial = draftRial(amount);
    if (rial === null || rial === INVALID_DRAFT || rial === "0") return onError("مبلغ مساعده معتبر نیست.");
    if (exceedsJsonAmount(rial)) return onError("مبلغ مساعده بیش از حد مجاز است.");

    const fields: Record<string, string> = { userId };
    if (selectedAccount.startsWith("method:")) fields.method = selectedAccount.slice("method:".length);
    else fields.paymentAccountId = selectedAccount;
    if (date) fields.advanceDate = date;
    if (note.trim()) fields.note = note.trim();
    // The amount's digits go in as written: they are validated integer text, so
    // nothing here rounds them.
    const head = JSON.stringify(fields);
    const body = `${head.slice(0, -1)},"amount":${rial}}`;

    if (await onRecord(body)) {
      setAmount({ text: "", unit: money.unit });
      setNote("");
      setDate("");
    }
  }

  async function confirmVoid() {
    const target = voidTarget;
    if (!target) return;
    setVoidTarget(null);
    await onVoid(target);
  }

  return (
    <section aria-labelledby="payroll-advances-heading" className={cardClass}>
      <header className="border-b border-border/80 px-4 py-4 sm:px-5">
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">علی‌الحساب</p>
        <h2 id="payroll-advances-heading" className="mt-1 text-base font-semibold text-foreground">مساعده کارکنان</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          مساعده از صندوق یا بانک پرداخت و در تعهد حقوق بعدی از خالص پرداختی کسر می‌شود؛ مازاد به ماه بعد منتقل می‌شود.
        </p>
      </header>

      {readOnly ? null : (
        <form
          onSubmit={submit}
          className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-[minmax(10rem,1fr)_minmax(8rem,12rem)_minmax(10rem,14rem)_minmax(9rem,11rem)_auto] lg:items-end"
        >
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">کارمند</span>
            <SearchableSelect
              value={userId}
              onChange={setUserId}
              ariaLabel="کارمند دریافت‌کنندهٔ مساعده"
              placeholder="انتخاب کنید"
              options={staff.map((s) => ({ value: s.id, label: s.fullName }))}
            />
          </label>
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">مبلغ ({money.unitLabel})</span>
            <PersianNumberInput
              className={inputClass + " w-full"}
              dir="ltr"
              inputMode="numeric"
              allowDecimal={false}
              allowNegative={false}
              value={draftDisplayText(amount, money.unit)}
              onChange={(e) => setAmount({ text: e.target.value, unit: money.unit })}
              placeholder="۰"
              aria-label="مبلغ مساعده"
            />
          </label>
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">پرداخت از</span>
            <SearchableSelect
              value={selectedAccount}
              onChange={setAccount}
              ariaLabel="حساب پرداخت مساعده"
              options={accountOptions}
            />
          </label>
          <div className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground" id={dateFieldId}>
              تاریخ <span className="font-normal">(اختیاری)</span>
            </span>
            <JalaliDatePicker value={date} onChange={setDate} placeholder="امروز" labelledBy={dateFieldId} />
          </div>
          <div className="min-w-32">
            <PrimaryButton disabled={busy || !userId || !amount.text.trim()}>{busy ? "در حال ثبت…" : "ثبت مساعده"}</PrimaryButton>
          </div>
          <label className="block text-sm font-medium sm:col-span-2 lg:col-span-5">
            <span className="mb-1.5 block text-xs text-muted-foreground">توضیح (اختیاری)</span>
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </label>
        </form>
      )}

      <div className="px-4 pb-4 sm:px-5 sm:pb-5">
        {advances.length === 0 ? (
          <EmptyState>مساعده‌ای ثبت نشده است.</EmptyState>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {advances.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{a.fullName ?? "عضو حذف‌شده"}</p>
                  <p className="text-xs text-muted-foreground">
                    {jalaliOrDash(a.advanceDate)} — {a.method === "cash" ? "صندوق" : "بانک"}
                    {a.note ? ` — ${a.note}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={"font-semibold tabular-nums " + (a.status === "voided" ? "text-muted-foreground line-through" : "text-foreground")}
                  >
                    {money.formatText(a.amount)}
                  </span>
                  {a.status === "voided" ? (
                    <StatusBadge tone="neutral">ابطال‌شده</StatusBadge>
                  ) : readOnly ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setVoidTarget(a)}
                      disabled={busy || workingId === a.id}
                      aria-label={`ابطال مساعده ${a.fullName ?? ""}`}
                    >
                      ابطال
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* A real dialog, like every other payroll confirmation; the server stays the boundary. */}
      <Dialog open={voidTarget !== null} onOpenChange={(open) => !open && setVoidTarget(null)}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>ابطال مساعده</DialogTitle>
            <DialogDescription className="leading-6">
              {voidTarget ? (
                <>
                  مساعدهٔ «{voidTarget.fullName ?? "عضو حذف‌شده"}» به مبلغ{" "}
                  <span className="font-semibold text-foreground">{money.formatText(voidTarget.amount)}</span> با یک سند معکوس
                  (به تاریخ امروز) ابطال می‌شود.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-start">
            <Button type="button" variant="destructive" onClick={confirmVoid} disabled={busy}>
              ابطال مساعده
            </Button>
            <Button type="button" variant="outline" onClick={() => setVoidTarget(null)}>
              انصراف
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
