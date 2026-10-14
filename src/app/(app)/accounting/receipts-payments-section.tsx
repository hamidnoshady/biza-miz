"use client";

import {
  EmptyState,
  SectionCardSkeleton,
  cardClass,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { useEffect, useMemo, useRef, useState } from "react";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ArrowDownLeftIcon, ArrowUpRightIcon, DownloadIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { FilterChip } from "@/app/dashboard/filters";
import { fmtJalali, OverlayDialog } from "./ledger-ui";
import { formatJalali } from "@/lib/jalali";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { buildVoucherBody, useVoucherSubmission, validateVoucherAmount, VoucherFormFields } from "./settlement-form";
import { voucherReference } from "@/lib/voucher-shared";
import { VOUCHER_METHOD_LABELS, voucherAccountChoices, type VoucherAccountChoice, type VoucherMethod } from "@/lib/payables-input";
import Link from "next/link";
import { accountingCustomerHref, accountingSectionHref, accountingSupplierHref } from "./accounting-routes";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { amountToRialText, rialTextToAmountInput } from "./journal-view";

/**
 * «دریافت و پرداخت» — the voucher ledger slice. The reference software keeps
 * four lists (receive/pay/income/expense); here receive and pay are the two
 * subledger voucher streams the accounting engine already posts (ar_receipts
 * / ap_payments), so this section is a view over the very rows the receive
 * and pay actions write — one place to browse, search, filter and export
 * them, and to register a new voucher with the platform's form language.
 *
 * Issue #829: the list is cursor-paginated (a large history never ships in
 * one response), rows carry their stable voucher number (not the visible
 * index), reversed vouchers show their status instead of vanishing, and the
 * ثبت buttons follow finance.receivables_manage / finance.payables_manage.
 */

interface Voucher {
  id: string;
  date: string;
  method: VoucherMethod;
  amount: number;
  memo: string | null;
  partyName: string;
  voucherNumber: number | null;
  reversedAt: string | null;
  /** The bank's tracking number, when one was recorded. */
  bankReference: string | null;
  /** The cash/bank/clearing account named on the voucher; null = the method's default account. */
  cashAccount: { code: string; name: string } | null;
  locationName?: string | null;
  reversed?: boolean;
  reversalDate?: string | null;
  reversalEntryId?: string | null;
}

/** «بانکی · بانک ملت» — the method, plus the account when the voucher named one. */
function methodText(r: { method: VoucherMethod; cashAccount: { code: string; name: string } | null }): string {
  return r.cashAccount
    ? `${VOUCHER_METHOD_LABELS[r.method]} · ${r.cashAccount.name}`
    : VOUCHER_METHOD_LABELS[r.method];
}

type Side = "receipts" | "payments";
type MethodFilter = "all" | VoucherMethod;
type StatusFilter = "all" | "active" | "reversed";

const STATUS_LABELS: Record<Exclude<StatusFilter, "all">, string> = {
  active: "فعال",
  reversed: "باطل‌شده",
};

export function ReceiptsPaymentsSection({
  canManageReceivables = false,
  canManagePayables = false,
  canReversePayments = false,
  canReverseReceipts = false,
}: {
  /**
   * Whether this member may record receipts / payments
   * (finance.receivables_manage / finance.payables_manage) or approve a
   * correction (ledger.approve). The page always passes explicit booleans;
   * the defaults deny, so an unwired caller fails closed and the API stays
   * the gate in any case.
   */
  canManageReceivables?: boolean;
  canManagePayables?: boolean;
  canReversePayments?: boolean;
  canReverseReceipts?: boolean;
}) {
  const money = useMoney();
  const [side, setSide] = useState<Side>("receipts");
  const [q, setQ] = useState("");
  const [methodFilter, setMethodFilter] = useState<MethodFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // The «فیلترهای بیشتر» panel, same vocabulary the API speaks: ISO dates on
  // the wire (Shamsi at the edge), ids for party/branch/account, Rial text
  // for the amount bounds (the fields show the display unit).
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [partyId, setPartyId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  // Filter option sources. The branch list comes from the journal's filter
  // endpoint (the values this business's book actually contains) rather than
  // the branch directory, whose capability a viewer may not hold.
  const [parties, setParties] = useState<PartyOption[]>([]);
  const [partyState, setPartyState] = useState<"loading" | "error" | "ready">("loading");
  const [directoryKey, setDirectoryKey] = useState(0);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [accountChoices, setAccountChoices] = useState<VoucherAccountChoice[] | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [optionsKey, setOptionsKey] = useState(0);
  const [rows, setRows] = useState<Voucher[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  /*
   * Responses race each other — a fast «علی» search easily outruns the slow
   * unfiltered listing it was typed over, and without the token the *older*
   * answer wins the setState and the screen shows rows that match nothing the
   * user asked for. Only the latest request may write state.
   */
  const requestSeq = useRef(0);
  /*
   * A keyset cursor belongs to the query that issued it. Paging appends to
   * the rows on screen, so «نمایش بیشتر» may only fire while the filters
   * still serialize to the cursor's own query: firing with a moved filter
   * (a search typed inside the 250ms debounce, where the seq has not turned
   * yet) would append another dataset's rows to this one. The ref mirrors
   * the live filter state every render; the cursor's query is recorded on
   * each listing/page answer and cleared when the stream switches.
   */
  const filterKeyRef = useRef("");
  const cursorQueryRef = useRef<string | null>(null);
  /*
   * The register API projects stored row columns; `reversed` is derived, not
   * stored, so every fetch normalizes it before the rows reach state.
   */
  function normalizeRow(row: Voucher): Voucher {
    return { ...row, reversed: row.reversedAt !== null };
  }
  const prevSide = useRef<Side>(side);

  const canCreate = side === "receipts" ? canManageReceivables : canManagePayables;

  /*
   * One serializer for the filter state: the list and the CSV export honor
   * the same filters, so they build the same query rather than each spelling
   * the fields. Amount bounds are Rial text already (the fields convert on
   * input); only well-formed bounds travel.
   */
  function filterParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (methodFilter !== "all") params.set("method", methodFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (partyId) params.set("partyId", partyId);
    if (locationId) params.set("locationId", locationId);
    if (cashAccountId) params.set("cashAccountId", cashAccountId);
    if (/^\d+$/.test(minAmount.trim())) params.set("minAmount", minAmount.trim());
    if (/^\d+$/.test(maxAmount.trim())) params.set("maxAmount", maxAmount.trim());
    return params;
  }

  function listUrl(cursor?: string | null): string {
    const params = filterParams();
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();
    const base = side === "receipts" ? "/api/ledger/ar/receipts" : "/api/ledger/ap/payments";
    return query ? `${base}?${query}` : base;
  }

  filterKeyRef.current = filterParams().toString();

  // The counterparty options, from the same directory endpoints the voucher
  // form picks from (`?scope=directory`, not the open-balance list).
  useEffect(() => {
    let cancelled = false;
    setPartyState("loading");
    const url =
      side === "receipts" ? "/api/ledger/ar/customers?scope=directory" : "/api/ledger/ap/suppliers?scope=directory";
    api<{
      customers?: { customerId: string; customerName: string; customerPhone: string | null }[];
      suppliers?: { supplierId: string; supplierName: string; supplierPhone: string | null; locationName?: string | null }[];
    }>(url).then(({ ok, data }) => {
      if (cancelled) return;
      if (!ok) {
        setPartyState("error");
        return;
      }
      setParties(
        side === "receipts"
          ? (data.customers ?? []).map((c) => ({ id: c.customerId, name: c.customerName, phone: c.customerPhone }))
          : (data.suppliers ?? []).map((s) => ({ id: s.supplierId, name: s.supplierName, phone: s.supplierPhone, locationName: s.locationName })),
      );
      setPartyState("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [side, directoryKey]);

  // Branch options from the journal's filter endpoint, account options from
  // the chart through the shared eligibility rules. Both are side-independent
  // and load once; a failure degrades to the pickers disabled, never a broken
  // screen — the list itself does not depend on them.
  useEffect(() => {
    let cancelled = false;
    setOptionsFailed(false);
    Promise.all([
      api<{ locations?: { id: string; name: string }[] }>("/api/ledger/entries/filters"),
      api<{
        accounts?: { id: string; code: string; name: string; type: "asset" | "liability" | "equity" | "revenue" | "expense"; parent_code: string | null }[];
      }>("/api/ledger/accounts"),
    ]).then(([branches, chart]) => {
      if (cancelled) return;
      if (!branches.ok || !chart.ok) {
        setOptionsFailed(true);
        return;
      }
      setLocations(branches.data.locations ?? []);
      setAccountChoices(voucherAccountChoices(chart.data.accounts ?? []));
    });
    return () => {
      cancelled = true;
    };
  }, [optionsKey]);

  useEffect(() => {
    // Switching دریافتی/پرداختی swaps the whole dataset; what is on screen
    // belongs to the other stream, so only that transition blanks the list —
    // searches, filters and refreshes keep their rows and just flag
    // «در حال به‌روزرسانی».
    if (prevSide.current !== side) {
      prevSide.current = side;
      setRows(null);
      setNextCursor(null);
      setHasMore(false);
      cursorQueryRef.current = null;
    }
    const seq = ++requestSeq.current;
    // A fresh listing supersedes any in-flight «نمایش بیشتر»: its rows would
    // append to the wrong dataset, so it is discarded — and the button must
    // not stay wedged in «در حال بارگذاری» because of it.
    setLoadingMore(false);
    const run = () => {
      setLoading(true);
      const requestedQuery = filterParams().toString();
      api<{ receipts?: Voucher[]; payments?: Voucher[]; nextCursor?: string | null; hasMore?: boolean; error?: string }>(
        listUrl(),
      )
        .then(({ ok, data }) => {
          if (requestSeq.current !== seq) return;
          if (ok) {
            setRows((data.receipts ?? data.payments ?? []).map(normalizeRow));
            setNextCursor(data.nextCursor ?? null);
            setHasMore(data.hasMore ?? false);
            cursorQueryRef.current = requestedQuery;
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
    // Typed inputs (search, amount bounds) debounce; discrete pickers (chips,
    // selects, dates) list immediately.
    const t = setTimeout(run, q || minAmount || maxAmount ? 250 : 0);
    return () => clearTimeout(t);
    // listUrl closes over the filter state; listing every dep keeps the lint
    // rule honest without re-running on an unstable function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, q, methodFilter, statusFilter, dateFrom, dateTo, partyId, locationId, cashAccountId, minAmount, maxAmount, refreshKey]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    // The cursor was issued for another query than the filters now describe
    // (a keystroke inside the debounce, a chip whose listing is still in
    // flight): the fresh listing is already coming and will reset the page,
    // so there is nothing truthful to append to.
    if (filterKeyRef.current !== cursorQueryRef.current) return;
    const seq = requestSeq.current;
    const queryKey = filterKeyRef.current;
    const cursor = nextCursor;
    setLoadingMore(true);
    try {
      const { ok, data } = await api<{
        receipts?: Voucher[];
        payments?: Voucher[];
        nextCursor?: string | null;
        hasMore?: boolean;
        error?: string;
      }>(listUrl(cursor));
      // Superseded by a newer listing: the rows belong to the old query and
      // must not append to the new dataset.
      if (requestSeq.current !== seq) return;
      if (ok) {
        setRows((prev) => [...(prev ?? []), ...(data.receipts ?? data.payments ?? []).map(normalizeRow)]);
        setNextCursor(data.nextCursor ?? null);
        setHasMore(data.hasMore ?? false);
        cursorQueryRef.current = queryKey;
      } else {
        setError(errorMessage(data.error));
      }
    } finally {
      // Unconditional: a superseded fetch leaves the button wedged in «در حال
      // بارگذاری» forever if the reset is seq-guarded.
      setLoadingMore(false);
    }
  }

  /*
   * The export is server-rendered: the visible page is a window into the
   * history, and exporting it would silently drop every voucher outside the
   * window. The API honors the same filters and neutralizes formula-leading
   * cells, so a memo starting with «=» cannot become a spreadsheet formula.
   * A plain anchor download cannot surface a failure, so the file travels
   * through fetch: the export streams the whole filtered set, and a failure
   * anywhere along the way rejects here and shows as an error — a silently
   * short file reconciled as complete is worse than no file.
   */
  async function downloadCsv() {
    if (downloading) return;
    setDownloading(true);
    setError("");
    try {
      const params = filterParams();
      params.set("format", "csv");
      const base = side === "receipts" ? "/api/ledger/ar/receipts" : "/api/ledger/ap/payments";
      let response: Response;
      try {
        response = await fetch(`${base}?${params.toString()}`);
      } catch {
        setError(errorMessage("network_error"));
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setError(errorMessage(data.error ?? "network_error"));
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = side === "receipts" ? "receipts.csv" : "payments.csv";
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } finally {
      setDownloading(false);
    }
  }

  function refresh() {
    setSelectedId(null);
    setRefreshKey((k) => k + 1);
  }

  /*
   * A counterparty id belongs to one stream — a customer id sent as the
   * supplier filter (or vice versa) would match nothing and confuse. The
   * party filter resets on the switch; the rest (dates, amounts, account,
   * branch) are stream-agnostic and survive it.
   */
  function switchSide(next: Side) {
    if (next === side) return;
    setPartyId("");
    setSide(next);
  }

  function clearExtraFilters() {
    setDateFrom("");
    setDateTo("");
    setPartyId("");
    setLocationId("");
    setCashAccountId("");
    setMinAmount("");
    setMaxAmount("");
  }

  const extraFilterCount = [dateFrom, dateTo, partyId, locationId, cashAccountId, minAmount.trim(), maxAmount.trim()].filter(
    (v) => v !== "",
  ).length;

  const partyOptions = useMemo(
    () => [
      { value: "", label: partyState === "error" ? "در دسترس نیست" : "همه اشخاص" },
      ...parties.map((party) => ({
        value: party.id,
        // Two counterparties can share a name; the branch/phone tells them
        // apart before the filter silently narrows to the wrong person.
        label: [party.name, party.locationName ? `شعبهٔ ${party.locationName}` : null, party.phone ? toPersianDigits(party.phone) : null]
          .filter(Boolean)
          .join(" · "),
        searchString: `${party.name} ${party.locationName ?? ""} ${party.phone ?? ""}`,
      })),
    ],
    [parties, partyState],
  );

  const accountOptions = useMemo(
    () => [
      { value: "", label: optionsFailed ? "در دسترس نیست" : "همه حساب‌ها" },
      ...(accountChoices ?? []).map((a) => ({
        value: a.id,
        label: `${VOUCHER_METHOD_LABELS[a.method]} · ${toPersianDigits(a.code)} ${a.name}`,
        searchString: `${a.code} ${a.name} ${VOUCHER_METHOD_LABELS[a.method]}`,
      })),
    ],
    [accountChoices, optionsFailed],
  );

  const locationOptions = useMemo(
    () => [
      { value: "", label: optionsFailed ? "در دسترس نیست" : "همهٔ شعب" },
      ...locations.map((loc) => ({ value: loc.id, label: loc.name })),
    ],
    [locations, optionsFailed],
  );


  async function reversePayment(row: Voucher) {
    if (!canReversePayments || row.reversed || reversingId) return;
    if (!window.confirm(`برگشت پرداخت ${row.partyName} به مبلغ ${money.format(row.amount)} ثبت شود؟ این کار سند اصلاحی تازه‌ای می‌سازد و قابل حذف نیست.`)) return;
    setReversingId(row.id);
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/ap/payments/${row.id}/reverse`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setReversingId(null);
    if (ok) setRefreshKey((k) => k + 1);
    else setError(errorMessage(data.error));
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
            {/*
             * Sorted by document date (newest first), not by creation order —
             * a back-dated voucher files under its own date. The heading used
             * to claim «به ترتیب تاریخ ثبت» while the query ordered by the
             * voucher date.
             */}
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {side === "receipts" ? "اسناد دریافت وجه از مشتریان، به ترتیب تاریخ سند." : "اسناد پرداخت وجه به تأمین‌کنندگان، به ترتیب تاریخ سند."}
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
              onClick={() => void downloadCsv()}
              disabled={downloading || !rows || rows.length === 0}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            >
              <DownloadIcon aria-hidden="true" className="size-4" />
              {downloading ? "در حال آماده‌سازی…" : "دانلود"}
            </button>
            {canCreate ? (
              <Button onClick={() => setCreating(true)} className="min-h-10">
                <PlusIcon aria-hidden="true" className="size-4" />
                {side === "receipts" ? "ثبت دریافت" : "ثبت پرداخت"}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex gap-2" role="group" aria-label="نوع سند">
            <FilterChip dense selected={side === "receipts"} onClick={() => switchSide("receipts")}>
              <span className="inline-flex items-center gap-1.5">
                <ArrowDownLeftIcon aria-hidden="true" className="size-3.5" />
                دریافتی
              </span>
            </FilterChip>
            <FilterChip dense selected={side === "payments"} onClick={() => switchSide("payments")}>
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

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex gap-2" role="group" aria-label="روش تسویه">
            <FilterChip dense selected={methodFilter === "all"} onClick={() => setMethodFilter("all")}>همه روش‌ها</FilterChip>
            <FilterChip dense selected={methodFilter === "cash"} onClick={() => setMethodFilter("cash")}>نقدی</FilterChip>
            <FilterChip dense selected={methodFilter === "bank"} onClick={() => setMethodFilter("bank")}>بانکی</FilterChip>
            <FilterChip dense selected={methodFilter === "clearing"} onClick={() => setMethodFilter("clearing")}>در جریان وصول</FilterChip>
          </div>
          <div className="flex gap-2" role="group" aria-label="وضعیت سند">
            <FilterChip dense selected={statusFilter === "all"} onClick={() => setStatusFilter("all")}>همه وضعیت‌ها</FilterChip>
            <FilterChip dense selected={statusFilter === "active"} onClick={() => setStatusFilter("active")}>فعال</FilterChip>
            <FilterChip dense selected={statusFilter === "reversed"} onClick={() => setStatusFilter("reversed")}>باطل‌شده</FilterChip>
          </div>
        </div>

        {showMoreFilters ? (
          <div className="mt-3 grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 lg:grid-cols-4 lg:items-end">
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">{side === "receipts" ? "مشتری" : "تأمین‌کننده"}</span>
              <SearchableSelect
                value={partyId}
                onChange={setPartyId}
                ariaLabel={side === "receipts" ? "فیلتر مشتری" : "فیلتر تأمین‌کننده"}
                loading={partyState === "loading"}
                disabled={partyState === "error"}
                options={partyOptions}
              />
              {partyState === "error" ? (
                <span className="mt-1.5 flex items-center gap-2 text-xs">
                  <span className="text-destructive">لیست اشخاص بارگذاری نشد.</span>
                  <button
                    type="button"
                    onClick={() => setDirectoryKey((k) => k + 1)}
                    className="rounded-lg px-2 py-1 font-semibold text-amber-700 transition-colors hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-500/10"
                  >
                    تلاش مجدد
                  </button>
                </span>
              ) : null}
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">حساب</span>
              <SearchableSelect
                value={cashAccountId}
                onChange={setCashAccountId}
                ariaLabel="فیلتر حساب"
                loading={accountChoices === null && !optionsFailed}
                disabled={optionsFailed}
                options={accountOptions}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">شعبه</span>
              <SearchableSelect
                value={locationId}
                onChange={setLocationId}
                ariaLabel="فیلتر شعبه"
                disabled={optionsFailed}
                options={locationOptions}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">از تاریخ</span>
                <JalaliDatePicker value={dateFrom} onChange={setDateFrom} ariaLabel="از تاریخ" placeholder="از تاریخ" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">تا تاریخ</span>
                <JalaliDatePicker value={dateTo} onChange={setDateTo} ariaLabel="تا تاریخ" placeholder="تا تاریخ" />
              </label>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">حداقل مبلغ</span>
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={rialTextToAmountInput(minAmount, money.unit)}
                onChange={(event) => setMinAmount(amountToRialText(event.target.value, money.parseText))}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">حداکثر مبلغ</span>
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={rialTextToAmountInput(maxAmount, money.unit)}
                onChange={(event) => setMaxAmount(amountToRialText(event.target.value, money.parseText))}
              />
            </label>
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SecondaryButton onClick={() => setShowMoreFilters((open) => !open)}>
            {showMoreFilters ? "بستن فیلترهای بیشتر" : "فیلترهای بیشتر"}
            {extraFilterCount > 0 ? ` (${toPersianDigits(extraFilterCount)})` : ""}
          </SecondaryButton>
          {extraFilterCount > 0 ? (
            <SecondaryButton onClick={clearExtraFilters}>
              پاک کردن فیلترها
            </SecondaryButton>
          ) : null}
        </div>

        {optionsFailed ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-3 py-3">
            <p className="text-xs leading-5 text-muted-foreground">
              فهرست شعب و حساب‌ها بارگذاری نشد؛ این فیلترها موقتاً غیرفعال‌اند.
            </p>
            <SecondaryButton onClick={() => setOptionsKey((key) => key + 1)}>تلاش دوباره</SecondaryButton>
          </div>
        ) : null}

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
                {hasMore
                  ? `${toPersianDigits(rows.length)} سند — موارد بیشتر با «نمایش بیشتر»`
                  : `${toPersianDigits(rows.length)} سند`}
              </p>
              <DataTable caption="اسناد دریافت و پرداخت" className="hidden lg:block">
                <DataTableHead>
                  <Th>شماره سند</Th>
                  <Th>شخص</Th>
                  <Th>شرح</Th>
                  <Th>روش</Th>
                  <Th>شماره پیگیری</Th>
                  <Th>تاریخ</Th>
                  <Th>مبلغ</Th>
                  <Th>وضعیت</Th>
                  {side === "payments" && canReversePayments ? <Th>اقدام</Th> : null}
                </DataTableHead>
                <DataTableBody>
                  {rows.map((r) => (
                    <DataTableRow
                      key={r.id}
                      className="cursor-pointer transition-colors hover:bg-muted/60"
                      onClick={() => setSelectedId(r.id)}
                    >
                      <Td muted>{r.voucherNumber != null ? toPersianDigits(voucherReference(side === "receipts" ? "receipt" : "payment", r.voucherNumber)) : "—"}</Td>
                      <Td className="max-w-48 truncate font-medium" title={r.partyName}>
                        {r.partyName}
                        {side === "payments" && r.locationName ? <span className="mt-1 block text-xs font-normal text-muted-foreground">شعبهٔ {r.locationName}</span> : null}
                      </Td>
                      <Td muted className="max-w-64 truncate" title={r.memo ?? undefined}>{r.memo ?? "—"}</Td>
                      <Td muted className="max-w-48 truncate" title={methodText(r)}>{methodText(r)}</Td>
                      <Td muted nowrap dir="ltr">{r.bankReference ? toPersianDigits(r.bankReference) : "—"}</Td>
                      <Td nowrap muted>{fmtJalali(r.date)}</Td>
                      <Td nowrap className="font-semibold">
                        {money.format(r.amount)}
                        {side === "payments" && r.reversed ? <span className="mt-1 block text-xs font-medium text-muted-foreground">برگشت‌خورده{r.reversalDate ? ` · ${fmtJalali(r.reversalDate)}` : ""}</span> : null}
                        {side === "payments" && r.reversalEntryId ? <Link className="mt-1 block text-xs font-semibold text-primary underline-offset-4 hover:underline" href={`${accountingSectionHref("entries")}?entryId=${encodeURIComponent(r.reversalEntryId)}`}>سند برگشت</Link> : null}
                      </Td>
                      <Td muted>{r.reversedAt ? STATUS_LABELS.reversed : STATUS_LABELS.active}</Td>
                      {side === "payments" && canReversePayments ? <Td>{r.reversed ? <span className="text-xs text-muted-foreground">برگشت‌خورده</span> : <span onClick={(e) => e.stopPropagation()}><SecondaryButton disabled={!!reversingId} onClick={() => void reversePayment(r)}>{reversingId === r.id ? "در حال ثبت…" : "برگشت پرداخت"}</SecondaryButton></span>}</Td> : null}
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              <div className="space-y-3 lg:hidden">
                {rows.map((r) => (
                  <article
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    // A clickable card that only a pointer can open is a dead
                    // end for keyboard users; the dialog is the drill-down
                    // path on mobile, so the card behaves like a button.
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(r.id);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    className="cursor-pointer rounded-xl border border-border/80 bg-muted p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-bold" title={r.partyName}>{r.partyName}</h3>
                        {side === "payments" && r.locationName ? <p className="mt-1 text-xs text-muted-foreground">شعبهٔ {r.locationName}</p> : null}
                        <p className="mt-1 text-xs text-muted-foreground">{r.memo ?? (side === "receipts" ? "دریافت وجه" : "پرداخت وجه")}</p>
                      </div>
                      <span className="whitespace-nowrap font-bold">{money.format(r.amount)}</span>
                    </div>
                    <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                      {r.voucherNumber != null ? `${toPersianDigits(voucherReference(side === "receipts" ? "receipt" : "payment", r.voucherNumber))} · ` : ""}
                      {fmtJalali(r.date)} · {methodText(r)}
                      {r.bankReference ? ` · پیگیری ${toPersianDigits(r.bankReference)}` : ""}
                      {r.reversedAt ? ` · ${STATUS_LABELS.reversed}` : ""}
                    </p>
                    {side === "payments" && r.reversed ? <p className="mt-2 text-xs font-medium text-muted-foreground">برگشت‌خورده{r.reversalDate ? ` · ${fmtJalali(r.reversalDate)}` : ""}</p> : null}
                    {side === "payments" && r.reversalEntryId ? <Link className="mt-2 inline-block text-xs font-semibold text-primary underline-offset-4 hover:underline" href={`${accountingSectionHref("entries")}?entryId=${encodeURIComponent(r.reversalEntryId)}`}>مشاهدهٔ سند برگشت</Link> : null}
                    {side === "payments" && canReversePayments && !r.reversed ? <span className="mt-3 block" onClick={(e) => e.stopPropagation()}><SecondaryButton className="w-full" disabled={!!reversingId} onClick={() => void reversePayment(r)}>{reversingId === r.id ? "در حال ثبت…" : "برگشت پرداخت"}</SecondaryButton></span> : null}
                  </article>
                ))}
              </div>

              {hasMore ? (
                <div className="mt-4 flex justify-center">
                  <SecondaryButton onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? "در حال بارگذاری…" : "نمایش بیشتر"}
                  </SecondaryButton>
                </div>
              ) : null}
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

      {selectedId ? (
        <VoucherDetailDialog
          side={side}
          voucherId={selectedId}
          canReverse={side === "receipts" ? !!canReverseReceipts : !!canReversePayments}
          onClose={() => setSelectedId(null)}
          onReversed={refresh}
        />
      ) : null}
    </section>
  );
}

interface PartyOption {
  id: string;
  name: string;
  phone: string | null;
  locationName?: string | null;
}

function VoucherForm({ side, onClose, onCreated }: { side: Side; onClose: () => void; onCreated: () => void }) {
  const money = useMoney();
  const [parties, setParties] = useState<PartyOption[]>([]);
  const [partyState, setPartyState] = useState<"loading" | "error" | "ready">("loading");
  const [directoryKey, setDirectoryKey] = useState(0);
  const [partyId, setPartyId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<VoucherMethod>("cash");
  /** "" = the method's default account. */
  const [cashAccountId, setCashAccountId] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [date, setDate] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const voucherSide = side === "receipts" ? "receipt" : "payment";
  const submission = useVoucherSubmission(voucherSide);

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
      suppliers?: { supplierId: string; supplierName: string; supplierPhone: string | null; locationName?: string | null }[];
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
          : (data.suppliers ?? []).map((s) => ({ id: s.supplierId, name: s.supplierName, phone: s.supplierPhone, locationName: s.locationName })),
      );
      setPartyState("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [side, directoryKey]);

  function chooseMethod(next: VoucherMethod) {
    setMethod(next);
    // An account belongs to one method; a reference number only to a bank or
    // clearing transfer — cash carries none.
    setCashAccountId("");
    if (next === "cash") setBankReference("");
  }

  async function submit() {
    if (!partyId) {
      setError("شخص را انتخاب کنید.");
      return;
    }
    const parsed = validateVoucherAmount(money, amount);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError("");
    const url = side === "receipts" ? "/api/ledger/ar/receipts" : "/api/ledger/ap/payments";
    // One request key belongs to one intended A/P transfer and survives a
    // retry after an ambiguous network result. Any material edit rotates it —
    // the reference folds to Latin digits first, so retyping the same number
    // in the other digit set is not a «material» edit.
    const keys = submission.keyFor({
      partyId,
      amount: parsed.rial,
      method,
      date: date || null,
      memo: memo.trim() || null,
      cashAccountId: cashAccountId || null,
      bankReference: bankReference.trim() ? toLatinDigits(bankReference).trim() : null,
    });
    const body = buildVoucherBody({
      side: voucherSide,
      partyId,
      rial: parsed.rial,
      method,
      cashAccountId,
      bankReference,
      date,
      memo,
      ...keys,
    });
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
                    label: [p.name, p.locationName ? `شعبهٔ ${p.locationName}` : null, p.phone ? toPersianDigits(p.phone) : null].filter(Boolean).join(" · "),
                    searchString: `${p.name} ${p.locationName ?? ""} ${p.phone ?? ""}`,
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
            <VoucherFormFields
              amount={amount}
              onAmountChange={setAmount}
              method={method}
              onMethodChange={chooseMethod}
              cashAccountId={cashAccountId}
              onCashAccountChange={setCashAccountId}
              showBankReference
              bankReference={bankReference}
              onBankReferenceChange={setBankReference}
              date={date}
              onDateChange={setDate}
              memo={memo}
              onMemoChange={setMemo}
            />
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

interface VoucherDetail {
  id: string;
  receiptDate?: string;
  paymentDate?: string;
  method: VoucherMethod;
  amount: number;
  memo: string | null;
  voucherNumber: number | null;
  customerId?: string;
  customerName?: string;
  supplierId?: string;
  supplierName?: string;
  locationName: string | null;
  createdByName: string | null;
  createdAt: string;
  bankReference: string | null;
  cashAccount: { code: string; name: string } | null;
  entryId: string | null;
  reversedAt: string | null;
  reversalEntryId: string | null;
  reversalDate: string | null;
  reversedByName: string | null;
}

/**
 * One voucher's drill-down: who, how much, through which cash account,
 * posted as which journal entry — and, when reversed, which entry undid it and
 * who did it. Reversal posts a mirror entry dated today; the voucher row
 * itself is never deleted.
 */
function VoucherDetailDialog({
  side,
  voucherId,
  canReverse,
  onClose,
  onReversed,
}: {
  side: Side;
  voucherId: string;
  canReverse: boolean;
  onClose: () => void;
  onReversed: () => void;
}) {
  const money = useMoney();
  const [detail, setDetail] = useState<VoucherDetail | null>(null);
  const [error, setError] = useState("");
  const [reversing, setReversing] = useState(false);
  const [reverseMemo, setReverseMemo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const url =
      side === "receipts" ? `/api/ledger/ar/receipts/${voucherId}` : `/api/ledger/ap/payments/${voucherId}`;
    api<{ receipt?: VoucherDetail; payment?: VoucherDetail; error?: string }>(url).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setDetail(data.receipt ?? data.payment ?? null);
        setError("");
      } else {
        setError(errorMessage(data.error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [side, voucherId]);

  async function submitReverse() {
    setBusy(true);
    setError("");
    const url =
      side === "receipts"
        ? `/api/ledger/ar/receipts/${voucherId}/reverse`
        : `/api/ledger/ap/payments/${voucherId}/reverse`;
    const { ok, data } = await api<{ error?: string }>(url, {
      method: "POST",
      body: JSON.stringify({ memo: reverseMemo.trim() || undefined }),
    });
    setBusy(false);
    if (ok) onReversed();
    else setError(errorMessage(data.error));
  }

  const date = detail?.receiptDate ?? detail?.paymentDate ?? "";
  const partyName = detail?.customerName ?? detail?.supplierName ?? "—";
  const partyId = detail?.customerId ?? detail?.supplierId ?? null;
  const partyHref = partyId
    ? side === "receipts"
      ? accountingCustomerHref(partyId)
      : accountingSupplierHref(partyId)
    : null;

  return (
    <OverlayDialog
      headingId="voucher-detail-heading"
      onClose={onClose}
      className={`${overlayPanelClass} flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col`}
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            {side === "receipts" ? "جزئیات دریافت" : "جزئیات پرداخت"}
          </p>
          <h3 id="voucher-detail-heading" className="mt-1 text-lg font-bold">
            {detail?.voucherNumber != null
              ? toPersianDigits(voucherReference(side === "receipts" ? "receipt" : "payment", detail.voucherNumber))
              : "سند"}
          </h3>
        </div>
        <button type="button" onClick={onClose} aria-label="بستن" className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted">
          <XIcon aria-hidden="true" className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5">
        <ErrorBox>{error}</ErrorBox>
        {!detail && !error ? (
          <SectionCardSkeleton rows={4} />
        ) : detail ? (
          <>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{side === "receipts" ? "دریافت از" : "پرداخت به"}</dt>
                <dd className="font-semibold">
                  {partyHref ? (
                    <Link className="text-primary underline-offset-4 hover:underline" href={partyHref}>
                      {partyName}
                    </Link>
                  ) : (
                    partyName
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">مبلغ</dt>
                <dd className="font-bold">{money.format(detail.amount)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">روش</dt>
                <dd>{methodText(detail)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">حساب</dt>
                <dd>
                  {detail.cashAccount
                    ? `${toPersianDigits(detail.cashAccount.code)} ${detail.cashAccount.name}`
                    : "—"}
                </dd>
              </div>
              {detail.entryId ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">سند حسابداری</dt>
                  <dd>
                    <Link
                      className="font-semibold text-primary underline-offset-4 hover:underline"
                      href={`${accountingSectionHref("entries")}?entryId=${encodeURIComponent(detail.entryId)}`}
                    >
                      مشاهده در دفتر روزنامه
                    </Link>
                  </dd>
                </div>
              ) : null}
              {detail.bankReference ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">شماره پیگیری</dt>
                  <dd dir="ltr">{toPersianDigits(detail.bankReference)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">تاریخ سند</dt>
                <dd>{date ? fmtJalali(date) : "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">زمان ثبت</dt>
                <dd>{detail.createdAt ? formatJalali(detail.createdAt, { withTime: true }) : "—"}</dd>
              </div>
              {detail.locationName ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">شعبه</dt>
                  <dd>{detail.locationName}</dd>
                </div>
              ) : null}
              {detail.memo ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">شرح</dt>
                  <dd className="max-w-56 truncate" title={detail.memo}>{detail.memo}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">ثبت‌کننده</dt>
                <dd>{detail.createdByName ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">وضعیت</dt>
                <dd>{detail.reversedAt ? STATUS_LABELS.reversed : STATUS_LABELS.active}</dd>
              </div>
              {detail.reversedAt ? (
                <>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">تاریخ ابطال</dt>
                    <dd>{detail.reversalDate ? fmtJalali(detail.reversalDate) : "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">باطل‌کننده</dt>
                    <dd>{detail.reversedByName ?? "—"}</dd>
                  </div>
                  {detail.reversalEntryId ? (
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">سند برگشت</dt>
                      <dd>
                        <Link
                          className="font-semibold text-primary underline-offset-4 hover:underline"
                          href={`${accountingSectionHref("entries")}?entryId=${encodeURIComponent(detail.reversalEntryId)}`}
                        >
                          مشاهده در دفتر روزنامه
                        </Link>
                      </dd>
                    </div>
                  ) : null}
                </>
              ) : null}
            </dl>

            {!detail.reversedAt && canReverse ? (
              reversing ? (
                <div className="space-y-3 rounded-xl border border-border p-3">
                  <p className="text-xs leading-5 text-muted-foreground">
                    ابطال این سند یک سند معکوس با تاریخ امروز ثبت می‌کند؛ سند اصلی حذف نمی‌شود.
                  </p>
                  <Field label="شرح ابطال (اختیاری)">
                    <input
                      className={inputClass}
                      value={reverseMemo}
                      onChange={(e) => setReverseMemo(e.target.value)}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <SecondaryButton onClick={() => setReversing(false)} disabled={busy}>انصراف</SecondaryButton>
                    <PrimaryButton onClick={submitReverse} disabled={busy}>
                      {busy ? "در حال ابطال…" : "تأیید ابطال"}
                    </PrimaryButton>
                  </div>
                </div>
              ) : (
                <SecondaryButton onClick={() => setReversing(true)}>ابطال سند</SecondaryButton>
              )
            ) : null}
          </>
        ) : null}
      </div>

      <footer className="shrink-0 border-t border-border px-4 py-4 sm:px-5">
        <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
      </footer>
    </OverlayDialog>
  );
}
