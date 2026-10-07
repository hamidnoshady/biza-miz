"use client";

import { LoadingSkeleton, StatusBadge, cardClass } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, todayIsoDate } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { expenseCategoryAccounts, expensePaymentSourceAccounts } from "@/lib/expense-accounts";
import { inclusiveExpenseVatAmount } from "@/lib/expense-input";
import {
  EXPENSE_STATUS_FILTERS,
  EXPENSE_STATUS_LABELS,
  type ExpenseDetailResponse,
  type ExpenseListResponse,
  type ExpenseRow,
  type ExpenseStatus,
} from "./expense-shared";
import { ExpenseDetailPanel } from "./expense-detail-panel";
import type { AccountRow, Runner } from "./accounting-manager";

interface LocationOption {
  id: string;
  name: string;
}

/**
 * Categorised operating expenses, recorded as paid — the expense account chosen
 * (rent, utilities, marketing, …) is the category, so no separate taxonomy
 * exists. Posts immediately (Debit the expense account / Credit the payment
 * account, plus the input-VAT account when the expense carries VAT), same as an
 * order or a purchase would, rather than going through the manual-journal
 * draft/review/post workflow — this is a routine, already-categorised entry, not
 * a freeform one.
 *
 * What this screen used to get wrong, all fixed here or in `expense-service.ts`:
 *
 *  - A malformed amount («۱۲٫۵»، an empty string after the digits were stripped)
 *    made `submit` `return` in silence: the button looked enabled, the click did
 *    nothing, and nothing said why. Every refusal is named now and rendered next
 *    to the field that caused it.
 *  - Picking the same account as both the category and the payment source was
 *    only caught by the server (`same_account`), after a round trip. So was a
 *    date in a locked period, which is unavoidable — but the same-account case is
 *    knowable in the browser and is blocked there.
 *  - «جمع هزینه‌های این فهرست» summed the rows the browser happened to hold,
 *    while the API silently cut the list at 200. The total and the count come
 *    from the server over the whole matching set now, and truncation is stated.
 *  - There was no way to find an expense: no date range, no category filter, no
 *    search. A list of spend with no filters is a list nobody can audit.
 *  - Nothing confirmed a successful posting; the form just emptied itself.
 *  - The mobile card list rendered *below* the total, so on a phone the summary
 *    row sat between the (hidden) table and the cards. Order is list → total on
 *    every breakpoint now.
 *  - `SearchableSelect` renders a `<button>`; wrapping it in a bare `<label>`
 *    gave it no accessible name. Each one is labelled explicitly.
 *  - The list request had no cancellation, so a slow first response could land
 *    after a faster filtered one and overwrite it.
 *
 * Issue #832 then made this a register rather than a form with a list under it:
 *
 *  - **Read-only honesty** (§3). The page opens with `ledger.view`, so a viewer
 *    or an auditor used to be handed «ثبت هزینه», the receipt upload and every
 *    write control, and then a 403 for touching them. `canManageExpenses` now
 *    decides what is drawn, from the member's effective permissions — and the
 *    API keeps enforcing them, because hiding a button is a courtesy, not a gate.
 *  - **Payment sources** (§2). The picker used every `type === "asset"` account,
 *    so rent could be paid out of inventory or a customer's receivable. Both the
 *    picker and the server now use `expense-accounts.ts`.
 *  - **Reversal** (§1). A wrong expense is corrected with a dated, mirrored
 *    «سند برگشت» — never an edit and never a delete — so the register and the
 *    General Ledger stay equal, and both sides of the correction stay visible.
 *  - **The whole record** (§6–§10, §21). Branch, payment-account and status
 *    filters, keyset paging with «نمایش بیشتر», the reference number, the receipt
 *    reopened from the row, and a detail panel with the journal entry's lines —
 *    in the mobile cards too, because a phone-only audit trail is no audit
 *    trail.
 */
