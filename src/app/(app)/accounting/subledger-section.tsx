"use client";

/**
 * The one machinery behind the two subledger screens — «حساب‌های دریافتنی»
 * (A/R) and «حساب‌های پرداختنی» (A/P).
 *
 * The two screens were written as two files and stayed ~85% identical for
 * their whole lives: same balances list, same aging report with its «تا تاریخ»
 * picker, same statement overlay, same settle dialog — different nouns,
 * endpoints and payload keys. Copy-paste divergence was already showing: the
 * A/R list had a `.catch` on its fetch and the A/P one did not, the A/R aging
 * rows opened the statement and the A/P ones did not, and the A/P view chips
 * had no accessible group name. This module is that screen once; `ar-section`
 * and `ap-section` are now the two sides' words, endpoints and payload keys,
 * and nothing else.
 *
 * Three things this screen is deliberate about, because a subledger is read by
 * an accountant who will notice:
 *
 *  - **Capability is configuration.** `canSettle` comes in as a prop and is
 *    never derived here: A/R needs `finance.receivables_manage`, A/P needs
 *    `finance.payables_manage`, and a shared component that hard-coded either
 *    would be wrong for the other side — or, worse, silently permissive. The
 *    page is readable with `ledger.view` alone (auditors hold exactly that), so
 *    a member without the write permission sees no live «دریافت وجه» button to
 *    press and be refused by the API afterwards.
 *  - **The list is a window, not the book.** One page is fetched at a time,
 *    searched in SQL, and the totals above it come from the server's
 *    whole-subledger summary — so paging or searching can never change what
 *    the business is owed.
 *  - **A row can be opened.** Each statement line carries the identifiers of
 *    the record that caused it, so the panel links to a real destination (the
 *    order) or opens the journal entry itself, rather than guessing a URL out
 *    of a Persian sentence.
 *
 * What deliberately stays per-side (the `SubledgerSide` config):
 *
 *  - the **nouns** on screen («مشتری» / «تأمین‌کننده») and every sentence
 *    built from them;
 *  - the **endpoints** and how each response is read into the common row
 *    shapes (A/R keys a party by its `parties` id; A/P keys a supplier by its
 *    *branch alias* and carries the party id separately — which is why
 *    `partyId` exists and why the A/P aging rows, whose payload has no party
 *    id, open the statement without the directory link);
 *  - the settle **payload** (`customerId`+`receiptDate` vs
 *    `supplierId`+`paymentDate`);
 *  - whether a negative balance wears «بستانکار» — A/R marks an advance or
 *    overpayment so it cannot read as debt; A/P keeps the bare figure;
 *  - which source records have a destination of their own (an A/R line from an
 *    order can link to that order; an A/P line has no such screen).
 *
 * Everything else — the fetch/retry/refresh wiring, the search box, the
 * paging, the layouts, the aging buckets, the overlays — is here, once.
 */

