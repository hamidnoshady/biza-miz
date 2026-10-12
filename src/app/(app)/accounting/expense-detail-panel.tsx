"use client";

/**
 * One expense, opened — the audit surface the register never had (issue #832 §8).
 *
 * A table row can carry a date, an account and an amount; it cannot carry the
 * evidence an accountant needs when a number is questioned. This panel is where
 * the rest of the record lives: who posted it and when, which branch incurred
 * it, both accounts with their codes, the party it was paid to, the receipt
 * photo, the journal entry it posted with its lines, and the reversal state on
 * both sides of a correction.
 *
 * It composes the ledger's own overlay (`OverlayDialog` + `overlayPanelClass`),
 * the same one the statement and history panels use, so a drawer in Accounting
 * looks and closes like every other drawer in Accounting.
 */
import { useState } from "react";
import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, todayIsoDate } from "@/lib/jalali";
import { partyDirectoryHref } from "@/lib/party-directory";
import { EXPENSE_SETTLEMENT_LABELS } from "@/lib/payables-input";
import { useMoney } from "@/components/money/money-context";
import { overlayPanelClass } from "@/app/dashboard/page-chrome";
import { StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { OverlayDialog, fmtJalali } from "./ledger-ui";
import { useOverlayEscape } from "./use-overlay-escape";
import type { Runner } from "./accounting-manager";
import { EXPENSE_STATUS_LABELS, type ExpenseJournalLine, type ExpenseRow, type ExpenseStatus } from "./expense-shared";

export function ExpenseDetailPanel({
  detail,
  journalLines,
  canManage,
  canBrowseMedia,
  busy,
  run,
  onClose,
  onOpenExpense,
}: {
  detail: ExpenseRow;
  /** The lines of the entry this expense posted — read from the ledger, not re-derived here. */
  journalLines: ExpenseJournalLine[];
  canManage: boolean;
  canBrowseMedia: boolean;
  busy: boolean;
  run: Runner;
  onClose: () => void;
  /** Jump to the other half of a correction (the reversal, or what it reverses). */
  onOpenExpense: (id: string) => void;
}) {
  const money = useMoney();
  const [confirming, setConfirming] = useState(false);
  const [reversalDate, setReversalDate] = useState("");
  const [reversalMemo, setReversalMemo] = useState("");
  const [reversalError, setReversalError] = useState("");

  useOverlayEscape(onClose);

  const isReversal = detail.status === "reversal";
  const isReversed = detail.status === "reversed";

  async function submitReversal() {
    setReversalError("");
    // The same rule the create form applies — and the same one the service
    // applies again, because a browser check is a courtesy (issue #832 §5).
    if (reversalDate && reversalDate > todayIsoDate()) {
      setReversalError("تاریخ برگشت نمی‌تواند در آینده باشد.");
      return;
    }
    const ok = await run(() =>
      api(`/api/ledger/expenses/${detail.id}/reverse`, {
        method: "POST",
        body: JSON.stringify({
          expenseDate: reversalDate || undefined,
          memo: reversalMemo.trim() || undefined,
        }),
      }),
    );
    if (ok) onClose();
  }

  return (
    <OverlayDialog headingId="expense-detail-heading" onClose={onClose} dismissible={!busy} sheet>
      <div
        className={`${overlayPanelClass} max-h-[92vh] w-full overflow-y-auto p-4 sm:max-h-[85vh] sm:p-5`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border/80 pb-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">برگهٔ هزینه</p>
            <h2 id="expense-detail-heading" className="mt-1 text-base font-semibold text-foreground">
              {detail.reference ? toPersianDigits(detail.reference) : "بدون شماره"}
              <span className="ms-2 text-sm font-normal text-muted-foreground">
                {toPersianDigits(detail.accountCode)} {detail.accountName}
              </span>
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge tone={detail.status === "active" ? "positive" : detail.status === "reversed" ? "danger" : "active"}>
                {EXPENSE_STATUS_LABELS[detail.status as ExpenseStatus]}
              </StatusBadge>
              <span className="text-xs text-muted-foreground">
                {toPersianDigits(formatJalali(detail.expenseDate))}
                {detail.locationName ? ` · ${detail.locationName}` : ""}
              </span>
            </div>
          </div>
          <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
        </header>

        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <DetailItem label="مبلغ کل پرداختی">
            <span className="font-bold tabular-nums">{money.format(detail.amount)}</span>
          </DetailItem>
          <DetailItem label="مالیات بر ارزش افزوده">
            {detail.vatAmount > 0 ? (
              <span className="tabular-nums">{money.format(detail.vatAmount)}</span>
            ) : (
              <span className="text-muted-foreground">بدون مالیات</span>
            )}
          </DetailItem>
          <DetailItem label="هزینه (خالص از مالیات)">
            <span className="tabular-nums">{money.format(detail.netAmount)}</span>
          </DetailItem>
          <DetailItem label="نحوهٔ تسویه">
            {detail.settlement === "credit"
              ? `${EXPENSE_SETTLEMENT_LABELS.credit}${detail.supplierName ? ` — ${detail.supplierName}` : ""}${
                  detail.dueDate ? ` (سررسید ${formatJalali(detail.dueDate)})` : ""
                }`
              : EXPENSE_SETTLEMENT_LABELS.paid}
          </DetailItem>
          <DetailItem label="بستانکار (حساب پرداخت)">
            {toPersianDigits(detail.paymentAccountCode)} {detail.paymentAccountName}
          </DetailItem>
          <DetailItem label="طرف حساب">
            {detail.partyName ? (
              <Link
                href={partyDirectoryHref("all", { party: detail.partyId ?? "" })}
                className="text-primary underline-offset-2 hover:underline"
              >
                {detail.partyName}
              </Link>
            ) : (
              <span className="text-muted-foreground">{detail.vendor ?? "—"}</span>
            )}
            {detail.partyName && detail.vendor && detail.vendor !== detail.partyName ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                درج‌شده در برگه: {detail.vendor}
              </span>
            ) : null}
          </DetailItem>
          <DetailItem label="ثبت‌کننده">
            {detail.createdByName ?? "—"}
            <span className="mt-1 block text-xs text-muted-foreground">
              {toPersianDigits(formatJalali(detail.createdAt, { withTime: true }))}
            </span>
          </DetailItem>
          <DetailItem label="شرح" wide>
            {detail.memo}
          </DetailItem>
          {detail.reversedAt ? (
            <DetailItem label="برگشت خورده" wide>
              در تاریخ {fmtJalali(detail.reversedAt)} توسط {detail.reversedByName ?? "—"}
              {detail.reversalExpenseId ? (
                <button
                  type="button"
                  onClick={() => onOpenExpense(detail.reversalExpenseId!)}
                  className="mt-1 block text-xs font-semibold text-primary underline-offset-2 hover:underline"
                >
                  باز کردن سند برگشت ({toPersianDigits(detail.reversalReference ?? "")})
                </button>
              ) : null}
            </DetailItem>
          ) : null}
          {isReversal ? (
            <DetailItem label="برگشتِ" wide>
              {detail.reversesExpenseReference ? toPersianDigits(detail.reversesExpenseReference) : "هزینهٔ دیگر"}
              <button
                type="button"
                onClick={() => onOpenExpense(detail.reversesExpenseId!)}
                className="ms-2 text-xs font-semibold text-primary underline-offset-2 hover:underline"
              >
                باز کردن ثبت اصلی
              </button>
            </DetailItem>
          ) : null}
        </dl>

        <section className="mt-4" aria-labelledby="expense-detail-journal">
          <h3 id="expense-detail-journal" className="text-sm font-semibold text-foreground">
            سند حسابداری
          </h3>
          {journalLines.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              برای این هزینه سطر حسابداری‌ای یافت نشد؛ در صورت نیاز با «ثبت سند دستی» بررسی شود.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border/80">
              {journalLines.map((line, index) => (
                <li key={`${line.accountCode}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 break-words">
                    {toPersianDigits(line.accountCode)} {line.accountName}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {line.debit > 0 ? (
                      <span className="font-semibold">بدهکار {money.format(line.debit)}</span>
                    ) : (
                      <span className="text-muted-foreground">بستانکار {money.format(line.credit)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            شمارهٔ سند: <span className="break-all font-mono text-[0.7rem]">{detail.journalEntryId ?? "—"}</span>
          </p>
        </section>

        <ReceiptEvidence
          receiptAssetId={detail.receiptAssetId}
          receiptFileName={detail.receiptFileName}
          canBrowseMedia={canBrowseMedia}
        />

        {canManage && !isReversal && !isReversed ? (
          <section className="mt-5 border-t border-border/80 pt-4" aria-labelledby="expense-reversal-heading">
            {confirming ? (
              <div className="rounded-xl border border-border/80 bg-muted/60 p-3">
                <h3 id="expense-reversal-heading" className="text-sm font-semibold text-foreground">
                  ثبت سند برگشت
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  هزینه حذف یا ویرایش نمی‌شود؛ یک سند برگشت با بدهکار/بستانکار جابه‌جا شده ثبت می‌شود و هر دو
                  ردیف در فهرست می‌مانند. جمع این دو با هم صفر می‌شود و با دفتر روزنامه هم‌خوان می‌ماند.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-xs text-muted-foreground">تاریخ برگشت</span>
                    <JalaliDatePicker
                      value={reversalDate}
                      onChange={(value) => {
                        setReversalDate(value);
                        setReversalError("");
                      }}
                      placeholder="امروز"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs text-muted-foreground">
                      شرح برگشت <span className="font-normal">(اختیاری)</span>
                    </span>
                    <input
                      className={inputClass}
                      value={reversalMemo}
                      onChange={(e) => {
                        setReversalMemo(e.target.value);
                        setReversalError("");
                      }}
                      placeholder={`برگشت هزینه ${detail.reference ?? ""}`.trim()}
                      maxLength={300}
                    />
                  </label>
                </div>
                {reversalError ? <ErrorBox>{reversalError}</ErrorBox> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <PrimaryButton type="button" disabled={busy} onClick={submitReversal}>
                    {busy ? "در حال ثبت…" : "ثبت سند برگشت"}
                  </PrimaryButton>
                  <SecondaryButton
                    onClick={() => {
                      setConfirming(false);
                      setReversalError("");
                    }}
                  >
                    انصراف
                  </SecondaryButton>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs leading-5 text-muted-foreground">
                  ثبت اشتباه را با سند برگشت اصلاح کنید؛ بایگانی یا حذفِ سوابق مالی انجام شدنی نیست.
                </p>
                <SecondaryButton onClick={() => setConfirming(true)}>
                  برگشت این هزینه
                </SecondaryButton>
              </div>
            )}
          </section>
        ) : null}

        {isReversed ? (
          <p className="mt-4 rounded-xl border border-border/80 bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
            این هزینه برگشت خورده است و دوباره برگشت نمی‌خورد. برای ثبت دوبارهٔ آن، یک هزینهٔ جدید ثبت کنید.
          </p>
        ) : null}
      </div>
    </OverlayDialog>
  );
}

function DetailItem({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

/**
 * The receipt evidence, reopened from the register (issue #832 §7).
 *
 * The photo is never duplicated: this is the canonical Media Library asset
 * (migration 0177) shown through the same authenticated `/api/media/[id]/file`
 * route the rest of the product uses, which already allows an accountant with
 * `ledger.view` to render a photo their record points at. When the asset was
 * later deleted the link is gone (`ON DELETE SET NULL`) — and that has to read
 * as «رسید حذف شده», because an accountant deciding whether an expense is
 * evidence-backed must never have to guess whether a missing thumbnail means
 * "never attached" or "deleted since".
 */
function ReceiptEvidence({
  receiptAssetId,
  receiptFileName,
  canBrowseMedia,
}: {
  receiptAssetId: string | null;
  receiptFileName: string | null;
  canBrowseMedia: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <section className="mt-4" aria-labelledby="expense-detail-receipt">
      <h3 id="expense-detail-receipt" className="text-sm font-semibold text-foreground">
        تصویر رسید
      </h3>
      {!receiptAssetId ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {receiptFileName
            ? `تصویر رسید (${receiptFileName}) بعداً از کتابخانهٔ رسانه حذف شده است؛ خودِ هزینه دست‌نخورده می‌ماند.`
            : "این هزینه بدون تصویر رسید ثبت شده است."}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-500/10"
          >
            {open ? "بستن تصویر" : "نمایش تصویر رسید"}
          </button>
          <a
            href={`/api/media/${receiptAssetId}/file`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg px-2 py-1 text-xs font-semibold text-primary underline-offset-2 hover:underline"
          >
            باز کردن فایل در تب جدید
          </a>
          {/*
            Only for the members for whom it is a door: «کتابخانهٔ رسانه» is
            `media.view`, and the file itself is readable here because
            `/api/media/[id]/file` lets a record's own photo render for whoever
            may read the record.
          */}
          {canBrowseMedia ? (
            <Link
              href="/media"
              className="rounded-lg px-2 py-1 text-xs font-semibold text-primary underline-offset-2 hover:underline"
            >
              کتابخانهٔ رسانه
            </Link>
          ) : null}
          <span className="text-xs text-muted-foreground">مستند در کتابخانهٔ رسانهٔ کسب‌وکار</span>
          {open ? (
            <div className="w-full overflow-hidden rounded-xl border border-border/80 bg-muted/60 p-2">
              {failed ? (
                <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                  نمایش تصویر ناموفق بود؛ ممکن است فایل از کتابخانهٔ رسانه حذف شده باشد.
                </p>
              ) : (
                // A plain <img>: /api/media/[id]/file streams the stored bytes
                // and is not a next/image loader target.
                <img
                  src={`/api/media/${receiptAssetId}/file`}
                  alt="تصویر رسید هزینه"
                  className="mx-auto max-h-[60vh] w-auto rounded-lg object-contain"
                  onError={() => setFailed(true)}
                />
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