export function ExpenseSection({
  accounts,
  busy,
  run,
  refreshKey,
  canManageExpenses,
  canBrowseMedia,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: Runner;
  refreshKey: number;
  /** False → no mutation controls at all. Undefined = permissions unreadable → draw them and let the API decide. */
  canManageExpenses?: boolean;
  /** Whether «باز کردن در کتابخانهٔ رسانه» is a door rather than a redirect. */
  canBrowseMedia?: boolean;
}) {
  const money = useMoney();
  const canManage = canManageExpenses !== false;
  const mayBrowseMedia = canBrowseMedia !== false;

  // One adapter from the picker's row shape to the rule's, so the browser's two
  // lists and the server's two checks are literally the same function.
  const shaped = useMemo(
    () => accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, parentId: a.parent_id ?? null })),
    [accounts],
  );
  const expenseAccounts = useMemo(() => expenseCategoryAccounts(shaped), [shaped]);
  const paymentAccounts = useMemo(() => expensePaymentSourceAccounts(shaped), [shaped]);

  const [accountId, setAccountId] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState("");
  const [vendor, setVendor] = useState("");
  const [memo, setMemo] = useState("");
  const [locationId, setLocationId] = useState("");
  const [partyId, setPartyId] = useState("");
  const [vatOn, setVatOn] = useState(false);
  const [vatAmount, setVatAmount] = useState("");
  const [vatRate, setVatRate] = useState<number | null>(null);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  // Receipt-photo OCR (migration 0177) — Accounting's own direct upload path,
  // distinct from the AI Chat assistant's `draft_expense_from_receipt` tool:
  // no chat turn needed, and the photo becomes a real Media Library asset
  // (`receiptAssetId`) attached to the expense once it's recorded.
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState("");
  const [receiptAsset, setReceiptAsset] = useState<{ id: string; fileName: string } | null>(null);
  const receiptInputRef = useRef<HTMLInputElement>(null);

  const [expenses, setExpenses] = useState<ExpenseRow[] | null>(null);
  const [listTotal, setListTotal] = useState(0);
  const [listVatTotal, setListVatTotal] = useState(0);
  const [listPaidTotal, setListPaidTotal] = useState(0);
  const [listCount, setListCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");

  // Filters — the same vocabulary «دفتر روزنامه» uses, so the two books are
  // searched the same way.
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterAccountId, setFilterAccountId] = useState("");
  const [filterPaymentAccountId, setFilterPaymentAccountId] = useState("");
  const [filterLocationId, setFilterLocationId] = useState("");
  const [filterStatus, setFilterStatus] = useState<"" | ExpenseStatus>("");
  const [q, setQ] = useState("");

  // The detail panel reads its own record from the single-expense endpoint (the
  // row plus the journal lines it posted), so opening it is one request and the
  // panel never shows a stale or partial version of what the list already had.
  const [detail, setDetail] = useState<ExpenseDetailResponse | null>(null);
  const detailRequestId = useRef(0);
  async function openDetail(id: string) {
    const id_ = ++detailRequestId.current;
    const { ok, data } = await api<ExpenseDetailResponse>(`/api/ledger/expenses/${id}`);
    if (id_ !== detailRequestId.current) return;
    if (ok) setDetail(data);
    else setLoadError("بارگذاری جزئیات هزینه ناموفق بود.");
  }

  const today = todayIsoDate();

  /*
   * Branches, from the shell's own endpoint rather than a new one. The filter and
   * the form's picker are both offered only when the business has more than one
   * location — a single-branch till does not need a column of identical values —
   * and `locations` is already narrowed to the branches this member may reach.
   */
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [multiBranch, setMultiBranch] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api<{ locations?: LocationOption[]; active?: { id: string } | null; businessLocationCount?: number }>(
      "/api/locations/active",
    ).then(({ ok, data }) => {
      if (cancelled || !ok) return;
      setLocations(data.locations ?? []);
      setMultiBranch((data.businessLocationCount ?? 0) > 1);
      if (canManage && !locationId) setLocationId(data.active?.id ?? "");
    });
    return () => {
      cancelled = true;
    };
    // The default branch is read once; `locationId` afterwards belongs to the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  const loadUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (filterFrom) params.set("dateFrom", filterFrom);
    if (filterTo) params.set("dateTo", filterTo);
    if (filterAccountId) params.set("accountId", filterAccountId);
    if (filterPaymentAccountId) params.set("paymentAccountId", filterPaymentAccountId);
    if (filterLocationId) params.set("locationId", filterLocationId);
    if (filterStatus) params.set("status", filterStatus);
    if (q.trim()) params.set("q", q.trim());
    return `/api/ledger/expenses?${params}`;
  }, [filterFrom, filterTo, filterAccountId, filterPaymentAccountId, filterLocationId, filterStatus, q]);

  // A request counter, not just an `ignore` flag: with debounced typing several
  // requests can be in flight, and only the newest one may write state.
  const requestId = useRef(0);
  const load = useCallback(
    (url: string, mode: "replace" | "append" = "replace") => {
      const id = ++requestId.current;
      setLoadError("");
      if (mode === "append") setLoadingMore(true);
      api<ExpenseListResponse>(url).then(({ ok, data }) => {
        if (mode === "append") setLoadingMore(false);
        if (id !== requestId.current) return;
        if (ok) {
          const rows = data.expenses ?? [];
          setExpenses((previous) => (mode === "append" && previous ? [...previous, ...rows] : rows));
          setHasMore(!!data.hasMore);
          setNextCursor(data.nextCursor ?? null);
          // Fall back to the page sum only if an older server is answering.
          setListTotal(
            typeof data.totalAmount === "number"
              ? data.totalAmount
              : rows.reduce((sum, e) => sum + (e.reversesExpenseId ? -e.netAmount : e.netAmount), 0),
          );
          // All three footer numbers come from the server over the whole filtered
          // set — the window the browser holds is not the set they describe. The
          // page-sum fallbacks only exist for an older server that answers without
          // them.
          setListVatTotal(
            typeof data.totalVatAmount === "number"
              ? data.totalVatAmount
              : rows.reduce((sum, e) => sum + (e.reversesExpenseId ? -e.vatAmount : e.vatAmount), 0),
          );
          setListPaidTotal(
            typeof data.totalPaidAmount === "number"
              ? data.totalPaidAmount
              : rows.reduce((sum, e) => sum + (e.reversesExpenseId ? -e.amount : e.amount), 0),
          );
          setListCount(typeof data.totalCount === "number" ? data.totalCount : rows.length);
        } else {
          // An endless skeleton reads as "still loading"; name the failure.
          if (mode === "append") {
            setLoadError("بارگذاری ادامهٔ فهرست ناموفق بود.");
            return;
          }
          setExpenses([]);
          setHasMore(false);
          setNextCursor(null);
          setListTotal(0);
          setListVatTotal(0);
          setListPaidTotal(0);
          setListCount(0);
          setLoadError("بارگذاری فهرست هزینه‌ها ناموفق بود.");
        }
      });
    },
    // Only setters and `api` are used inside, all stable — the URL arrives as an
    // argument so a filter change never re-creates this callback.
    [],
  );

  useEffect(() => {
    setExpenses(null);
    // Debounce only the free-text box; a date or category pick is deliberate.
    const timer = setTimeout(() => load(loadUrl), q.trim() ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, loadUrl, q, refreshKey]);

  const filtered = !!(
    filterFrom ||
    filterTo ||
    filterAccountId ||
    filterPaymentAccountId ||
    filterLocationId ||
    filterStatus ||
    q.trim()
  );
  function clearFilters() {
    setFilterFrom("");
    setFilterTo("");
    setFilterAccountId("");
    setFilterPaymentAccountId("");
    setFilterLocationId("");
    setFilterStatus("");
    setQ("");
  }

  /**
   * The VAT-extraction reply and the manual override both land here; the number a
   * person can see and change is the only one that is ever posted.
   */
  async function handleReceiptFile(file: File) {
    setReceiptError("");
    setReceiptBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("read_failed"));
        reader.readAsDataURL(file);
      });

      const { ok, data } = await api<{
        message?: string;
        fields?: {
          vendor: string | null;
          expenseDate: string | null;
          amount: number | null;
          vatAmount?: number | null;
          memo: string;
          suggestedAccountCode: string | null;
        };
        asset?: { id: string; fileName: string };
      }>("/api/ai/receipt-ocr", {
        method: "POST",
        body: JSON.stringify({ image: dataUrl, fileName: file.name }),
      });

      if (!ok || !data.fields) {
        setReceiptError(data.message ?? "استخراج اطلاعات از روی تصویر رسید ممکن نشد؛ مقادیر را دستی وارد کنید.");
        return;
      }

      setReceiptAsset(data.asset ?? null);
      const f = data.fields;
      if (f.vendor && !vendor.trim()) setVendor(f.vendor);
      if (f.memo && !memo.trim()) setMemo(f.memo);
      if (f.expenseDate && !expenseDate) setExpenseDate(f.expenseDate);
      if (f.amount && !amount.trim()) setAmount(String(money.toInput(f.amount)));
      if (f.vatAmount && f.vatAmount > 0) {
        setVatOn(true);
        if (!vatAmount.trim()) setVatAmount(String(money.toInput(f.vatAmount)));
      }
      if (f.suggestedAccountCode && !accountId) {
        // The OCR only ever *suggests*; a code that is not one of this business's
        // own expense accounts is dropped rather than guessed at (issue #832 §13).
        const match = expenseAccounts.find((a) => a.code === f.suggestedAccountCode);
        if (match) setAccountId(match.id);
      }
      setNotice("اطلاعات از روی تصویر رسید استخراج شد؛ پیش از ثبت آن‌ها را بررسی کنید.");
    } catch {
      setReceiptError("خواندن فایل تصویر ناموفق بود.");
    } finally {
      setReceiptBusy(false);
      if (receiptInputRef.current) receiptInputRef.current.value = "";
    }
  }

  /**
   * Everything that can be known before the round trip, in the order a person
   * fills the form in — so the message points at the first thing to fix rather
   * than at whatever the server happened to check first. The server re-checks all
   * of it (`expense-service.ts`), because this function is a convenience and the
   * service is the rule.
   */
  function validate(): string {
    if (!accountId) return "دسته هزینه را انتخاب کنید.";
    if (!paymentAccountId) return "حساب پرداخت را انتخاب کنید.";
    if (accountId === paymentAccountId) return "دسته هزینه و حساب پرداخت نمی‌توانند یکسان باشند.";
    if (!amount.trim()) return "مبلغ هزینه را وارد کنید.";
    let rial: number;
    try {
      rial = money.parse(amount);
    } catch {
      return "مبلغ واردشده عدد معتبری نیست.";
    }
    if (!Number.isFinite(rial) || rial <= 0) return "مبلغ هزینه باید بزرگ‌تر از صفر باشد.";
    if (!Number.isSafeInteger(rial)) return "مبلغ واردشده بیش از حد بزرگ است.";
    if (vatOn) {
      if (!vatAmount.trim()) return "مبلغ مالیات بر ارزش افزوده را وارد کنید.";
      let vat: number;
      try {
        vat = money.parse(vatAmount);
      } catch {
        return "مبلغ مالیات واردشده عدد معتبری نیست.";
      }
      if (!Number.isSafeInteger(vat) || vat <= 0) return "مالیات باید عدد صحیح و بزرگ‌تر از صفر باشد.";
      if (vat >= rial) return "مالیات نمی‌تواند برابر یا بیشتر از مبلغ کل باشد.";
    }
    if (expenseDate && expenseDate > today) return "تاریخ هزینه نمی‌تواند در آینده باشد.";
    if (!memo.trim()) return "شرح هزینه الزامی است.";
    return "";
  }

  /**
   * The live hint under the button. It is *advice*, not a gate: the submit stays
   * clickable while the form is incomplete so a press explains the missing field
   * instead of doing nothing (issue #832 §20 — the old comment claimed that
   * behaviour while `disabled={!canSubmit}` did the opposite). `busy` is the only
   * thing that disables it, because a second concurrent posting is the one failure
   * a person cannot fix by typing.
   */
  const validationError = validate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNotice("");
    const problem = validate();
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError("");
    const rial = money.parse(amount);

    const ok = await run(() =>
      api("/api/ledger/expenses", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          paymentAccountId,
          amount: rial,
          expenseDate: expenseDate || undefined,
          vendor: vendor.trim() || undefined,
          partyId: partyId || undefined,
          locationId: locationId || undefined,
          memo: memo.trim(),
          vatAmount: vatOn ? money.parse(vatAmount) : 0,
          receiptAssetId: receiptAsset?.id,
        }),
      }),
    );
    if (ok) {
      setNotice(`هزینه به مبلغ ${money.format(rial)} ثبت و در دفاتر منعکس شد.`);
      setAccountId("");
      setPaymentAccountId("");
      setAmount("");
      setExpenseDate("");
      setVendor("");
      setPartyId("");
      setVatOn(false);
      setVatAmount("");
      setReceiptAsset(null);
      setReceiptError("");
      setMemo("");
    }
  }

  const expenseOptions = useMemo(
    () => [
      { value: "", label: "انتخاب دسته هزینه" },
      ...expenseAccounts.map((a) => ({
        value: a.id,
        label: `${a.code} — ${a.name}`,
        searchString: `${a.code} ${a.name}`,
      })),
    ],
    [expenseAccounts],
  );
  const paymentOptions = useMemo(
    () => [
      { value: "", label: "انتخاب حساب پرداخت" },
      ...paymentAccounts.map((a) => ({
        value: a.id,
        label: `${a.code} — ${a.name}`,
        searchString: `${a.code} ${a.name}`,
      })),
    ],
    [paymentAccounts],
  );

  // A business whose chart has no expense (or no *cash/bank*) account cannot
  // record anything here; say so and point at the chart rather than showing a
  // form whose first field is permanently empty. The payment-account rule is why
  // this used to be "any asset account" and is now deliberately narrower.
  const chartIncomplete = expenseAccounts.length === 0 || paymentAccounts.length === 0;

  // The VAT rate is the platform's own tax setting, read once and only when the
  // operator asked for VAT — there is no second tax configuration here.
  useEffect(() => {
    if (!vatOn || vatRate !== null) return;
    let cancelled = false;
    void api<{ settings?: { vatRate?: number | null } }>("/api/ledger/settings").then(({ ok, data }) => {
      if (!cancelled && ok) setVatRate(typeof data.settings?.vatRate === "number" ? data.settings.vatRate : 0);
    });
    return () => {
      cancelled = true;
    };
  }, [vatOn, vatRate]);

  return (
    <div className="min-w-0 space-y-4">
      {canManage ? (
        <section aria-labelledby="expense-form-heading" className={cardClass}>
          <header className="border-b border-border/80 px-4 py-4 sm:px-5">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملیات هزینه</p>
            <h2 id="expense-form-heading" className="mt-1 text-base font-semibold text-foreground">
              ثبت هزینه
            </h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              هزینه به‌عنوان پرداخت‌شده ثبت می‌شود و بلافاصله در دفاتر منعکس خواهد شد: بدهکار «دسته هزینه»
              {vatOn ? " و «مالیات قابل استرداد»، " : " و "} بستانکار «حساب پرداخت» به‌مبلغ کل.
            </p>
          </header>

          <div className="p-4 sm:p-5">
            {chartIncomplete ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                برای ثبت هزینه دست‌کم یک حساب از نوع «هزینه» و یک حساب نقدی/بانکی فعال (صندوق، بانک، تنخواه یا
                تسویهٔ کارت‌خوان) لازم است؛ در «سرفصل حساب‌ها» بررسی کنید.
              </p>
            ) : (
              <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div className="block">
                  <span id="expense-category-label" className="mb-1.5 block text-sm font-medium text-foreground">
                    دسته هزینه
                  </span>
                  <SearchableSelect
                    value={accountId}
                    onChange={(value) => {
                      setAccountId(value);
                      setFormError("");
                    }}
                    ariaLabel="دسته هزینه"
                    options={expenseOptions}
                  />
                </div>

                <div className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">پرداخت از</span>
                  <SearchableSelect
                    value={paymentAccountId}
                    onChange={(value) => {
                      setPaymentAccountId(value);
                      setFormError("");
                    }}
                    ariaLabel="حساب پرداخت"
                    options={paymentOptions}
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">
                    فقط صندوق، بانک، تنخواه و حساب تسویهٔ کارت‌خوان؛ حساب‌هایی مثل موجودی کالا یا حساب‌های
                    دریافتنی در این فهرست نیستند.
                  </span>
                </div>

                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">
                    مبلغ ({money.unitLabel})
                  </span>
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode="numeric"
                    allowNegative={false}
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setFormError("");
                    }}
                    placeholder="۰"
                    aria-describedby="expense-amount-hint"
                  />
                  <span id="expense-amount-hint" className="mt-1 block text-xs text-muted-foreground">
                    {vatOn
                      ? "مبلغ کل (شامل مالیات) را وارد کنید؛ خالص از آن کم می‌شود."
                      : `مبلغ را به ${money.unitLabel} وارد کنید.`}
                  </span>
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">تاریخ هزینه</span>
                  <JalaliDatePicker
                    value={expenseDate}
                    onChange={(value) => {
                      setExpenseDate(value);
                      setFormError("");
                    }}
                    placeholder="امروز"
                  />
                </label>

                {multiBranch ? (
                  <div className="block">
                    <span className="mb-1.5 block text-sm font-medium text-foreground">شعبه</span>
                    <SearchableSelect
                      value={locationId}
                      onChange={setLocationId}
                      ariaLabel="شعبهٔ ثبت هزینه"
                      options={[
                        { value: "", label: "بدون شعبه (ستادی)" },
                        ...locations.map((l) => ({ value: l.id, label: l.name, searchString: l.name })),
                      ]}
                    />
                  </div>
                ) : null}

                <PartyField
                  value={partyId}
                  onChange={(next) => {
                    setPartyId(next);
                    setFormError("");
                  }}
                />

                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">
                    طرف حساب <span className="font-normal text-muted-foreground">(اختیاری)</span>
                  </span>
                  <input
                    className={inputClass}
                    value={vendor}
                    onChange={(e) => setVendor(e.target.value)}
                    placeholder="نام طرف حساب"
                    maxLength={120}
                  />
                </label>

                <div className="block md:col-span-2 xl:col-span-3">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">
                    عکس رسید <span className="font-normal text-muted-foreground">(اختیاری — استخراج خودکار)</span>
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={receiptInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="block w-full max-w-md text-sm text-muted-foreground file:me-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:font-semibold file:text-foreground"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleReceiptFile(file);
                      }}
                      disabled={receiptBusy}
                    />
                    {receiptBusy ? <span className="text-xs text-muted-foreground">در حال استخراج…</span> : null}
                    {receiptAsset ? (
                      <span className="inline-flex items-center gap-2 rounded-xl border border-border/80 bg-muted/60 px-3 py-1.5 text-xs">
                        <StatusBadge tone="positive">رسید پیوند شد</StatusBadge>
                        <span className="break-all text-muted-foreground">{receiptAsset.fileName}</span>
                        <button
                          type="button"
                          onClick={() => setReceiptAsset(null)}
                          className="font-semibold text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
                        >
                          حذف پیوند
                        </button>
                      </span>
                    ) : null}
                  </div>
                  {receiptError ? (
                    <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{receiptError}</p>
                  ) : (
                    <span className="mt-1.5 block text-xs text-muted-foreground">
                      عکس رسید را انتخاب کنید تا مبلغ، طرف حساب و تاریخ به‌صورت خودکار پیشنهاد شود؛ عکس در کتابخانهٔ
                      رسانه ذخیره و به این هزینه پیوند داده می‌شود.
                    </span>
                  )}
                </div>

                <VatField
                  enabled={vatOn}
                  rate={vatRate}
                  grossText={amount}
                  vatText={vatAmount}
                  money={money}
                  onToggle={(next) => {
                    setVatOn(next);
                    setFormError("");
                    if (!next) setVatAmount("");
                  }}
                  onChangeVat={(next) => {
                    setVatAmount(next);
                    setFormError("");
                  }}
                />

                <label className="block md:col-span-2 xl:col-span-3">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">شرح هزینه</span>
                  <input
                    className={inputClass}
                    value={memo}
                    onChange={(e) => {
                      setMemo(e.target.value);
                      setFormError("");
                    }}
                    placeholder="شرح و دلیل ثبت هزینه"
                    maxLength={300}
                  />
                </label>

                <div className="md:col-span-2 xl:col-span-3">
                  {formError ? <ErrorBox>{formError}</ErrorBox> : null}
                  {notice ? (
                    <p
                      role="status"
                      className="mb-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
                    >
                      {notice}
                    </p>
                  ) : null}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="w-full sm:max-w-xs">
                      {/*
                        Only a live request disables it. A control that is silently
                        disabled while the form is incomplete is the worst of both
                        worlds — it looks dead and says nothing — so the click is
                        allowed and names the first thing to fix, in the row below.
                      */}
                      <PrimaryButton disabled={busy}>{busy ? "در حال ثبت…" : "ثبت هزینه"}</PrimaryButton>
                    </div>
                    {validationError && !busy ? (
                      <span role="status" className="text-xs text-muted-foreground">
                        {validationError}
                      </span>
                    ) : null}
                  </div>
                </div>
              </form>
            )}
          </div>
        </section>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          شما فقط می‌توانید فهرست هزینه‌ها را بخوانید؛ برای ثبت یا برگشت هزینه به مسئول «مدیریت هزینه‌ها»
          (مجوز «finance.expenses_manage») مراجعه کنید. فیلترها، جمع‌ها، رسیدها و سند حسابداری همین‌جا قابل بررسی
          هستند.
        </p>
      )}

      <section aria-labelledby="expense-list-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق عملیاتی</p>
          <h2 id="expense-list-heading" className="mt-1 text-base font-semibold text-foreground">
            هزینه‌های ثبت‌شده
          </h2>
        </header>

        <div className="border-b border-border/80 p-4 sm:p-5">
          <div className="grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 lg:items-end">
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">از تاریخ</span>
              <JalaliDatePicker value={filterFrom} onChange={setFilterFrom} placeholder="از ابتدا" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">تا تاریخ</span>
              <JalaliDatePicker value={filterTo} onChange={setFilterTo} placeholder="تا امروز" />
            </label>
            <div className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">دسته هزینه</span>
              <SearchableSelect
                value={filterAccountId}
                onChange={setFilterAccountId}
                ariaLabel="فیلتر دسته هزینه"
                options={[
                  { value: "", label: "همهٔ دسته‌ها" },
                  ...expenseAccounts.map((a) => ({
                    value: a.id,
                    label: `${a.code} — ${a.name}`,
                    searchString: `${a.code} ${a.name}`,
                  })),
                ]}
              />
            </div>
            <div className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">پرداخت از</span>
              <SearchableSelect
                value={filterPaymentAccountId}
                onChange={setFilterPaymentAccountId}
                ariaLabel="فیلتر حساب پرداخت"
                options={[
                  { value: "", label: "همهٔ حساب‌های پرداخت" },
                  ...paymentAccounts.map((a) => ({
                    value: a.id,
                    label: `${a.code} — ${a.name}`,
                    searchString: `${a.code} ${a.name}`,
                  })),
                ]}
              />
            </div>
            {multiBranch ? (
              <div className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">شعبه</span>
                <SearchableSelect
                  value={filterLocationId}
                  onChange={setFilterLocationId}
                  ariaLabel="فیلتر شعبه"
                  options={[
                    { value: "", label: "همهٔ شعب" },
                    ...locations.map((l) => ({ value: l.id, label: l.name, searchString: l.name })),
                  ]}
                />
              </div>
            ) : null}
            <div className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">وضعیت</span>
              <SearchableSelect
                value={filterStatus}
                onChange={(value) => setFilterStatus(value as "" | ExpenseStatus)}
                ariaLabel="فیلتر وضعیت دفتر هزینه"
                options={EXPENSE_STATUS_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
              />
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">جست‌وجو</span>
              <input
                className={inputClass}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="شرح، طرف حساب، شمارهٔ سند یا نام/کد حساب…"
              />
            </label>
          </div>
          {filtered ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <SecondaryButton onClick={clearFilters}>پاک کردن فیلترها</SecondaryButton>
              <span className="text-xs text-muted-foreground">
                {expenses ? `${toPersianDigits(listCount)} هزینه با این فیلترها` : ""}
              </span>
            </div>
          ) : null}
        </div>

        <div className="p-4 sm:p-5">
          <ErrorBox>{loadError}</ErrorBox>
          {!expenses ? (
            loadError ? null : (
              <LoadingSkeleton rows={3} label="در حال بارگذاری هزینه‌ها" />
            )
          ) : expenses.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              {filtered ? "هزینه‌ای با این فیلترها پیدا نشد." : "هنوز هزینه‌ای ثبت نشده است."}
            </p>
          ) : (
            <>
              <DataTable caption="فهرست هزینه‌های ثبت‌شده" className="hidden lg:block" tableClassName="min-w-[62rem]">
                <DataTableHead>
                  <Th>شماره</Th>
                  <Th>تاریخ</Th>
                  {multiBranch ? <Th>شعبه</Th> : null}
                  <Th>دسته</Th>
                  <Th>شرح</Th>
                  <Th>طرف حساب</Th>
                  <Th>پرداخت از</Th>
                  <Th>رسید</Th>
                  <Th>وضعیت</Th>
                  <Th numeric>مبلغ</Th>
                  <Th>عملیات</Th>
                </DataTableHead>
                <DataTableBody>
                  {expenses.map((e) => (
                    <DataTableRow key={e.id}>
                      <Td muted nowrap>
                        {e.reference ? toPersianDigits(e.reference) : "—"}
                      </Td>
                      <Td muted nowrap>
                        {toPersianDigits(formatJalali(e.expenseDate))}
                      </Td>
                      {multiBranch ? <Td muted>{e.locationName ?? "—"}</Td> : null}
                      <Td>
                        {toPersianDigits(e.accountCode)} {e.accountName}
                      </Td>
                      <Td className="max-w-[16rem] break-words">{e.memo}</Td>
                      <Td muted>{e.partyName ?? e.vendor ?? "—"}</Td>
                      <Td muted>
                        {toPersianDigits(e.paymentAccountCode)} {e.paymentAccountName}
                      </Td>
                      <Td muted nowrap>
                        {e.receiptAssetId ? (
                          <span className="text-emerald-700 dark:text-emerald-300">دارد</span>
                        ) : e.receiptFileName ? (
                          <span className="text-amber-700 dark:text-amber-300">حذف شده</span>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td nowrap>
                        <StatusBadge
                          tone={e.status === "active" ? "positive" : e.status === "reversed" ? "danger" : "active"}
                        >
                          {EXPENSE_STATUS_LABELS[e.status]}
                        </StatusBadge>
                      </Td>
                      <Td numeric nowrap className="font-semibold">
                        {money.format(e.netAmount)}
                        {e.vatAmount > 0 ? (
                          <span className="block text-xs font-normal text-muted-foreground">
                            + مالیات {money.format(e.vatAmount)}
                          </span>
                        ) : null}
                      </Td>
                      <Td nowrap>
                        <button
                          type="button"
                          onClick={() => void openDetail(e.id)}
                          className="rounded-lg px-2 py-1 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-500/10"
                        >
                          جزئیات
                        </button>
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              <div className="space-y-3 lg:hidden">
                {expenses.map((e) => (
                  <article key={e.id} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-words text-sm font-semibold text-foreground">
                          {toPersianDigits(e.accountCode)} {e.accountName}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {e.reference ? `${toPersianDigits(e.reference)} · ` : ""}
                          {toPersianDigits(formatJalali(e.expenseDate))}
                          {multiBranch && e.locationName ? ` · ${e.locationName}` : ""}
                        </p>
                      </div>
                      <span className="whitespace-nowrap font-bold tabular-nums text-foreground">
                        {money.format(e.netAmount)}
                      </span>
                    </div>
                    <p className="mt-3 break-words text-sm text-foreground">{e.memo}</p>
                    <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">طرف حساب</dt>
                        <dd className="mt-1 break-words text-sm text-foreground">{e.partyName ?? e.vendor ?? "—"}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">پرداخت از</dt>
                        <dd className="mt-1 break-words text-sm text-foreground">
                          {toPersianDigits(e.paymentAccountCode)} {e.paymentAccountName}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">وضعیت</dt>
                        <dd className="mt-1">
                          <StatusBadge
                            tone={e.status === "active" ? "positive" : e.status === "reversed" ? "danger" : "active"}
                          >
                            {EXPENSE_STATUS_LABELS[e.status]}
                          </StatusBadge>
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">رسید</dt>
                        <dd className="mt-1 text-sm text-foreground">
                          {e.receiptAssetId ? (
                            <span className="text-emerald-700 dark:text-emerald-300">پیوست‌شده</span>
                          ) : e.receiptFileName ? (
                            <span className="text-amber-700 dark:text-amber-300">حذف شده</span>
                          ) : (
                            "بدون رسید"
                          )}
                        </dd>
                      </div>
                      {e.vatAmount > 0 ? (
                        <div className="min-w-0">
                          <dt className="text-muted-foreground">مالیات قابل استرداد</dt>
                          <dd className="mt-1 text-sm tabular-nums text-foreground">{money.format(e.vatAmount)}</dd>
                        </div>
                      ) : null}
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">ثبت‌کننده</dt>
                        <dd className="mt-1 break-words text-sm text-foreground">{e.createdByName ?? "—"}</dd>
                      </div>
                    </dl>
                    <div className="mt-3 border-t border-border pt-3">
                      <SecondaryButton onClick={() => void openDetail(e.id)}>جزئیات و سند حسابداری</SecondaryButton>
                    </div>
                  </article>
                ))}
              </div>

              <div className="mt-3 space-y-1 rounded-xl border border-border/80 bg-muted/60 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    {filtered ? "جمع هزینه‌های این فیلتر (خالص)" : "جمع کل هزینه‌های ثبت‌شده (خالص)"}
                    {" · "}
                    {toPersianDigits(listCount)} فقره
                  </span>
                  <span className="font-bold tabular-nums text-foreground">{money.format(listTotal)}</span>
                </div>
                {listVatTotal !== 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>مالیات بر ارزش افزودهٔ این فهرست</span>
                    <span className="tabular-nums">{money.format(listVatTotal)}</span>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>پرداختی از حساب‌ها (شامل مالیات)</span>
                  <span className="tabular-nums">{money.format(listPaidTotal)}</span>
                </div>
              </div>

              {hasMore && nextCursor ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <SecondaryButton
                    disabled={loadingMore}
                    onClick={() =>
                      load(
                        `${loadUrl}${loadUrl.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(nextCursor)}`,
                        "append",
                      )
                    }
                  >
                    {loadingMore ? "در حال بارگذاری…" : `نمایش بیشتر (${toPersianDigits(listCount - expenses.length)} مورد دیگر)`}
                  </SecondaryButton>
                  <span className="text-xs text-muted-foreground">
                    جمع بالا همیشه شامل همهٔ {toPersianDigits(listCount)} فقره است.
                  </span>
                </div>
              ) : hasMore ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  فقط {toPersianDigits(expenses.length)} هزینهٔ اخیر نمایش داده شده است؛ جمع بالا شامل همهٔ{" "}
                  {toPersianDigits(listCount)} فقره است.
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>

      {detail ? (
        <ExpenseDetailPanel
          detail={detail.expense}
          journalLines={detail.journalLines}
          canManage={canManage}
          canBrowseMedia={mayBrowseMedia}
          busy={busy}
          run={run}
          onClose={() => setDetail(null)}
          onOpenExpense={(id) => void openDetail(id)}
        />
      ) : null}
    </div>
  );

}

/**
 * The optional link to the platform's one people directory (issue #832 §12).
 *
 * Free-text «طرف حساب» stays — a taxi receipt does not deserve a new record, and
 * the text on a historical expense must not change when somebody renames a
 * party. What did not exist was the link, so supplier spend could not be grouped
 * by supplier anywhere. The options are searched from `/api/parties` (the one
 * party endpoint, the one `parties.view` gate); a member who cannot read the
 * directory is offered nothing but the free-text field rather than a control that
 * always 403s.
 */
function PartyField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const query = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (unavailable) return;
    const id = timer.current;
    return () => {
      if (id) clearTimeout(id);
    };
  }, [unavailable]);

  function search(next: string) {
    query.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void api<{ parties?: { id: string; name: string }[]; error?: string }>(
        `/api/parties?q=${encodeURIComponent(next)}&limit=25`,
      ).then(({ ok, data }) => {
        if (!ok) {
          setUnavailable(true);
          return;
        }
        setOptions((data.parties ?? []).map((party) => ({ value: party.id, label: party.name })));
      });
    }, 250);
  }

  if (unavailable) return null;

  return (
    <div className="block">
      <span className="mb-1.5 block text-sm font-medium text-foreground">
        شخص در فهرست اشخاص <span className="font-normal text-muted-foreground">(اختیاری)</span>
      </span>
      <SearchableSelect
        value={value}
        onChange={onChange}
        onQueryChange={search}
        ariaLabel="انتخاب شخص برای طرف حساب"
        options={[{ value: "", label: "بدون پیوند به فهرست اشخاص" }, ...options]}
      />
    </div>
  );
}

