"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, todayIsoDate } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { AccountRow, Runner } from "./accounting-manager";
import { cardClass } from "@/app/dashboard/page-chrome";

interface ExpenseRow {
  id: string;
  expenseDate: string;
  accountCode: string;
  accountName: string;
  paymentAccountCode: string;
  paymentAccountName: string;
  amount: number;
  vendor: string | null;
  memo: string;
  createdByName: string | null;
}

interface ExpenseListResponse {
  expenses: ExpenseRow[];
  hasMore?: boolean;
  totalAmount?: number;
  totalCount?: number;
}

/**
 * Categorised operating expenses, recorded as paid — the expense account
 * chosen (rent, utilities, marketing, …) is the category, so no separate
 * taxonomy exists. Posts immediately (Debit expense account / Credit
 * payment account), same as an order or purchase would, rather than going
 * through the manual-journal draft/review/post workflow — this is a
 * routine, already-categorised entry, not a freeform one.
 *
 * What this screen used to get wrong, all fixed here:
 *
 *  - A malformed amount («۱۲٫۵»، an empty string after the digits were
 *    stripped) made `submit` `return` in silence: the button looked enabled,
 *    the click did nothing, and nothing said why. Every refusal is named now
 *    and rendered next to the field that caused it.
 *  - Picking the same account as both the category and the payment source was
 *    only caught by the server (`same_account`), after a round trip. So was a
 *    date in a locked period, which is unavoidable — but the same-account case
 *    is knowable in the browser and is blocked there.
 *  - «جمع هزینه‌های این فهرست» summed the rows the browser happened to hold,
 *    while the API silently cut the list at 200. The total and the count come
 *    from the server over the whole matching set now, and truncation is stated.
 *  - There was no way to find an expense: no date range, no category filter, no
 *    search. A list of spend with no filters is a list nobody can audit.
 *  - Nothing confirmed a successful posting; the form just emptied itself,
 *    which reads identically to "it was cleared by a reload".
 *  - The mobile card list rendered *below* the total, so on a phone the summary
 *    row sat between the (hidden) table and the cards. Order is list → total on
 *    every breakpoint now.
 *  - `SearchableSelect` renders a `<button>`; wrapping it in a bare `<label>`
 *    gave it no accessible name. Each one is labelled explicitly.
 *  - The list request had no cancellation, so a slow first response could land
 *    after a faster filtered one and overwrite it.
 */
