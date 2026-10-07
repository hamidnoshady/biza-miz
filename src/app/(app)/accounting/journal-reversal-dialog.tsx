"use client";

/**
 * «برگشت سند» — the confirmation the journal's one destructive action deserves.
 *
 * Reversing used to be a single click: the button posted the reversing
 * journal immediately, with no summary of what was about to be reversed, no
 * reason, no control over the reversal's own date, and no statement of what
 * actually happens — which is not "undo". A reversal posts a **new, permanent
 * accounting document**; the original stays in the book for ever. An
 * accountant has to be told that before they commit, not after.
 *
 * So this dialog shows the original (date, source, branch, poster, memo,
 * total), the exact lines that will be posted — every debit and credit
 * swapped, rendered BigInt-safe through `money.formatText` — an optional
 * reason that lands in the reversing document's memo, and the reversal date
 * through the Jalali picker (the API accepts both; the dialog was the only
 * thing not offering them). Submission is single-flight, and the API's
 * fiscal-period and already-reversed answers are surfaced here rather than
 * in the page-level error box the reader has scrolled away from.
 *
 * `ledger.approve` is a high-risk permission; this is the UI treating it as
 * one. The server guard in `/api/ledger/entries/[id]/reverse` remains
 * authoritative — this dialog is the second lock, never the only one.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { ErrorBox, InfoBox, api, inputClass } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import { MANUAL_MEMO_MAX } from "@/lib/manual-journal";
import type { JournalEntryView } from "./journal-view";

/** The reversal-specific answers, in the reader's language. Everything else falls through to the shared map. */
const REVERSAL_ERRORS: Record<string, string> = {
  entry_not_found: "این سند دیگر وجود ندارد؛ فهرست را تازه کنید.",
  not_reversible: "فقط اسناد دستی قابل برگشت هستند.",
  cannot_reverse_a_reversal: "سند برگشتی را نمی‌توان دوباره برگشت زد.",
  already_reversed: "این سند هم‌اکنون توسط فرد دیگری برگشت خورده است؛ فهرست را تازه کنید.",
  entry_has_no_lines: "این سند ردیف حسابداری ندارد و قابل برگشت نیست.",
  invalid_entry_date: "تاریخ برگشت معتبر نیست.",
  memo_too_long: "دلیل برگشت بیش از حد طولانی است؛ آن را کوتاه‌تر بنویسید.",
  fiscal_period_locked: "دورهٔ مالیِ تاریخ انتخاب‌شده قفل است؛ تاریخ دیگری انتخاب کنید.",
  fiscal_period_soft_closed:
    "دورهٔ مالیِ تاریخ انتخاب‌شده بستهٔ موقت است؛ فقط مالک یا حسابدار می‌تواند در آن سند ثبت کند.",
  forbidden: "برگشت سند نیاز به دسترسی «تأیید سند» دارد.",
};

function reversalErrorMessage(code: string | undefined): string {
  return REVERSAL_ERRORS[code ?? ""] ?? "برگشت سند انجام نشد. دوباره تلاش کنید.";
}