/**
 * Explicit tax treatment (issue #832 §11). Off is «no VAT» and posts exactly the
 * two lines this screen always posted; on adds the input-VAT debit, and the rate
 * button only ever *fills in* the platform's configured rate so the number on the
 * invoice can still be typed over it.
 */
function VatField({
  enabled,
  rate,
  grossText,
  vatText,
  money,
  onToggle,
  onChangeVat,
}: {
  enabled: boolean;
  rate: number | null;
  grossText: string;
  vatText: string;
  money: ReturnType<typeof useMoney>;
  onToggle: (next: boolean) => void;
  onChangeVat: (next: string) => void;
}) {
  return (
    <div className="block">
      <span className="mb-1.5 block text-sm font-medium text-foreground">مالیات بر ارزش افزوده</span>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          className="size-4 rounded border-border text-primary focus-visible:ring-ring/50"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        این هزینه مالیات قابل استرداد دارد
      </label>
      {enabled ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="block w-40">
            <span className="mb-1 block text-xs text-muted-foreground">مالیات ({money.unitLabel})</span>
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              allowNegative={false}
              value={vatText}
              onChange={(e) => onChangeVat(e.target.value)}
              placeholder="۰"
            />
          </label>
          {rate && rate > 0 ? (
            <SecondaryButton
              onClick={() => {
                const gross = Number.isFinite(Number(money.parse(grossText))) ? money.parse(grossText) : 0;
                const vat = inclusiveExpenseVatAmount(gross, rate);
                onChangeVat(vat === null ? "" : String(money.toInput(vat)));
              }}
            >
              محاسبه از نرخ {toPersianDigits(rate)}٪
            </SecondaryButton>
          ) : null}
        </div>
      ) : (
        <span className="mt-1 block text-xs text-muted-foreground">
          بدون مالیات، همان دو سطر همیشگی ثبت می‌شود.
        </span>
      )}
    </div>
  );
}
