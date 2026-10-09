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
 *    overpayment so it cannot read as debt; A/P keeps the bare figure.
 *
 * Everything else — the fetch/retry/refresh wiring, the layouts, the aging
 * buckets, the overlays — is here, once.
 */

import { useEffect, useRef, useState } from "react";
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
  LoadingSkeleton,
  SectionCardSkeleton,
  cardClass,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { FilterChip } from "@/app/dashboard/filters";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { LedgerLoadFailed, OverlayDialog } from "./ledger-ui";
import { accountingSectionHref } from "./accounting-routes";

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

/** One line of a party's statement — a shared shape both endpoints already answer with. */
export interface SubledgerStatementLine {
  date: string;
  type: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
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

/** Who the statement overlay is open for — the three fields it needs. */
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
  /** The mobile summary under the aging list («جمع کل حساب‌های دریافتنی»). */
  agingTotalLabel: string;
  /** The header's link into the one people directory, filtered to this side. */
  directoryHref: string;
  directoryLinkLabel: string;
  /** Explanation shown when the unknown/unattributed bucket is present. */
  unknownExplanation?: string;

  // — data ———————————————————————————————————————————————————————————————
  /** The sentinel id of the unattributed bucket — it gets no actions and no links. */
  unknownKey: string;
  listEndpoint: string;
  agingEndpoint: string;
  /** Reads the list endpoint's payload as the rows the screen draws. */
  readParties: (data: unknown) => SubledgerPartyRow[];
  /** Reads the aging endpoint's payload as the report the screen draws. */
  readAging: (data: unknown) => SubledgerAgingReport;

