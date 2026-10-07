"use client";

import {
  EmptyState,
  SectionCardSkeleton,
  cardClass,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { ArrowDownLeftIcon, ArrowUpRightIcon, DownloadIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { FilterChip } from "@/app/dashboard/filters";
import { fmtJalali, OverlayDialog } from "./ledger-ui";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { MAX_BANK_REFERENCE_LENGTH, voucherAccountChoices, type VoucherAccountChoice } from "@/lib/payables-input";

/**
 * «دریافت و پرداخت» — the voucher ledger slice. The reference software keeps
 * four lists (receive/pay/income/expense); here receive and pay are the two
 * subledger voucher streams the accounting engine already posts (ar_receipts
 * / ap_payments), so this section is a view over the very rows the receive
 * and pay actions write — one place to browse, search and export them, and to
 * register a new voucher with the platform's form language.
 */

interface Voucher {
  id: string;
  date: string;
  method: "cash" | "bank";
  amount: number;
  memo: string | null;
  partyName: string;
  /** Audit F11 — the bank's tracking number, when one was recorded. */
  bankReference: string | null;
  /** Audit F11 — the cash/bank account named on the voucher; null = the method's default account. */
  cashAccount: { code: string; name: string } | null;
}

/** «بانکی · بانک ملت» — the method, plus the account when the voucher named one. */
function methodText(r: Voucher): string {
  return r.cashAccount ? `${METHOD_LABELS[r.method]} · ${r.cashAccount.name}` : METHOD_LABELS[r.method];
}

type Side = "receipts" | "payments";

const METHOD_LABELS: Record<Voucher["method"], string> = {
  cash: "نقدی",
  bank: "بانکی",
};

/**
 * How many vouchers the list draws. Both breakpoints used to slice differently
 * (100 on desktop, 50 on mobile) under a heading that counted *all* of them, so
 * «۳۲۰ سند» sat above a list of fifty with nothing said about the rest.
 */
const VISIBLE_ROWS = 100;

export function ReceiptsPaymentsSection() {
  const money = useMoney();
  const [side, setSide] = useState<Side>("receipts");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Voucher[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  /*
   * Responses race each other — a fast «علی» search easily outruns the slow
   * unfiltered listing it was typed over, and without the token the *older*
   * answer wins the setState and the screen shows rows that match nothing the
   * user asked for. Only the latest request may write state.
   */
  const requestSeq = useRef(0);
  const prevSide = useRef<Side>(side);

  useEffect(() => {
    // Switching دریافتی/پرداختی swaps the whole dataset; what is on screen
    // belongs to the other stream, so only that transition blanks the list —
    // searches and refreshes keep their rows and just flag «در حال به‌روزرسانی».
    if (prevSide.current !== side) {
      prevSide.current = side;
      setRows(null);
    }
    const seq = ++requestSeq.current;
    const run = () => {
      setLoading(true);
      const params = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
      const url = side === "receipts" ? `/api/ledger/ar/receipts${params}` : `/api/ledger/ap/payments${params}`;
      api<{ receipts?: Voucher[]; payments?: Voucher[]; error?: string }>(url)
        .then(({ ok, data }) => {
          if (requestSeq.current !== seq) return;
          if (ok) {
            setRows(data.receipts ?? data.payments ?? []);
            setError("");
          } else {
            // A network failure resolves here too — `api()` answers the
            // synthetic «network_error» code rather than rejecting.
            setError(errorMessage(data.error));
          }
        })
        .finally(() => {
          if (requestSeq.current === seq) setLoading(false);
        });
    };
    const t = setTimeout(run, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [side, q, refreshKey]);

  /*
   * The export obeys the same Shamsi rule the screen does: a CSV is read by a
   * person, so its date column is Jalali rather than the stored ISO/Gregorian
   * string this used to write out. The amount column names the unit actually in
   * use instead of asserting Rial while the screen shows Toman — as an ASCII
   * number, because a spreadsheet has to be able to add the column up.
   */
  function downloadCsv() {
    if (!rows || rows.length === 0) return;
    const head = ["تاریخ", "شخص", "شرح", "روش", "شماره پیگیری", `مبلغ (${money.unitLabel})`];
    const body = rows.map((r) => [
      fmtJalali(r.date),
      r.partyName,
      r.memo ?? "",
      methodText(r),
      r.bankReference ?? "",
      String(money.toInput(r.amount)),
    ]);
    const csv = [head, ...body].map((line) => line.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = side === "receipts" ? "receipts.csv" : "payments.csv";
    // Firefox only honors the download of an anchor that is in the document,
    // and revoking the blob URL in the same tick can cancel the navigation the
    // click just queued — so attach, click, detach, and revoke on a delay.
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const needle = q.trim();
  const emptyMessage = needle
    ? `برای «${needle}» سندی یافت نشد.`
    : side === "receipts"
      ? "هنوز سندی برای دریافت ثبت نشده است."
      : "هنوز سندی برای پرداخت ثبت نشده است.";

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className={`${cardClass} p-4 sm:p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دریافت و پرداخت</p>
            <h2 className="mt-1 font-semibold text-foreground dark:text-stone-50">
              {side === "receipts" ? "دریافت‌ها" : "پرداخت‌ها"}
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {side === "receipts" ? "اسناد دریافت وجه از مشتریان، به ترتیب تاریخ ثبت." : "اسناد پرداخت وجه به تأمین‌کنندگان، به ترتیب تاریخ ثبت."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              aria-busy={loading}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted"
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              {/* The design system reports progress with a busy label, not a spinner. */}
              {loading ? "در حال به‌روزرسانی…" : "به‌روزرسانی"}
            </button>
            <button
              type="button"
              onClick={downloadCsv}
              disabled={!rows || rows.length === 0}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            >
              <DownloadIcon aria-hidden="true" className="size-4" />
              دانلود
            </button>
            <Button onClick={() => setCreating(true)} className="min-h-10">
              <PlusIcon aria-hidden="true" className="size-4" />
              {side === "receipts" ? "ثبت دریافت" : "ثبت پرداخت"}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex gap-2" role="group" aria-label="نوع سند">
            <FilterChip dense selected={side === "receipts"} onClick={() => setSide("receipts")}>
              <span className="inline-flex items-center gap-1.5">
                <ArrowDownLeftIcon aria-hidden="true" className="size-3.5" />
                دریافتی
              </span>
            </FilterChip>
            <FilterChip dense selected={side === "payments"} onClick={() => setSide("payments")}>
              <span className="inline-flex items-center gap-1.5">
                <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
                پرداختی
              </span>
            </FilterChip>
          </div>
          <input
            type="search"
            className={`${inputClass} h-11 ms-auto w-40 sm:w-56`}
            placeholder="جست‌وجوی شخص، شرح یا شماره پیگیری…"
            aria-label="جست‌وجوی شخص، شرح یا شماره پیگیری"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="mt-4" aria-busy={loading && rows !== null}>
          {!rows ? (
            error ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-muted-foreground">بارگذاری اسناد ممکن نشد.</p>
                <button
                  type="button"
                  onClick={() => setRefreshKey((k) => k + 1)}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-4 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted"
                >
                  <RefreshCwIcon aria-hidden="true" className="size-4" />
                  تلاش مجدد
                </button>
              </div>
            ) : (
              <SectionCardSkeleton rows={4} />
            )
          ) : rows.length === 0 ? (
            <EmptyState>{emptyMessage}</EmptyState>
          ) : (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                {rows.length > VISIBLE_ROWS
                  ? `${toPersianDigits(VISIBLE_ROWS)} سند از ${toPersianDigits(rows.length)} سند — برای دیدن بقیه جست‌وجو کنید`
                  : `${toPersianDigits(rows.length)} سند`}
              </p>
              <DataTable caption="اسناد دریافت و پرداخت" className="hidden lg:block">
                <DataTableHead>
                  <Th>#</Th>
                  <Th>شخص</Th>
                  <Th>شرح</Th>
                  <Th>روش</Th>
                  <Th>شماره پیگیری</Th>
                  <Th>تاریخ</Th>
                  <Th>مبلغ</Th>
                </DataTableHead>
                <DataTableBody>
                  {rows.slice(0, VISIBLE_ROWS).map((r, index) => (
                    <DataTableRow key={r.id}>
                      <Td muted>{toPersianDigits(index + 1)}</Td>
                      <Td className="max-w-48 truncate font-medium" title={r.partyName}>{r.partyName}</Td>
                      <Td muted className="max-w-64 truncate" title={r.memo ?? undefined}>{r.memo ?? "—"}</Td>
                      <Td muted className="max-w-48 truncate" title={methodText(r)}>{methodText(r)}</Td>
                      <Td muted nowrap dir="ltr">{r.bankReference ? toPersianDigits(r.bankReference) : "—"}</Td>
                      <Td nowrap muted>{fmtJalali(r.date)}</Td>
                      <Td nowrap className="font-semibold">{money.format(r.amount)}</Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              <div className="space-y-3 lg:hidden">
                {rows.slice(0, VISIBLE_ROWS).map((r) => (
                  <article key={r.id} className="rounded-xl border border-border/80 bg-muted p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-bold" title={r.partyName}>{r.partyName}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">{r.memo ?? (side === "receipts" ? "دریافت وجه" : "پرداخت وجه")}</p>
                      </div>
                      <span className="whitespace-nowrap font-bold">{money.format(r.amount)}</span>
                    </div>
                    <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                      {fmtJalali(r.date)} · {methodText(r)}
                      {r.bankReference ? ` · پیگیری ${toPersianDigits(r.bankReference)}` : ""}
                    </p>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {creating ? (
        <VoucherForm
          side={side}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      ) : null}
    </section>
  );
}

interface PartyOption {
  id: string;
  name: string;
  phone: string | null;
}

function VoucherForm({ side, onClose, onCreated }: { side: Side; onClose: () => void; onCreated: () => void }) {
  const money = useMoney();
  const [parties, setParties] = useState<PartyOption[]>([]);
  const [partyState, setPartyState] = useState<"loading" | "error" | "ready">("loading");
  const [directoryKey, setDirectoryKey] = useState(0);
  const [partyId, setPartyId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "bank">("cash");
  /** Audit F11 — "" = the method's default account, as before. */
  const [cashAccountId, setCashAccountId] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [accountChoices, setAccountChoices] = useState<VoucherAccountChoice[]>([]);
  const [date, setDate] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /*
   * `?scope=directory`, not the open-balance list. A voucher is not always a
   * settlement of an existing debt — an advance from a customer, a deposit to a
   * supplier — and the balance list additionally carries the «بدون … مشخص»
   * bucket, whose id is the sentinel `"unknown"`; submitting that used to fail
   * with an unexplained server error rather than a message.
   */
  useEffect(() => {
    let cancelled = false;
    setPartyState("loading");
    const url =
      side === "receipts" ? "/api/ledger/ar/customers?scope=directory" : "/api/ledger/ap/suppliers?scope=directory";
    api<{
      customers?: { customerId: string; customerName: string; customerPhone: string | null }[];
      suppliers?: { supplierId: string; supplierName: string; supplierPhone: string | null }[];
    }>(url).then(({ ok, data }) => {
      if (cancelled) return;
      // `api()` resolves even when the network drops (as «network_error»), so
      // this one branch covers unreachable servers and 4xx/5xx alike.
      if (!ok) {
        setPartyState("error");
        return;
      }
      setParties(
        side === "receipts"
          ? (data.customers ?? []).map((c) => ({ id: c.customerId, name: c.customerName, phone: c.customerPhone }))
          : (data.suppliers ?? []).map((s) => ({ id: s.supplierId, name: s.supplierName, phone: s.supplierPhone })),
      );
      setPartyState("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [side, directoryKey]);

  /*
   * The cash and bank accounts of the chart, classified by the same rule the
   * cash-flow statement uses. A failed load leaves only «حساب پیش‌فرض», which
   * is exactly what the form did before it could name an account.
   */
  useEffect(() => {
    let cancelled = false;
    api<{ accounts?: { id: string; code: string; name: string; type: "asset" | "liability" | "equity" | "revenue" | "expense"; parent_code: string | null }[] }>(
      "/api/ledger/accounts",
    ).then(({ ok, data }) => {
      if (!cancelled && ok) setAccountChoices(voucherAccountChoices(data.accounts ?? []));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const methodAccounts = accountChoices.filter((a) => a.method === method);

  function chooseMethod(next: "cash" | "bank") {
    setMethod(next);
    // An account belongs to one method; a reference number only to a bank transfer.
    setCashAccountId("");
    if (next === "cash") setBankReference("");
  }

  async function submit() {
    if (!partyId) {
      setError("شخص را انتخاب کنید.");
      return;
    }
    let rial: number;
    try {
      rial = money.parse(amount);
    } catch {
      setError(errorMessage("invalid_amount"));
      return;
    }
    if (rial <= 0) {
      setError(errorMessage("invalid_amount"));
      return;
    }
    setBusy(true);
    setError("");
    const url = side === "receipts" ? "/api/ledger/ar/receipts" : "/api/ledger/ap/payments";
    const common = {
      amount: rial,
      method,
      memo: memo.trim() || undefined,
      cashAccountId: cashAccountId || undefined,
      bankReference: bankReference.trim() || undefined,
    };
    const body =
      side === "receipts"
        ? { ...common, customerId: partyId, receiptDate: date || undefined }
        : { ...common, supplierId: partyId, paymentDate: date || undefined };
    const { ok, data } = await api<{ error?: string }>(url, { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (ok) onCreated();
    else setError(errorMessage(data.error));
  }

  return (
    <OverlayDialog
      headingId="voucher-form-heading"
      onClose={onClose}
      className={`${overlayPanelClass} flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col`}
    >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ثبت تراکنش مالی</p>
            <h3 id="voucher-form-heading" className="mt-1 text-lg font-bold">
              {side === "receipts" ? "ثبت دریافت" : "ثبت پرداخت"}
            </h3>
          </div>
          <button type="button" onClick={onClose} aria-label="بستن" className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted">
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        </header>

        {/* A real <form> so Enter in the amount/memo fields submits the voucher,
            not just a click on the button. */}
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-4 sm:px-5">
            <ErrorBox>{error}</ErrorBox>
            <Field label={side === "receipts" ? "دریافت از شخص" : "پرداخت به شخص"}>
              <SearchableSelect
                value={partyId}
                onChange={setPartyId}
                ariaLabel="انتخاب شخص"
                loading={partyState === "loading"}
                disabled={partyState === "error"}
                options={[
                  { value: "", label: "انتخاب کنید…" },
                  ...parties.map((p) => ({
                    value: p.id,
                    // Two customers can share a name; the phone number is how
                    // the accountant tells them apart before money moves
                    // against the wrong person's account.
                    label: p.phone ? `${p.name} · ${toPersianDigits(p.phone)}` : p.name,
                    searchString: `${p.name} ${p.phone ?? ""}`,
                  })),
                ]}
              />
            </Field>
            {partyState === "error" ? (
              <div className="-mt-2 mb-4 flex items-center gap-2">
                <p className="text-xs text-destructive">لیست اشخاص بارگذاری نشد.</p>
                <button
                  type="button"
                  onClick={() => setDirectoryKey((k) => k + 1)}
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-500/10"
                >
                  تلاش مجدد
                </button>
              </div>
            ) : null}
            <Field label="مبلغ" hint={money.unitLabel}>
              <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="۰" />
            </Field>
            <div className="mb-4">
              <p className="mb-1 text-sm font-medium text-foreground">روش</p>
              <div className="flex gap-2">
                <FilterChip dense selected={method === "cash"} onClick={() => chooseMethod("cash")}>نقدی</FilterChip>
                <FilterChip dense selected={method === "bank"} onClick={() => chooseMethod("bank")}>بانکی</FilterChip>
              </div>
            </div>
            <Field
              label={side === "receipts" ? (method === "cash" ? "صندوق دریافت‌کننده" : "حساب بانکی دریافت‌کننده") : method === "cash" ? "صندوق پرداخت‌کننده" : "حساب بانکی پرداخت‌کننده"}
              hint="اختیاری"
            >
              <SearchableSelect
                value={cashAccountId}
                onChange={setCashAccountId}
                ariaLabel="انتخاب حساب صندوق یا بانک"
                options={[
                  { value: "", label: method === "cash" ? "صندوق پیش‌فرض" : "حساب پیش‌فرض بانکی" },
                  ...methodAccounts.map((a) => ({
                    value: a.id,
                    label: `${toPersianDigits(a.code)} ${a.name}`,
                    searchString: `${a.code} ${a.name}`,
                  })),
                ]}
              />
            </Field>
            {method === "bank" ? (
              <Field label="شماره پیگیری بانک (اختیاری)">
                <input
                  className={inputClass}
                  dir="ltr"
                  maxLength={MAX_BANK_REFERENCE_LENGTH}
                  value={bankReference}
                  onChange={(e) => setBankReference(e.target.value)}
                  aria-label="شماره پیگیری بانک"
                />
              </Field>
            ) : null}
            <Field label="تاریخ (اختیاری)">
              <JalaliDatePicker value={date} onChange={setDate} className={inputClass} ariaLabel="تاریخ" />
            </Field>
            <Field label="شرح (اختیاری)">
              <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} />
            </Field>
          </div>

          <footer className="grid shrink-0 grid-cols-2 gap-3 border-t border-border px-4 py-4 sm:px-5">
            <SecondaryButton onClick={onClose} disabled={busy}>انصراف</SecondaryButton>
            <PrimaryButton disabled={busy}>
              {busy ? "در حال ثبت…" : side === "receipts" ? "ثبت دریافت" : "ثبت پرداخت"}
            </PrimaryButton>
          </footer>
        </form>
    </OverlayDialog>
  );
}