export function JournalReversalDialog({
  entry,
  onClose,
  onReversed,
}: {
  entry: JournalEntryView;
  onClose: () => void;
  /** The reversing document's id, so the list can refresh and jump to it. */
  onReversed: (reversalEntryId: string) => void;
}) {
  const money = useMoney();
  const [memo, setMemo] = useState("");
  const [entryDate, setEntryDate] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const memoTooLong = memo.trim().length > MANUAL_MEMO_MAX;

  async function submit() {
    // Single-flight: a double click on a destructive accounting action must
    // not race two reversals of the same document through the API.
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const { ok, data } = await api<{ entryId?: string; error?: string }>(
        `/api/ledger/entries/${entry.id}/reverse`,
        {
          method: "POST",
          body: JSON.stringify({
            memo: memo.trim() || undefined,
            entryDate: entryDate || undefined,
          }),
        },
      );
      if (!ok || !data.entryId) {
        setError(reversalErrorMessage(data.error));
        return;
      }
      onReversed(data.entryId);
    } catch {
      setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>برگشت سند حسابداری</DialogTitle>
          <DialogDescription>
            سند اصلی در دفتر باقی می‌ماند و یک سند جدید با بدهکار و بستانکارِ وارونه ثبت می‌شود.
          </DialogDescription>
        </DialogHeader>

        <InfoBox>
          این کار «حذف» یا «ویرایش» نیست: یک سند حسابداریِ دائمیِ تازه ثبت می‌شود، اثر مالی دو سند روی هم
          صفر می‌شود و هر دو سند برای همیشه در دفتر دیده خواهند شد.
        </InfoBox>

        <section className="rounded-xl border border-border/80 bg-muted/60 p-3">
          <p className="text-xs font-semibold text-muted-foreground">سند اصلی</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{entry.memo || "سند بدون شرح"}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">تاریخ سند</dt>
              <dd className="mt-0.5 text-foreground">{formatJalali(entry.entryDate)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">منبع</dt>
              <dd className="mt-0.5 text-foreground">{ledgerSourceLabel(entry.sourceType)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">شعبه</dt>
              <dd className="mt-0.5 text-foreground">{entry.locationName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">ثبت‌کننده</dt>
              <dd className="mt-0.5 text-foreground">{entry.createdByName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">زمان ثبت</dt>
              <dd className="mt-0.5 text-foreground">{formatJalali(entry.postedAt, { withTime: true })}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">جمع سند</dt>
              <dd className="mt-0.5 font-semibold tabular-nums text-foreground">
                {money.formatText(entry.totalDebit)}
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <p className="mb-2 text-xs font-semibold text-muted-foreground">
            ردیف‌هایی که ثبت می‌شوند ({toPersianDigits(entry.lines.length)} ردیف)
          </p>
          <DataTable caption="ردیف‌های سند برگشتی">
            <DataTableHead>
              <Th>حساب</Th>
              <Th numeric>بدهکار</Th>
              <Th numeric>بستانکار</Th>
            </DataTableHead>
            <DataTableBody>
              {entry.lines.map((line, index) => (
                <DataTableRow key={`${line.accountId}-${index}`}>
                  <Td muted>
                    {line.accountCode} {line.accountName}
                  </Td>
                  {/* Swapped on purpose: this is the reversing document's own
                      debit/credit, which is what the reader is confirming. */}
                  <Td numeric nowrap>
                    {line.credit !== "0" ? money.formatText(line.credit) : "—"}
                  </Td>
                  <Td numeric nowrap>
                    {line.debit !== "0" ? money.formatText(line.debit) : "—"}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </section>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs text-muted-foreground">تاریخ سند برگشتی</span>
            <JalaliDatePicker
              value={entryDate}
              onChange={setEntryDate}
              placeholder="امروز"
              ariaLabel="تاریخ سند برگشتی"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              خالی بگذارید تا سند با تاریخ امروز ثبت شود؛ سند برگشتی به دورهٔ سند اصلی برنمی‌گردد.
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs text-muted-foreground">دلیل برگشت (اختیاری)</span>
            <input
              className={inputClass}
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              placeholder={`برگشت سند: ${entry.memo ?? ""}`.trim()}
              maxLength={MANUAL_MEMO_MAX + 1}
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              در شرح سند برگشتی ثبت می‌شود و در دفتر باقی می‌ماند.
            </span>
          </label>
        </div>

        <ErrorBox>{memoTooLong ? "دلیل برگشت بیش از حد طولانی است." : error}</ErrorBox>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            انصراف
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void submit()}
            disabled={submitting || memoTooLong}
          >
            {submitting ? "در حال ثبت…" : "تأیید و ثبت سند برگشتی"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
