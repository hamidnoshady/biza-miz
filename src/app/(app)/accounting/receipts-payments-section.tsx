"use client";

import {
  EmptyState,
  SectionCardSkeleton,
  cardClass,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { useEffect, useRef, useState } from "react";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ArrowDownLeftIcon, ArrowUpRightIcon, DownloadIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { FilterChip } from "@/app/dashboard/filters";
import { fmtJalali, OverlayDialog } from "./ledger-ui";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { VoucherFormFields, useIdempotencyKey } from "./settlement-form";
import { voucherReference } from "@/lib/voucher-shared";
import { VOUCHER_METHOD_LABELS, type VoucherMethod } from "@/lib/payables-input";
import Link from "next/link";
import { accountingSectionHref } from "./accounting-routes";

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
  canManageReceivables,
  canManagePayables,
  canReversePayments,
  canReverseReceipts,
}: {
  /**
   * Whether this member may record receipts / payments
   * (finance.receivables_manage / finance.payables_manage) or approve a
   * correction (ledger.approve). `undefined` when the page could not read
   * the member's effective permissions; the ثبت buttons then draw and the
   * API stays the gate, matching how the manual-entry queue treats the
   * same gap. The correction buttons stay hidden until approval is known.
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
  /*
   * Responses race each other — a fast «علی» search easily outruns the slow
   * unfiltered listing it was typed over, and without the token the *older*
   * answer wins the setState and the screen shows rows that match nothing the
   * user asked for. Only the latest request may write state.
   */
  const requestSeq = useRef(0);
  /*
   * The register API projects stored row columns; `reversed` is derived, not
   * stored, so every fetch normalizes it before the rows reach state.
   */
  function normalizeRow(row: Voucher): Voucher {
    return { ...row, reversed: row.reversedAt !== null };
  }
  const prevSide = useRef<Side>(side);

  const canCreate = side === "receipts" ? canManageReceivables !== false : canManagePayables !== false;

  function listUrl(cursor?: string | null): string {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (methodFilter !== "all") params.set("method", methodFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();
    const base = side === "receipts" ? "/api/ledger/ar/receipts" : "/api/ledger/ap/payments";
    return query ? `${base}?${query}` : base;
  }

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
    }
    const seq = ++requestSeq.current;
    const run = () => {
      setLoading(true);
      api<{ receipts?: Voucher[]; payments?: Voucher[]; nextCursor?: string | null; hasMore?: boolean; error?: string }>(
        listUrl(),
      )
        .then(({ ok, data }) => {
          if (requestSeq.current !== seq) return;
          if (ok) {
            setRows((data.receipts ?? data.payments ?? []).map(normalizeRow));
            setNextCursor(data.nextCursor ?? null);
            setHasMore(data.hasMore ?? false);
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
    // listUrl closes over the filter state; listing every dep keeps the lint
    // rule honest without re-running on an unstable function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, q, methodFilter, statusFilter, refreshKey]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const { ok, data } = await api<{
        receipts?: Voucher[];
        payments?: Voucher[];
        nextCursor?: string | null;
        hasMore?: boolean;
        error?: string;
      }>(listUrl(nextCursor));
      if (requestSeq.current !== seq) return;
      if (ok) {
        setRows((prev) => [...(prev ?? []), ...(data.receipts ?? data.payments ?? []).map(normalizeRow)]);
        setNextCursor(data.nextCursor ?? null);
        setHasMore(data.hasMore ?? false);
      } else {
        setError(errorMessage(data.error));
      }
    } finally {
      if (requestSeq.current === seq) setLoadingMore(false);
    }
  }

  /*
   * The export is server-rendered: the visible page is a window into the
   * history, and exporting it would silently drop every voucher outside the
   * window. The API honors the same filters and sanitizes formula-leading
   * cells, so a memo starting with «=» cannot become a spreadsheet formula.
   */
  function downloadCsv() {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (methodFilter !== "all") params.set("method", methodFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    params.set("format", "csv");
    const base = side === "receipts" ? "/api/ledger/ar/receipts" : "/api/ledger/ap/payments";
    const a = document.createElement("a");
    a.href = `${base}?${params.toString()}`;
    a.download = side === "receipts" ? "receipts.csv" : "payments.csv";
    document.body.append(a);
    a.click();
    a.remove();
  }

  function refresh() {
    setSelectedId(null);
    setRefreshKey((k) => k + 1);
  }


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
              onClick={downloadCsv}
              disabled={!rows || rows.length === 0}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            >
              <DownloadIcon aria-hidden="true" className="size-4" />
              دانلود
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
  const idempotencyKey = useIdempotencyKey();
  const requestKeyRef = useRef<{ intent: string; key: string } | null>(null);

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
    const memoValue = memo.trim() || undefined;
    const bankReferenceValue = bankReference.trim() || undefined;
    const common = {
      amount: rial,
      method,
      memo: memoValue,
      cashAccountId: cashAccountId || undefined,
      bankReference: bankReferenceValue,
    };
    let body: Record<string, string | number | undefined>;
    if (side === "receipts") {
      body = { ...common, customerId: partyId, receiptDate: date || undefined, idempotencyKey };
    } else {
      // One request key belongs to one intended A/P transfer and survives a
      // retry after an ambiguous network result. Any material edit rotates it.
      const intent = JSON.stringify({
        supplierId: partyId,
        amount: rial,
        method,
        paymentDate: date || null,
        memo: memoValue ?? null,
        cashAccountId: cashAccountId || null,
        bankReference: bankReferenceValue ? toLatinDigits(bankReferenceValue).trim() : null,
      });
      if (requestKeyRef.current?.intent !== intent) {
        const key = globalThis.crypto?.randomUUID?.() ?? `ap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        requestKeyRef.current = { intent, key };
      }
      body = { ...common, supplierId: partyId, paymentDate: date || undefined, clientRequestId: requestKeyRef.current.key };
    }
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
  customerName?: string;
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
                <dd className="font-semibold">{partyName}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">مبلغ</dt>
                <dd className="font-bold">{money.format(detail.amount)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">روش</dt>
                <dd>{methodText(detail)}</dd>
              </div>
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