export function ExpenseSection({
  accounts,
  busy,
  run,
  refreshKey,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: Runner;
  refreshKey: number;
}) {
  const expenseAccounts = useMemo(() => accounts.filter((a) => a.type === "expense"), [accounts]);
  const paymentAccounts = useMemo(() => accounts.filter((a) => a.type === "asset"), [accounts]);

  const money = useMoney();
  const [accountId, setAccountId] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState("");
  const [vendor, setVendor] = useState("");
  const [memo, setMemo] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  // Receipt-photo OCR (migration 0177) — Accounting's own direct upload path,
  // distinct from the AI Chat assistant's draft_expense_from_receipt tool:
  // no chat turn needed, and the photo becomes a real Media Library asset
  // (`receiptAssetId`) attached to the expense once it's recorded.
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState("");
  const [receiptAsset, setReceiptAsset] = useState<{ id: string; fileName: string } | null>(null);
  const receiptInputRef = useRef<HTMLInputElement>(null);

  const [expenses, setExpenses] = useState<ExpenseRow[] | null>(null);
  const [listTotal, setListTotal] = useState(0);
  const [listCount, setListCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState("");

  // Filters — the same vocabulary «دفتر روزنامه» uses, so the two books are
  // searched the same way.
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterAccountId, setFilterAccountId] = useState("");
  const [q, setQ] = useState("");

  const today = todayIsoDate();

  const loadUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (filterFrom) params.set("dateFrom", filterFrom);
    if (filterTo) params.set("dateTo", filterTo);
    if (filterAccountId) params.set("accountId", filterAccountId);
    if (q.trim()) params.set("q", q.trim());
    return `/api/ledger/expenses?${params}`;
  }, [filterFrom, filterTo, filterAccountId, q]);

  // A request counter, not just an `ignore` flag: with debounced typing several
  // requests can be in flight, and only the newest one may write state.
  const requestId = useRef(0);
  const load = useCallback(
    (url: string) => {
      const id = ++requestId.current;
      setLoadError("");
      api<ExpenseListResponse>(url).then(({ ok, data }) => {
        if (id !== requestId.current) return;
        if (ok) {
          setExpenses(data.expenses ?? []);
          setHasMore(!!data.hasMore);
          const rows = data.expenses ?? [];
          // Fall back to the page sum only if an older server is answering.
          setListTotal(
            typeof data.totalAmount === "number"
              ? data.totalAmount
              : rows.reduce((sum, e) => sum + e.amount, 0),
          );
          setListCount(typeof data.totalCount === "number" ? data.totalCount : rows.length);
        } else {
          // An endless skeleton reads as "still loading"; name the failure.
          setExpenses([]);
          setHasMore(false);
          setListTotal(0);
          setListCount(0);
          setLoadError("بارگذاری فهرست هزینه‌ها ناموفق بود.");
        }
      });
    },
    [],
  );

  useEffect(() => {
    setExpenses(null);
    // Debounce only the free-text box; a date or category pick is deliberate.
    const timer = setTimeout(() => load(loadUrl), q.trim() ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, loadUrl, q, refreshKey]);

  const filtered = !!(filterFrom || filterTo || filterAccountId || q.trim());
  function clearFilters() {
    setFilterFrom("");
    setFilterTo("");
    setFilterAccountId("");
    setQ("");
  }

  /**
   * Reads the chosen photo as a data URL, sends it to the metered
   * `/api/ai/receipt-ocr` extraction, and — on success — both prefills the
   * form (vendor/date/amount/memo/category, never overwriting a field the
   * person had already typed) and remembers the resulting Media asset so
   * `submit` attaches it to the expense as its `receiptAssetId`. A failed or
   * unavailable extraction never blocks manual entry — it just reports why
   * and leaves the form exactly as it was.
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
        fields?: { vendor: string | null; expenseDate: string | null; amount: number | null; memo: string; suggestedAccountCode: string | null };
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
      if (f.suggestedAccountCode && !accountId) {
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
   * than at whatever the server happened to check first.
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
    if (expenseDate && expenseDate > today) return "تاریخ هزینه نمی‌تواند در آینده باشد.";
    if (!memo.trim()) return "شرح هزینه الزامی است.";
    return "";
  }

  const validationError = validate();
  const canSubmit = !busy && validationError === "";

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
          memo: memo.trim(),
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

  // A business whose chart has no expense (or no asset) account cannot record
  // anything here; say so and point at the chart rather than showing a form
  // whose first field is permanently empty.
  const chartIncomplete = expenseAccounts.length === 0 || paymentAccounts.length === 0;

  return (
    <div className="min-w-0 space-y-4">
      <section aria-labelledby="expense-form-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملیات هزینه</p>
          <h2 id="expense-form-heading" className="mt-1 text-base font-semibold text-foreground">
            ثبت هزینه
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            هزینه به‌عنوان پرداخت‌شده ثبت می‌شود و بلافاصله در دفاتر منعکس خواهد شد: بدهکار «دسته هزینه» و
            بستانکار «حساب پرداخت».
          </p>
        </header>

        <div className="p-4 sm:p-5">
          {chartIncomplete ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              برای ثبت هزینه باید دست‌کم یک حساب از نوع «هزینه» و یک حساب از نوع «دارایی» (صندوق یا بانک) در
              سرفصل حساب‌ها فعال باشد.
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
                  مبلغ را به {money.unitLabel} وارد کنید.
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
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleReceiptFile(file);
                    }}
                  />
                  <SecondaryButton disabled={receiptBusy} onClick={() => receiptInputRef.current?.click()}>
                    {receiptBusy ? "در حال استخراج…" : "آپلود عکس رسید"}
                  </SecondaryButton>
                  {receiptAsset ? (
                    <span className="text-xs text-emerald-700 dark:text-emerald-300">
                      «{receiptAsset.fileName}» ضمیمه شد و همراه هزینه ذخیره می‌شود.
                    </span>
                  ) : null}
                </div>
                {receiptError ? (
                  <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{receiptError}</p>
                ) : (
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    عکس رسید را انتخاب کنید تا مبلغ، طرف حساب و تاریخ به‌صورت خودکار پیشنهاد شود؛ عکس در کتابخانهٔ رسانه
                    ذخیره و به این هزینه پیوند داده می‌شود.
                  </span>
                )}
              </div>

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
                    <PrimaryButton disabled={!canSubmit}>{busy ? "در حال ثبت…" : "ثبت هزینه"}</PrimaryButton>
                  </div>
                  {/*
                    The button stays clickable while the form is incomplete: a
                    disabled control that never says why is the worst of both
                    worlds. It is only truly disabled while a request is in
                    flight; otherwise pressing it names the missing field.
                  */}
                  {validationError && !busy ? (
                    <span className="text-xs text-muted-foreground">{validationError}</span>
                  ) : null}
                </div>
              </div>
            </form>
          )}
        </div>
      </section>

      <section aria-labelledby="expense-list-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق عملیاتی</p>
          <h2 id="expense-list-heading" className="mt-1 text-base font-semibold text-foreground">
            هزینه‌های ثبت‌شده
          </h2>
        </header>

        <div className="border-b border-border/80 p-4 sm:p-5">
          <div className="grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
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
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">جست‌وجو</span>
              <input
                className={inputClass}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="شرح، طرف حساب یا نام/کد حساب…"
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
              <DataTable caption="فهرست هزینه‌های ثبت‌شده" className="hidden lg:block" tableClassName="min-w-[56rem]">
                <DataTableHead>
                  <Th>تاریخ</Th>
                  <Th>دسته</Th>
                  <Th>شرح</Th>
                  <Th>طرف حساب</Th>
                  <Th>پرداخت از</Th>
                  <Th>ثبت‌کننده</Th>
                  <Th numeric>مبلغ</Th>
                </DataTableHead>
                <DataTableBody>
                  {expenses.map((e) => (
                    <DataTableRow key={e.id}>
                      <Td muted nowrap>
                        {toPersianDigits(formatJalali(e.expenseDate))}
                      </Td>
                      <Td>
                        {toPersianDigits(e.accountCode)} {e.accountName}
                      </Td>
                      <Td className="max-w-[18rem] break-words">{e.memo}</Td>
                      <Td muted>{e.vendor ?? "—"}</Td>
                      <Td muted>
                        {toPersianDigits(e.paymentAccountCode)} {e.paymentAccountName}
                      </Td>
                      <Td muted>{e.createdByName ?? "—"}</Td>
                      <Td numeric nowrap className="font-semibold">
                        {money.format(e.amount)}
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              <div className="space-y-3 lg:hidden">
                {expenses.map((e) => (
                  <article
                    key={e.id}
                    className="rounded-xl border border-border/80 bg-muted/60 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-words text-sm font-semibold text-foreground">
                          {toPersianDigits(e.accountCode)} {e.accountName}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {toPersianDigits(formatJalali(e.expenseDate))}
                        </p>
                      </div>
                      <span className="whitespace-nowrap font-bold tabular-nums text-foreground">
                        {money.format(e.amount)}
                      </span>
                    </div>
                    <p className="mt-3 break-words text-sm text-foreground">{e.memo}</p>
                    <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">طرف حساب</dt>
                        <dd className="mt-1 break-words text-sm text-foreground">{e.vendor ?? "—"}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">پرداخت از</dt>
                        <dd className="mt-1 break-words text-sm text-foreground">
                          {toPersianDigits(e.paymentAccountCode)} {e.paymentAccountName}
                        </dd>
                      </div>
                      <div className="col-span-2 min-w-0">
                        <dt className="text-muted-foreground">ثبت‌کننده</dt>
                        <dd className="mt-1 break-words text-sm text-foreground">{e.createdByName ?? "—"}</dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-muted/60 px-4 py-3 text-sm">
                <span className="text-muted-foreground">
                  {filtered ? "جمع هزینه‌های این فیلتر" : "جمع کل هزینه‌های ثبت‌شده"}
                  {" · "}
                  {toPersianDigits(listCount)} فقره
                </span>
                <span className="font-bold tabular-nums text-foreground">{money.format(listTotal)}</span>
              </div>

              {hasMore ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  فقط {toPersianDigits(expenses.length)} هزینهٔ اخیر نمایش داده شده است؛ برای دیدن بقیه بازهٔ
                  تاریخ یا دسته را محدودتر کنید. جمع بالا شامل همهٔ {toPersianDigits(listCount)} فقره است.
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