import { SUBLEDGER_PAGE_SIZE } from "@/lib/subledger-pagination";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  api,
  ErrorBox,
  errorMessage,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import {
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCardSkeleton,
  cardClass,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { FilterChip, SearchField } from "@/app/dashboard/filters";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { LedgerLoadFailed, fmtJalali, OverlayDialog } from "./ledger-ui";

/**
 * How many balance rows one request asks for. Small enough that a tenant with
 * thousands of customers never ships the whole book to draw a screen, large
 * enough that a small shop's list is one page.
 */
const PAGE_SIZE = SUBLEDGER_PAGE_SIZE;

/** Typing settles before the request goes out — the same 250ms the voucher lists use. */
const SEARCH_DEBOUNCE_MS = 250;

/** One row of the balances list — the common shape both sides map their payloads into. */
export interface SubledgerPartyRow {
  /** The id the list and statement endpoints key the party by (A/R: the party id; A/P: the branch alias). */
  id: string;
  name: string;
  phone: string | null;
  balance: number;
  /**
   * The «اشخاص» record behind the row — what a deep link into the directory is
   * keyed by. Null when the payload does not carry one (A/P aging rows, the
   * unattributed bucket).
   */
  partyId: string | null;
  /** Branch alias/location label (A/P); absent for business-wide A/R parties. */
  locationName?: string | null;
}

/**
 * The whole-subledger totals the server computes beside the page.
 *
 * Deliberately not derived from the rows on screen: they are the subledger's
 * reconciliation with the control account, and a filter or a page must never
 * move them.
 */
export interface SubledgerSummary {
  /** What the parties owe the business (A/R) / what the business owes them (A/P), as a positive number. */
  primaryTotal: number;
  /** Advances and overpayments held, as a positive number. */
  advanceTotal: number;
  /** The two combined, signed the way the control account is. */
  netTotal: number;
  /** The control account's own balance, read from the same journal lines. */
  controlBalance: number;
  /** `netTotal − controlBalance`; zero when the subledger reconciles. */
  difference: number;
  reconciles: boolean;
}

/** The balances response as this screen reads it — one page plus the facts that must not change with it. */
export interface SubledgerBalancePage {
  nextOffset: number | null;
  rows: SubledgerPartyRow[];
  /** Rows the search matches, before the window — «۲۵ از ۳۱۰». */
  total: number;
  /** Null when the side's payload carried no summary (older endpoint). */
  summary: SubledgerSummary | null;
}

/** One row of the aging report, in the buckets the reference software uses. */
export interface SubledgerAgingRow {
  id: string;
  name: string;
  current: number;
  d31_60: number;
  d61_90: number;
  over90: number;
  total: number;
  /** The «اشخاص» record behind the row, when the payload carries one (null on A/P, whose aging names the alias only). */
  partyId: string | null;
  /** Branch alias/location label (A/P); absent for business-wide A/R rows. */
  locationName?: string | null;
}

/** The aging totals row — the buckets' sums, with no per-party fields. */
export interface SubledgerAgingTotals {
  current: number;
  d31_60: number;
  d61_90: number;
  over90: number;
  total: number;
}

export interface SubledgerAgingReport {
  asOfDate: string;
  rows: SubledgerAgingRow[];
  totals: SubledgerAgingTotals;
}

/**
 * The identifiers behind a statement line, as the source record itself reports
 * them — what a drill-down addresses, never a URL taken back out of a
 * description.
 */
export interface SubledgerStatementSource {
  /** The journal entry's own `sourceType` ('order', 'ar_receipt', 'cheque', 'purchase', …), or null for a manual entry. */
  type: string | null;
  /** The source row's id (the order, the receipt or the cheque). */
  id: string | null;
  /** A short label from the source record itself — «چک ۱۲۳۴۵ — بانک ملت». */
  label: string | null;
  /** The order behind the line, when there is one (A/R). */
  orderId?: string | null;
  /** The purchase behind the line, when there is one (A/P). */
  purchaseId?: string | null;
}

/** One line of a party's statement — a shared shape both endpoints answer with. */
export interface SubledgerStatementLine {
  /** The journal entry to open for this line, when the payload carries one. */
  entryId?: string;
  date: string;
  type: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  /** The source record's own label and identifiers (A/R shapes it; A/P answers flat fields). */
  source?: SubledgerStatementSource | null;
  /**
   * The A/P statement's flat references — same facts as `source`, in the shape
   * that endpoint answers with. The panel accepts either: `journalEntryId` is
   * read as `entryId`, `sourceType` names the source when no label came with
   * it, and the rest is context the A/P contract guarantees.
   */
  journalEntryId?: string;
  journalLineId?: string;
  sourceType?: string | null;
  sourceId?: string | null;
  purchaseId?: string | null;
  itemPurchaseId?: string | null;
  supplierReturnId?: string | null;
  itemSupplierReturnId?: string | null;
  paymentVoucherId?: string | null;
  chequeId?: string | null;
  installmentPlanId?: string | null;
  locationId?: string | null;
  locationName?: string | null;
  supplierLocationId?: string | null;
  supplierLocationName?: string | null;
  /** A/P attribution status; the side's config turns it into a sentence (or none). */
  attributionStatus?: "attributed" | "automatic_missing" | "conditional_missing" | "intentional_unknown" | "unclassified";
}

/** The aging buckets, in display order — the same five columns on both sides. */
const AGING_COLUMNS: { key: keyof SubledgerAgingTotals; label: string }[] = [
  { key: "current", label: "جاری (۰-۳۰ روز)" },
  { key: "d31_60", label: "۳۱-۶۰ روز" },
  { key: "d61_90", label: "۶۱-۹۰ روز" },
  { key: "over90", label: "بیش از ۹۰ روز" },
  { key: "total", label: "جمع" },
];

/** A party who paid ahead (advance or overpayment) has a *negative* balance; mark it, or it reads as debt. */
function CreditBadge({ label }: { label: string }) {
  return (
    <span className="ms-2 inline-block rounded-full bg-muted px-2.5 py-1 align-middle text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}

/** Who the statement overlay is open for — the four fields it needs. */
interface StatementTarget {
  id: string;
  name: string;
  partyId: string | null;
  locationName?: string | null;
}

/** What one side of the subledger is called, where it reads from, and how it posts. */
export interface SubledgerSide {
  // — wording ————————————————————————————————————————————————————————————
  eyebrow: string;
  title: string;
  description: string;
  /** The «who» column header and the noun captions are built around. */
  partyNoun: string;
  balancesCaption: string;
  agingCaption: string;
  emptyBalances: string;
  loadBalancesFailed: string;
  /** Shown when a *search* found nothing — different from «there are no open accounts». */
  noSearchMatches: string;
  /** The mobile summary under the aging list («جمع کل حساب‌های دریافتنی»). */
  agingTotalLabel: string;
  /** The header's link into the one people directory, filtered to this side. */
  directoryHref: string;
  directoryLinkLabel: string;
  searchLabel: string;
  /** Explanation shown when the unknown/unattributed bucket is present, if the side has one. */
  unknownExplanation?: string;

  // — data ———————————————————————————————————————————————————————————————
  /** The sentinel id of the unattributed bucket — it gets no actions and no links. */
  unknownKey: string;
  listEndpoint: string;
  agingEndpoint: string;
  /** Reads the list endpoint's payload as one page plus the totals beside it. */
  readBalances: (data: unknown) => SubledgerBalancePage;
  /** Reads the aging endpoint's payload as the report the screen draws. */
  readAging: (data: unknown) => SubledgerAgingReport;

  // — presentation switches ————————————————————————————————————————————
  /**
   * What a negative row is called (A/R: «بستانکار» — an advance must not read
   * as debt; A/P: a prepayment to the supplier). Null: no badge.
   */
  negativeBalanceLabel: string | null;
  /** The settle action's words when the balance is negative (A/P: «افزودن پیش‌پرداخت»). */
  negativeSettleActionLabel?: string;
  /** The dialog's title prefix for a negative balance (A/P: «پیش‌پرداخت به »). */
  negativeTitlePrefix?: string;
  /** The dialog's explanation of what a negative balance means on this side. */
  negativeBalanceMessage?: string;

  // — the reconciliation strip ————————————————————————————————————————
  summary: {
    primaryLabel: string;
    advanceLabel: string;
    netLabel: string;
    controlLabel: string;
    /** The control card's hint when the two agree. */
    reconciled: string;
    /** The control card's hint when they do not — the difference is appended. */
    difference: string;
  };

  // — the settle dialog («دریافت وجه» / «ثبت پرداخت») ————————————————————
  settle: {
    /** The row action's label. */
    actionLabel: string;
    headingId: string;
    endpoint: string;
    /** The payload's party field (`customerId` / `supplierId`). */
    idField: string;
    /** The payload's date field (`receiptDate` / `paymentDate`). */
    dateField: string;
    eyebrow: string;
    titlePrefix: string;
    methodLabel: string;
    dateLabel: string;
    submitLabel: string;
  };

  // — the statement overlay («صورتحساب») ————————————————————————————————
  statement: {
    headingId: string;
    endpointFor: (id: string) => string;
    /** Persian labels for the line types the endpoint reports. */
    typeLabels: Record<string, string>;
    caption: string;
    empty: string;
    failed: string;
    /** The directory link's words, and where it points for this row (null: no link). */
    directoryLabel: string;
    directoryHrefFor: (id: string, partyId: string | null) => string | null;
    /** The snapshot column's header — «منبع». */
    sourceColumnLabel: string;
    /** The label on the button that opens the line's journal entry. */
    entryLinkLabel: string;
    entryFailed: string;
    /** Turns an A/P attribution status into the sentence the panel shows beside the source. */
    attributionNoteFor?: (status: SubledgerStatementLine["attributionStatus"]) => string | null;
    /** Where a line's source record lives, when this side has a destination for it. */
    orderHrefFor?: (source: SubledgerStatementSource | null | undefined) => string | null;
    /** The order link's words, for the sides that have one. */
    orderLinkLabel?: string;
  };
}

/** The aging view's «تا تاریخ» — identical on both sides, so it lives here. */
function AgingAsOfPicker({
  asOfDate,
  onAsOfDateChange,
  report,
}: {
  asOfDate: string;
  onAsOfDateChange: (next: string) => void;
  report: SubledgerAgingReport | null;
}) {
  return (
    <div className="mb-4 grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-end">
      <label className="block">
        <span className="mb-1.5 block text-xs text-muted-foreground">نمای سنی تا تاریخ</span>
        <JalaliDatePicker value={asOfDate} onChange={onAsOfDateChange} placeholder="امروز" />
      </label>
      {report?.asOfDate ? (
        <p className="text-xs leading-6 text-muted-foreground">
          محاسبه‌شده تا {toPersianDigits(formatJalali(report.asOfDate))}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The subledger against its control account: what is owed, what is held, what
 * the two net to, and what the ledger itself says. Both numbers are shown even
 * though they are equal by construction — that is the point. An accountant
 * should be able to *see* the report reconcile rather than be told to trust it,
 * and a difference that has become possible is the cheapest early warning the
 * screen can give.
 */
function BalanceSummary({ side, summary }: { side: SubledgerSide; summary: SubledgerSummary }) {
  const money = useMoney();
  return (
    <KpiRow className="mb-4">
      <KpiCard label={side.summary.primaryLabel} value={money.format(summary.primaryTotal)} />
      <KpiCard label={side.summary.advanceLabel} value={money.format(summary.advanceTotal)} />
      <KpiCard label={side.summary.netLabel} value={money.format(summary.netTotal)} />
      <KpiCard
        label={side.summary.controlLabel}
        value={money.format(summary.controlBalance)}
        hint={
          summary.reconciles
            ? side.summary.reconciled
            : `${side.summary.difference}: ${money.format(summary.difference)}`
        }
      />
    </KpiRow>
  );
}

interface LedgerEntryDetail {
  id: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  postedAt: string;
  createdByName: string | null;
  reversesEntryId: string | null;
  lines: { id: string; accountCode: string; accountName: string; debit: number; credit: number }[];
}

/**
 * The journal entry behind one statement line — «what was actually posted».
 *
 * A receipt, a cheque movement or a closed-order amendment has no screen of
 * its own, so this is where a statement line becomes a document an accountant
 * can read: the accounts, the sides, the memo, and who posted it. Fetched when
 * opened (never with the statement), so a long statement does not pay for
 * lines nobody drills into.
 */
function StatementEntryDetail({ entryId, failedMessage, onClose }: { entryId: string; failedMessage: string; onClose: () => void }) {
  const money = useMoney();
  const [entry, setEntry] = useState<LedgerEntryDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setFailed(false);
    api<{ entry?: LedgerEntryDetail }>(`/api/ledger/entries/${entryId}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok && data.entry) setEntry(data.entry);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [entryId, reloadKey]);

  return (
    <OverlayDialog
      headingId="statement-entry-heading"
      onClose={onClose}
      className={`${overlayPanelClass} max-h-[88vh] w-full max-w-2xl overflow-y-auto p-4 sm:p-5`}
    >
      <header className="mb-3 flex items-start justify-between gap-2">
        <h3 id="statement-entry-heading" className="font-semibold text-foreground">سند حسابداری</h3>
        <SecondaryButton onClick={onClose}>بستن سند</SecondaryButton>
      </header>
      {failed ? <LedgerLoadFailed message={failedMessage} onRetry={() => setReloadKey((k) => k + 1)} /> : !entry ? <LoadingSkeleton rows={2} /> : <>
      <p className="font-semibold text-foreground">
        {fmtJalali(entry.entryDate)}
        {entry.reversesEntryId ? <span className="ms-2 text-xs font-medium text-amber-700 dark:text-amber-300">سند برگشتی</span> : null}
      </p>
      <p className="mt-1 text-xs leading-6 text-muted-foreground">
        {entry.memo || "بدون شرح"}
        {entry.createdByName ? ` — ثبت: ${entry.createdByName}` : ""}
      </p>
      <dl className="mt-2 grid gap-1.5">
        {entry.lines.map((line) => (
          <div key={line.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-1.5">
            <dt className="min-w-0 text-xs text-muted-foreground sm:text-sm">
              <span className="tabular-nums">{toPersianDigits(line.accountCode)}</span> — {line.accountName}
            </dt>
            <dd className="shrink-0 whitespace-nowrap text-xs font-semibold tabular-nums text-foreground sm:text-sm">
              {line.debit ? `بدهکار ${money.format(line.debit)}` : `بستانکار ${money.format(line.credit)}`}
            </dd>
          </div>
        ))}
      </dl>
      </>}
    </OverlayDialog>
  );
}

export function SubledgerSection({ side, canSettle }: { side: SubledgerSide; canSettle: boolean }) {
  const money = useMoney();
  const [parties, setParties] = useState<SubledgerPartyRow[] | null>(null);
  const [partiesTotal, setPartiesTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [summary, setSummary] = useState<SubledgerSummary | null>(null);
  const [partiesFailed, setPartiesFailed] = useState(false);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [view, setView] = useState<"balances" | "aging">("balances");
  const [aging, setAging] = useState<SubledgerAgingReport | null>(null);
  const [agingFailed, setAgingFailed] = useState(false);
  const [statementTarget, setStatementTarget] = useState<StatementTarget | null>(null);
  const [settleTarget, setSettleTarget] = useState<SubledgerPartyRow | null>(null);
  // Bumped by a successful settlement and by either «تلاش دوباره» — one key,
  // both refetches, so a retry never leaves one of the two views stale.
  const [refreshKey, setRefreshKey] = useState(0);
  // «تا تاریخ» — the aging report's as-of date. The endpoint has always
  // accepted one and answered with the date it used; the picker is what lets
  // an accountant ask what the ageing looked like at a period end.
  const [asOfDate, setAsOfDate] = useState("");
  const [search, setSearch] = useState("");
  // A generation owns replacement + its pages. Only that generation may
  // finish either loading state; invalidation releases the old page's state.
  const balanceSeq = useRef(0);
  const loadedSeq = useRef<number | null>(null);
  const pageOwner = useRef<object | null>(null);
  const agingSeq = useRef(0);
  const invalidateBalances = () => {
    balanceSeq.current += 1;
    loadedSeq.current = null;
    pageOwner.current = null;
    setLoadingMore(false);
  };
  const refresh = () => {
    invalidateBalances();
    setRefreshKey((k) => k + 1);
  };

  useEffect(() => {
    const seq = ++balanceSeq.current;
    const controller = new AbortController();
    loadedSeq.current = null;
    pageOwner.current = null;
    setLoadingMore(false);
    setPartiesFailed(false);
    setLoadMoreFailed(false);
    setLoadingBalances(true);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: "0" });
    const query = search.trim();
    if (query) params.set("q", query);
    // Invalidate immediately, including the debounce interval. Old rows remain
    // readable, but cannot supply an offset for a replacement query.
    const timer = setTimeout(() => {
      api(`${side.listEndpoint}?${params.toString()}`, { signal: controller.signal }).then(({ ok, data }) => {
        if (balanceSeq.current !== seq) return;
        setLoadingBalances(false);
        if (ok) {
          const page = side.readBalances(data);
          loadedSeq.current = seq;
          setParties(page.rows);
          setPartiesTotal(page.total);
          setNextOffset(page.nextOffset);
          setSummary(page.summary);
        } else {
          setParties((prev) => prev ?? []);
          setPartiesFailed(true);
        }
      });
    }, query ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (balanceSeq.current === seq) balanceSeq.current += 1;
      pageOwner.current = null;
    };
  }, [refreshKey, search, side]);

  useEffect(() => {
    if (view !== "aging") return;
    const seq = ++agingSeq.current;
    setAging(null);
    setAgingFailed(false);
    api(`${side.agingEndpoint}${asOfDate ? `?asOfDate=${asOfDate}` : ""}`).then(({ ok, data }) => {
      if (agingSeq.current !== seq) return;
      if (ok) setAging(side.readAging(data));
      // Not an empty report: an aging fetch that fails must not fall into the
      // «هیچ بدهی بازی وجود ندارد» branch — a false claim.
      else setAgingFailed(true);
    });
  }, [view, asOfDate, refreshKey, side]);

  /** One more page, appended to what is on screen — the table never blanks while it loads. */
  const loadMore = useCallback(() => {
    const seq = balanceSeq.current;
    if (loadedSeq.current !== seq || pageOwner.current || loadingBalances || nextOffset === null) return;
    const owner = {};
    pageOwner.current = owner;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) });
    if (search.trim()) params.set("q", search.trim());
    api(`${side.listEndpoint}?${params.toString()}`).then(({ ok, data }) => {
      if (balanceSeq.current !== seq || pageOwner.current !== owner) return;
      pageOwner.current = null;
      setLoadingMore(false);
      if (!ok) {
        setLoadMoreFailed(true);
        return;
      }
      const page = side.readBalances(data);
      setParties((prev) => {
        const existing = prev ?? [];
        const seen = new Set(existing.map((row) => row.id));
        return [...existing, ...page.rows.filter((row) => !seen.has(row.id))];
      });
      setNextOffset(page.nextOffset);
      setPartiesTotal(page.total);
      setSummary(page.summary);
    });
  }, [search, nextOffset, loadingBalances, side]);

  if (!parties && loadingBalances) {
    return <SectionCardSkeleton rows={4} />;
  }

  const hasMore = nextOffset !== null;

  return (
    <section className="space-y-4">
      <div className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">{side.eyebrow}</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">{side.title}</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{side.description}</p>
            {side.unknownExplanation && parties?.some((p) => p.id === side.unknownKey) ? (
              <p className="mt-3 max-w-3xl rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                {side.unknownExplanation}
              </p>
            ) : null}
          </div>
          <div className="flex min-w-full flex-col items-stretch gap-2 sm:min-w-0 sm:items-end">
            {/* The one directory, filtered to the people this screen is about. */}
            <Link
              href={side.directoryHref}
              className="inline-flex min-h-10 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-primary transition-colors hover:bg-muted/60 dark:hover:bg-stone-800/40"
            >
              {side.directoryLinkLabel}
            </Link>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label={`نمای ${side.title}`}>
              <FilterChip selected={view === "balances"} onClick={() => setView("balances")} className="min-h-12 w-full">مانده حساب‌ها</FilterChip>
              <FilterChip selected={view === "aging"} onClick={() => setView("aging")} className="min-h-12 w-full">نمای سنی بدهی‌ها</FilterChip>
            </div>
          </div>
        </div>

        <div className="p-4 sm:p-5">
          {view === "balances" ? (
            <div>
              {summary ? <BalanceSummary side={side} summary={summary} /> : null}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <SearchField
                  value={search}
                  onChange={(value) => { if (value !== search) { invalidateBalances(); setSearch(value); } }}
                  label={side.searchLabel}
                  placeholder={`${side.searchLabel}…`}
                  className="w-full sm:w-64"
                />
                {parties && partiesTotal > 0 ? (
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {toPersianDigits(parties.length)} از {toPersianDigits(partiesTotal)} {side.partyNoun}
                    {loadingBalances ? " — در حال به‌روزرسانی…" : ""}
                  </p>
                ) : null}
              </div>
              {partiesFailed && (parties?.length ?? 0) === 0 ? (
                <LedgerLoadFailed message={side.loadBalancesFailed} onRetry={refresh} />
              ) : parties && parties.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  {search.trim() ? side.noSearchMatches : side.emptyBalances}
                </p>
              ) : parties ? (
                <>
                  {/* A failed *refresh* keeps the rows it had and says so above them. */}
                  {partiesFailed ? (
                    <div className="mb-3">
                      <LedgerLoadFailed message={side.loadBalancesFailed} onRetry={refresh} />
                    </div>
                  ) : null}
                  <DataTable caption={side.balancesCaption} className="hidden lg:block">
                    <DataTableHead>
                      <Th>{side.partyNoun}</Th>
                      <Th>تلفن</Th>
                      <Th numeric>مانده</Th>
                      {canSettle ? <Th>اقدام</Th> : null}
                    </DataTableHead>
                    <DataTableBody>
                      {parties.map((p) => (
                        <DataTableRow key={p.id}>
                          <Td>
                            <div className="min-w-0">
                              <button type="button" onClick={() => setStatementTarget(p)} className="font-semibold text-foreground hover:text-amber-700 hover:underline dark:hover:text-amber-300">{p.name}</button>
                              {p.locationName ? <p className="mt-1 text-xs text-muted-foreground">شعبهٔ {p.locationName}</p> : null}
                            </div>
                          </Td>
                          <Td muted>{p.phone ? toPersianDigits(p.phone) : "—"}</Td>
                          <Td numeric nowrap className="font-bold">{money.format(p.balance)}{p.balance < 0 && side.negativeBalanceLabel ? <CreditBadge label={side.negativeBalanceLabel} /> : null}</Td>
                          {canSettle ? (
                            <Td>
                              {p.id !== side.unknownKey ? (
                                <button type="button" onClick={() => setSettleTarget(p)} className="inline-flex min-h-9 items-center justify-center rounded-lg px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20">{p.balance < 0 ? side.negativeSettleActionLabel ?? side.settle.actionLabel : side.settle.actionLabel}</button>
                              ) : null}
                            </Td>
                          ) : null}
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                  <div className="space-y-3 lg:hidden">
                    {parties.map((p) => (
                      <article key={p.id} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <button type="button" onClick={() => setStatementTarget(p)} className="truncate text-right font-bold text-foreground hover:text-amber-700 dark:hover:text-amber-300">{p.name}</button>
                            <p className="mt-1 text-xs text-muted-foreground">{p.phone ? toPersianDigits(p.phone) : "شماره‌ای ثبت نشده"}</p>
                            {p.locationName ? <p className="mt-1 text-xs font-medium text-muted-foreground">شعبهٔ {p.locationName}</p> : null}
                          </div>
                          <span className="whitespace-nowrap font-bold text-foreground">{money.format(p.balance)}</span>
                        </div>
                        {p.balance < 0 && side.negativeBalanceLabel ? <div className="mt-2"><CreditBadge label={side.negativeBalanceLabel} /></div> : null}
                        {canSettle && p.id !== side.unknownKey ? (
                          <button type="button" onClick={() => setSettleTarget(p)} className="mt-3 min-h-11 w-full rounded-lg bg-amber-100 px-4 text-sm font-semibold text-amber-950 transition-colors hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/30">{p.balance < 0 ? side.negativeSettleActionLabel ?? side.settle.actionLabel : side.settle.actionLabel}</button>
                        ) : null}
                      </article>
                    ))}
                  </div>
                  {hasMore || loadMoreFailed ? (
                    <div className="mt-4 flex flex-col items-center gap-2">
                      {loadMoreFailed ? (
                        <p role="alert" className="text-xs text-destructive">
                          بارگذاری بخش بعدی ناموفق بود؛ نگران نباشید، ردیف‌های نمایش‌داده‌شده هنوز معتبرند.
                        </p>
                      ) : null}
                      <SecondaryButton onClick={loadMore} disabled={loadingMore || loadingBalances || loadedSeq.current !== balanceSeq.current}>
                        {loadingMore ? "در حال بارگذاری…" : "نمایش موارد بیشتر"}
                      </SecondaryButton>
                    </div>
                  ) : null}
                </>
              ) : (
                <SectionCardSkeleton rows={4} />
              )}
            </div>
          ) : (
            <div>
              <AgingAsOfPicker asOfDate={asOfDate} onAsOfDateChange={setAsOfDate} report={aging} />
              {agingFailed ? (
                <LedgerLoadFailed message="بارگذاری نمای سنی بدهی‌ها ناموفق بود." onRetry={refresh} />
              ) : !aging ? (
                <LoadingSkeleton rows={3} />
              ) : aging.rows.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">هیچ بدهی بازی (تا تاریخ انتخابی) وجود ندارد.</p>
              ) : (
                <>
                  <DataTable caption={side.agingCaption} className="hidden lg:block">
                    <DataTableHead>
                      <Th>{side.partyNoun}</Th>
                      {AGING_COLUMNS.map((col) => <Th key={col.key} numeric>{col.label}</Th>)}
                    </DataTableHead>
                    <DataTableBody>
                      {aging.rows.map((r) => (
                        <DataTableRow key={r.id}>
                          <Td>
                            <button type="button" onClick={() => setStatementTarget(r)} className="font-medium text-foreground hover:text-amber-700 hover:underline dark:hover:text-amber-300">{r.name}</button>
                            {r.locationName ? <p className="mt-1 text-xs text-muted-foreground">شعبهٔ {r.locationName}</p> : null}
                            {r.total < 0 && side.negativeBalanceLabel ? <div className="mt-1"><CreditBadge label={side.negativeBalanceLabel} /></div> : null}
                          </Td>
                          {AGING_COLUMNS.map((col) => (
                            <Td key={col.key} numeric nowrap className={col.key === "total" ? "font-bold" : undefined}>{r[col.key] ? money.format(r[col.key]) : "—"}</Td>
                          ))}
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                    <DataTableFoot>
                      <tr>
                        <Td>جمع کل</Td>
                        {AGING_COLUMNS.map((col) => <Td key={col.key} numeric nowrap className="font-bold">{money.format(aging.totals[col.key])}</Td>)}
                      </tr>
                    </DataTableFoot>
                  </DataTable>
                  <div className="space-y-3 lg:hidden">
                    {aging.rows.map((r) => (
                      <article key={r.id} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><button type="button" onClick={() => setStatementTarget(r)} className="truncate text-right text-sm font-semibold text-foreground hover:text-amber-700 dark:hover:text-amber-300">{r.name}</button>{r.locationName ? <p className="mt-1 text-xs text-muted-foreground">شعبهٔ {r.locationName}</p> : null}{r.total < 0 && side.negativeBalanceLabel ? <div className="mt-1"><CreditBadge label={side.negativeBalanceLabel} /></div> : null}</div><span className="shrink-0 whitespace-nowrap font-bold text-foreground">{money.format(r.total)}</span></div>
                        <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                          {AGING_COLUMNS.filter((col) => col.key !== "total").map((col) => <div key={col.key}><dt className="text-xs text-muted-foreground">{col.label}</dt><dd className="mt-1 font-semibold text-foreground">{r[col.key] ? money.format(r[col.key]) : "—"}</dd></div>)}
                        </dl>
                      </article>
                    ))}
                    <dl className="rounded-xl border border-border/80 bg-muted/60 p-4"><dt className="text-sm text-muted-foreground">{side.agingTotalLabel}</dt><dd className="mt-1 text-lg font-bold text-foreground">{money.format(aging.totals.total)}</dd></dl>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {statementTarget ? (
        <SubledgerStatementPanel
          side={side}
          id={statementTarget.id}
          name={statementTarget.name}
          partyId={statementTarget.partyId}
          locationName={statementTarget.locationName}
          onClose={() => setStatementTarget(null)}
        />
      ) : null}

      {/* No write capability, no dialog: the only way to open it is a row action that is not drawn. */}
      {canSettle && settleTarget ? (
        <SubledgerSettleDialog
          side={side}
          party={settleTarget}
          onClose={() => setSettleTarget(null)}
          onDone={() => {
            setSettleTarget(null);
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}

/** One party's full subledger activity with a running balance — «what makes up this number». */
export function SubledgerStatementPanel({
  side,
  id,
  name,
  partyId,
  locationName,
  onClose,
}: {
  side: SubledgerSide;
  /** The id the side's statement endpoint keys the party by (A/R: party id; A/P: branch alias). */
  id: string;
  name: string;
  /** The «اشخاص» record behind the row, when the caller knows it — the directory link's key. */
  partyId: string | null;
  /** Branch/location context, when the row is a per-branch A/P alias. */
  locationName?: string | null;
  onClose: () => void;
}) {
  const money = useMoney();
  const [lines, setLines] = useState<SubledgerStatementLine[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // One entry overlay serves both responsive layouts. Keep the line and its
  // stable journal ID together, without mounting/fetching two hidden details.
  const [openLine, setOpenLine] = useState<{ index: number; entryId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLines(null);
    setFailed(false);
    setOpenLine(null);
    api(side.statement.endpointFor(id))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) setLines((data as { lines?: SubledgerStatementLine[] }).lines ?? []);
        // Without the failed flag the panel sat on its skeleton for ever — a
        // failed load and a slow one were indistinguishable.
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey, side]);

  const directoryHref = side.statement.directoryHrefFor(id, partyId);
  const typeLabel = (type: string) => side.statement.typeLabels[type] ?? type;
  /**
   * Everything a line can be resolved to, whichever shape its endpoint uses:
   * A/R answers a `source` object, A/P answers flat references and an
   * attribution status. One reader here means the table, the mobile card and
   * either side all show the same thing for the same line.
   */
  const sourceOf = (line: SubledgerStatementLine) => {
    const entryId = line.entryId ?? line.journalEntryId ?? null;
    const label =
      line.source?.label ??
      (line.sourceType ? ledgerSourceLabel(line.sourceType) : null) ??
      null;
    const location = line.locationName ?? line.supplierLocationName ?? null;
    const note = side.statement.attributionNoteFor?.(line.attributionStatus) ?? null;
    const orderHref = side.statement.orderHrefFor?.(line.source) ?? null;
    return { entryId, label, location, note, orderHref };
  };

  return (
    <OverlayDialog
      headingId={side.statement.headingId}
      onClose={onClose}
      className={`${overlayPanelClass} max-h-[88vh] w-full max-w-3xl overflow-y-auto p-4 sm:max-h-[80vh] sm:p-5`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">جزئیات حساب</p>
          <h3 id={side.statement.headingId} className="mt-1 break-words text-lg font-bold">صورتحساب {name}</h3>
          {locationName ? <p className="mt-1 text-xs text-muted-foreground">شعبهٔ {locationName}</p> : null}
          {/*
            The party's file in the one directory, with its accounting code,
            tax and balance. Hidden for unattributed lines, which belong to no
            party record and would link nowhere — and for the A/P aging rows,
            whose payload names the branch alias but not the party behind it.
          */}
          {directoryHref ? (
            <Link
              href={directoryHref}
              className="mt-1 inline-block text-xs font-semibold text-primary underline-offset-4 hover:underline"
            >
              {side.statement.directoryLabel}
            </Link>
          ) : null}
        </div>
        <button type="button" onClick={onClose} className="shrink-0 rounded-lg border border-border px-3 py-1 text-sm font-medium text-muted-foreground">
          بستن
        </button>
      </header>

      {failed ? (
        <LedgerLoadFailed message={side.statement.failed} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : lines === null ? (
        <LoadingSkeleton rows={3} />
      ) : lines.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {side.statement.empty}
        </p>
      ) : (
        <>
          <DataTable
            caption={side.statement.caption}
            className="hidden lg:block"
            tableClassName="min-w-[820px]"
          >
            <DataTableHead>
              <Th>تاریخ</Th>
              <Th>نوع</Th>
              <Th>شرح</Th>
              <Th>{side.statement.sourceColumnLabel}</Th>
              <Th numeric>بدهکار</Th>
              <Th numeric>بستانکار</Th>
              <Th numeric>مانده</Th>
            </DataTableHead>
            <DataTableBody>
              {lines.map((l, i) => {
                const { entryId, label, location, note, orderHref } = sourceOf(l);
                return (
                  <DataTableRow key={`line-${i}`}>
                    <Td muted nowrap>{fmtJalali(l.date)}</Td>
                    <Td muted>{typeLabel(l.type)}</Td>
                    <Td>{l.description}</Td>
                    <Td>
                      <div className="space-y-1 text-xs">
                        <p className="font-medium text-foreground">{label ?? "—"}</p>
                        {location ? <p className="text-muted-foreground">شعبه: {location}</p> : null}
                        {note ? <p className="font-medium text-amber-700 dark:text-amber-300">{note}</p> : null}
                        <div className="flex flex-wrap items-center gap-2">
                          {orderHref ? (
                            <Link href={orderHref} className="font-semibold text-primary underline-offset-4 hover:underline">
                              {side.statement.orderLinkLabel ?? "مشاهده"}
                            </Link>
                          ) : null}
                          {entryId ? (
                            <button
                              type="button"
                              aria-haspopup="dialog"
                              aria-expanded={openLine?.index === i}
                              onClick={() => setOpenLine(openLine?.index === i ? null : { index: i, entryId })}
                              className="rounded-lg border border-border px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted"
                            >
                              {side.statement.entryLinkLabel}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </Td>
                    <Td numeric nowrap>{l.debit ? money.format(l.debit) : "—"}</Td>
                    <Td numeric nowrap>{l.credit ? money.format(l.credit) : "—"}</Td>
                    <Td numeric nowrap className="font-semibold">{money.format(l.balance)}</Td>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>

          <div className="space-y-3 lg:hidden">
            {lines.map((l, i) => {
              const { entryId, label, location, note, orderHref } = sourceOf(l);
              return (
                <article key={i} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">{fmtJalali(l.date)}</p>
                      <h4 className="mt-1 break-words font-semibold text-foreground">{l.description}</h4>
                    </div>
                    <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{typeLabel(l.type)}</span>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-sm">
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">بدهکار</dt>
                      <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums text-foreground">{l.debit ? money.format(l.debit) : "—"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">بستانکار</dt>
                      <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums text-foreground">{l.credit ? money.format(l.credit) : "—"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">مانده</dt>
                      <dd className="mt-1 whitespace-nowrap font-bold tabular-nums text-foreground">{money.format(l.balance)}</dd>
                    </div>
                  </dl>
                  {label || location || note || orderHref || entryId ? (
                    <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
                      {label ? <p className="text-muted-foreground">{label}</p> : null}
                      {location ? <p className="text-muted-foreground">شعبه: {location}</p> : null}
                      {note ? <p className="font-medium text-amber-700 dark:text-amber-300">{note}</p> : null}
                      <div className="flex flex-wrap items-center gap-2">
                        {orderHref ? (
                          <Link href={orderHref} className="font-semibold text-primary underline-offset-4 hover:underline">
                            {side.statement.orderLinkLabel ?? "مشاهده"}
                          </Link>
                        ) : null}
                        {entryId ? (
                          <button
                            type="button"
                            aria-haspopup="dialog"
                              aria-expanded={openLine?.index === i}
                            onClick={() => setOpenLine(openLine?.index === i ? null : { index: i, entryId })}
                            className="rounded-lg border border-border px-2 py-1 font-semibold text-muted-foreground"
                          >
                            {side.statement.entryLinkLabel}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                </article>
              );
            })}
          </div>
        </>
      )}
      {openLine ? <StatementEntryDetail
        key={openLine.entryId}
        entryId={openLine.entryId}
        failedMessage={side.statement.entryFailed}
        onClose={() => setOpenLine(null)}
      /> : null}
    </OverlayDialog>
  );
}

/** «دریافت وجه» / «ثبت پرداخت» — settle one party's balance from the list. */
function SubledgerSettleDialog({
  side,
  party,
  onClose,
  onDone,
}: {
  side: SubledgerSide;
  party: SubledgerPartyRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const money = useMoney();
  const [amount, setAmount] = useState(String(money.toInput(Math.max(party.balance, 0)) || ""));
  const [method, setMethod] = useState<"cash" | "bank">("cash");
  // The date is optional, Shamsi. The «دریافت و پرداخت» voucher form has
  // always been able to back-date one; settling from this screen silently
  // posted *today*, and a receipt taken yesterday had to be re-entered there.
  const [settleDate, setSettleDate] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /*
   * The idempotency key for this intent, kept across a failed attempt: the A/P
   * payments endpoint dedupes on it, so a user who retries after a timeout
   * does not post the same payment twice. A changed intent (a different
   * amount, method, date or memo) is a different payment and gets a new key.
   */
  const requestKeyRef = useRef<{ intent: string; key: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
    const memoValue = memo.trim() || undefined;
    let clientRequestId: string | undefined;
    if (side.settle.idField === "supplierId") {
      const intent = JSON.stringify({ supplierId: party.id, amount: rial, method, paymentDate: settleDate || null, memo: memoValue ?? null });
      if (requestKeyRef.current?.intent !== intent) {
        const key = globalThis.crypto?.randomUUID?.() ?? `ap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        requestKeyRef.current = { intent, key };
      }
      clientRequestId = requestKeyRef.current.key;
    }
    /*
     * The dialog posts for itself and shows the failure *here*. Routing it
     * through the workspace-level `run` would put the ErrorBox behind this
     * overlay's scrim — a refused settlement (a locked fiscal period, a
     * missing ledger account) would leave a busy-looking dialog and an error
     * nobody could see.
     */
    let result: { ok: boolean; data: { error?: string } };
    try {
      result = await api(side.settle.endpoint, {
        method: "POST",
        body: JSON.stringify({
          [side.settle.idField]: party.id,
          amount: rial,
          method,
          [side.settle.dateField]: settleDate || undefined,
          memo: memoValue,
          ...(clientRequestId ? { clientRequestId } : {}),
        }),
      });
    } catch {
      setBusy(false);
      setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
      return;
    }
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data.error));
      return;
    }
    onDone();
  }

  return (
    <OverlayDialog
      headingId={side.settle.headingId}
      onClose={onClose}
      dismissible={!busy}
      className={`${overlayPanelClass} w-full max-w-md p-4 sm:p-5`}
    >
      <form onSubmit={submit}>
        <header className="mb-4 border-b border-border pb-4">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">{side.settle.eyebrow}</p>
          <h3 id={side.settle.headingId} className="mt-1 text-lg font-bold">{party.balance < 0 ? side.negativeTitlePrefix ?? side.settle.titlePrefix : side.settle.titlePrefix}{party.name}</h3>
          {party.locationName ? <p className="mt-1 text-xs text-muted-foreground">شعبهٔ {party.locationName}</p> : null}
          {/* The number this settlement is measured against; the pre-filled
              amount already references it, so keep it on screen after the
              user edits the field. */}
          <p className="mt-1 text-sm text-muted-foreground">مانده فعلی: <span className="font-semibold text-foreground">{money.format(party.balance)}</span>{party.balance < 0 && side.negativeBalanceLabel ? <CreditBadge label={side.negativeBalanceLabel} /> : null}</p>
          {party.balance < 0 && side.negativeBalanceMessage ? <p className="mt-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">{side.negativeBalanceMessage}</p> : null}
        </header>
        <ErrorBox>{error}</ErrorBox>
        <Field label={`مبلغ (${money.unitLabel})`}>
          <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="۰" />
        </Field>
        <div>
          <p className="mb-1 text-sm font-medium text-foreground">{side.settle.methodLabel}</p>
          <div className="flex gap-2">
            <FilterChip dense selected={method === "cash"} onClick={() => setMethod("cash")}>نقدی</FilterChip>
            <FilterChip dense selected={method === "bank"} onClick={() => setMethod("bank")}>بانکی</FilterChip>
          </div>
        </div>
        <Field label={side.settle.dateLabel}>
          <JalaliDatePicker value={settleDate} onChange={setSettleDate} placeholder="امروز" />
        </Field>
        <Field label="شرح (اختیاری)">
          <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={busy}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={busy}>
            {busy ? "در حال ثبت…" : side.settle.submitLabel}
          </PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}