  // — presentation switches ————————————————————————————————————————————
  /** Explicit meaning of a negative row (A/R customer credit or A/P supplier advance). */
  negativeBalanceLabel: string | null;
  /** A negative A/P balance is an advance, so the action/modal wording changes with it. */
  negativeSettleActionLabel?: string;
  negativeTitlePrefix?: string;
  negativeBalanceMessage?: string;

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

export function SubledgerSection({ side, canSettle = false }: { side: SubledgerSide; canSettle?: boolean }) {
  const money = useMoney();
  const [parties, setParties] = useState<SubledgerPartyRow[] | null>(null);
  const [partiesFailed, setPartiesFailed] = useState(false);
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

  useEffect(() => {
    let cancelled = false;
    setPartiesFailed(false);
    // A refetch keeps the list it already has (no skeleton flash between two
    // good loads), but shows the skeleton again when there is nothing to keep
    // — a retry after a failure must not flash «هیچ حسابی وجود ندارد» while
    // the request is still running.
    setParties((prev) => (prev && prev.length > 0 ? prev : null));
    api(side.listEndpoint).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) setParties(side.readParties(data));
      // Not `null` for ever: an unending skeleton claims the request is still
      // running. An empty list would claim there are no debts — say it failed.
      else {
        setParties([]);
        setPartiesFailed(true);
      }
    });
    // `api()` never rejects (it answers the synthetic «network_error»), but a
    // guard here costs nothing and keeps an endless skeleton impossible.
    return () => {
      cancelled = true;
    };
  }, [refreshKey, side]);

  useEffect(() => {
    if (view !== "aging") return;
    let cancelled = false;
    setAging(null);
    setAgingFailed(false);
    api(`${side.agingEndpoint}${asOfDate ? `?asOfDate=${asOfDate}` : ""}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) setAging(side.readAging(data));
      // Not an empty report: an aging fetch that fails must not fall into the
      // «هیچ بدهی بازی وجود ندارد» branch — a false claim.
      else setAgingFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [view, asOfDate, refreshKey, side]);

  if (!parties) {
    return <SectionCardSkeleton rows={4} />;
  }

  return (
    <section className="space-y-4">
      <div className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">{side.eyebrow}</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">{side.title}</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{side.description}</p>
            {side.unknownExplanation && parties.some((p) => p.id === side.unknownKey) ? (
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
              {partiesFailed ? (
                <LedgerLoadFailed message={side.loadBalancesFailed} onRetry={() => setRefreshKey((k) => k + 1)} />
              ) : parties.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">{side.emptyBalances}</p>
              ) : (
                <>
                  <DataTable caption={side.balancesCaption} className="hidden lg:block">
                    <DataTableHead>
                      <Th>{side.partyNoun}</Th>
                      <Th>تلفن</Th>
                      <Th numeric>مانده</Th>
                      <Th>اقدام</Th>
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
                          <Td>{p.id !== side.unknownKey && canSettle ? <button type="button" onClick={() => setSettleTarget(p)} className="inline-flex min-h-9 items-center justify-center rounded-lg px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20">{p.balance < 0 ? side.negativeSettleActionLabel ?? side.settle.actionLabel : side.settle.actionLabel}</button> : null}</Td>
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
                        {p.id !== side.unknownKey && canSettle ? <button type="button" onClick={() => setSettleTarget(p)} className="mt-3 min-h-11 w-full rounded-lg bg-amber-100 px-4 text-sm font-semibold text-amber-950 transition-colors hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/30">{p.balance < 0 ? side.negativeSettleActionLabel ?? side.settle.actionLabel : side.settle.actionLabel}</button> : null}
                      </article>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div>
              <AgingAsOfPicker asOfDate={asOfDate} onAsOfDateChange={setAsOfDate} report={aging} />
              {agingFailed ? (
                <LedgerLoadFailed message="بارگذاری نمای سنی بدهی‌ها ناموفق بود." onRetry={() => setRefreshKey((k) => k + 1)} />
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

      {settleTarget ? (
        <SubledgerSettleDialog
          side={side}
          party={settleTarget}
          onClose={() => setSettleTarget(null)}
          onDone={() => {
            setSettleTarget(null);
            setRefreshKey((k) => k + 1);
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
  locationName?: string | null;
  onClose: () => void;
}) {
  const money = useMoney();
  const [lines, setLines] = useState<SubledgerStatementLine[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLines(null);
    setFailed(false);
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
  const attributionLabel = (status: SubledgerStatementLine["attributionStatus"]) => {
    switch (status) {
      case "intentional_unknown": return "استثنای آگاهانه؛ بدون طرف معین";
      case "automatic_missing": return "خطای تطبیق؛ منبع خودکار بدون تأمین‌کننده";
      case "conditional_missing": return "نیازمند بررسی؛ انتساب مشروط پیدا نشد";
      case "unclassified": return "منبع هنوز در قرارداد انتساب دسته‌بندی نشده";
      default: return null;
    }
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
            tableClassName="min-w-[920px]"
          >
            <DataTableHead>
              <Th>تاریخ</Th>
              <Th>نوع</Th>
              <Th>منبع و سند</Th>
              <Th>شرح</Th>
              <Th numeric>بدهکار</Th>
              <Th numeric>بستانکار</Th>
              <Th numeric>مانده</Th>
            </DataTableHead>
            <DataTableBody>
              {lines.map((l, i) => (
                <DataTableRow key={i}>
                  <Td muted nowrap>{toPersianDigits(formatJalali(l.date))}</Td>
                  <Td muted>{typeLabel(l.type)}</Td>
                  <Td>
                    <div className="space-y-1 text-xs">
                      <p className="font-medium text-foreground">{ledgerSourceLabel(l.sourceType ?? l.type)}</p>
                      {l.locationName || l.supplierLocationName ? <p className="text-muted-foreground">شعبه: {l.locationName ?? l.supplierLocationName}</p> : null}
                      {attributionLabel(l.attributionStatus) ? <p className="text-amber-700 dark:text-amber-300">{attributionLabel(l.attributionStatus)}</p> : null}
                      {l.journalEntryId ? <Link className="inline-block font-semibold text-primary underline-offset-4 hover:underline" href={`${accountingSectionHref("entries")}?entryId=${encodeURIComponent(l.journalEntryId)}`}>مشاهدهٔ سند روزنامه</Link> : <span className="text-muted-foreground">شناسهٔ سند موجود نیست</span>}
                    </div>
                  </Td>
                  <Td>{l.description}</Td>
                  <Td numeric nowrap>{l.debit ? money.format(l.debit) : "—"}</Td>
                  <Td numeric nowrap>{l.credit ? money.format(l.credit) : "—"}</Td>
                  <Td numeric nowrap className="font-semibold">{money.format(l.balance)}</Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>

          <div className="space-y-3 lg:hidden">
            {lines.map((l, i) => (
              <article key={i} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</p>
                    <h4 className="mt-1 break-words font-semibold text-foreground">{l.description}</h4>
                  </div>
                  <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{typeLabel(l.type)}</span>
                </div>
                <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                  <p>{ledgerSourceLabel(l.sourceType ?? l.type)}{l.locationName || l.supplierLocationName ? ` — شعبه: ${l.locationName ?? l.supplierLocationName}` : ""}</p>
                  {attributionLabel(l.attributionStatus) ? <p className="font-medium text-amber-700 dark:text-amber-300">{attributionLabel(l.attributionStatus)}</p> : null}
                  {l.journalEntryId ? <Link className="inline-block font-semibold text-primary underline-offset-4 hover:underline" href={`${accountingSectionHref("entries")}?entryId=${encodeURIComponent(l.journalEntryId)}`}>مشاهدهٔ سند روزنامه</Link> : null}
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
              </article>
            ))}
          </div>
        </>
      )}
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
