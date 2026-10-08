"use client";

/**
 * «تطبیق بانکی و صندوق» — reconcile one settlement account against a statement.
 *
 * The work this screen supports: a person holds a bank statement (or has
 * counted the till), enters its closing balance, ticks the ledger lines the
 * statement also shows, and locks the period once the two agree exactly. What
 * is left unticked carries forward on its own — it is simply still unclaimed
 * next time (`reconciliation-service.ts`).
 *
 * The arithmetic is *not* restated here: `bank-reconciliation.ts` owns the sign
 * of a line and the definition of «مغایرت», and both this screen and the
 * service import it. That is what lets the running total update the instant a
 * box is ticked while still matching, to the rial, the number the server will
 * refuse to lock on.
 *
 * What a reconciliation screen owes its reader, and what this one now does:
 *
 *  - **Say which way the مغایرت points.** A bare «۱۲٬۰۰۰ تومان» does not say
 *    whether the bank is ahead or the books are. The read-out names it
 *    («کسری در دفاتر» / «اضافه در دفاتر») so the next step is obvious.
 *  - **Never lose a tick to a round-trip.** Every tick used to re-fetch the
 *    whole reconciliation, so on a slow connection the box stayed unticked and
 *    the totals lagged. Ticks are applied optimistically and rolled back with
 *    a message when the server disagrees.
 *  - **Only ever ask for one thing at a time.** «تکمیل و قفل» is disabled until
 *    the difference is zero, and says *why* it is disabled rather than sitting
 *    there greyed and mute.
 *  - **Stay usable when the ledger is big.** The candidate list is a paged
 *    window with a search and a «فقط تطبیق‌شده‌ها» filter, and «انتخاب همه»
 *    works on what is on screen through the batch endpoint — a year of card
 *    settlements is not one JSON body any more.
 *  - **Show a locked period as the record it is.** Every completed
 *    reconciliation opens into who locked it, when, from what opening balance,
 *    and the exact lines that balanced it.
 *  - **Draw no control the reader may not use.** Without
 *    `finance.reconciliation_manage` the screen is read-only: no checkboxes, no
 *    «تکمیل», no «حذف» — the APIs already answered 403, so a live-looking
 *    button was only a slower way of saying no.
 *  - **Be usable on a phone.** The table is a real table on a wide screen and
 *    real cards on a narrow one; the account switch scrolls instead of
 *    crushing three labels into a 320px row; every tap target clears 44px.
 */

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BanknoteIcon,
  CheckCheckIcon,
  ChevronDownIcon,
  CreditCardIcon,
  LandmarkIcon,
  LockIcon,
  Undo2Icon,
} from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, todayIsoDate } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import {
  api,
  ErrorBox,
  errorMessage,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  cardClass,
  EmptyState,
  LoadingSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  clearedTotalOf,
  computedBalanceOf,
  differenceOf,
  lineDelta,
  MAX_RECONCILIATION_LINE_BATCH,
  MAX_RECONCILIATION_LINES_PAGE,
} from "@/lib/bank-reconciliation";
import { FilterChip, SearchField } from "@/app/dashboard/filters";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

type AccountCode = "cash" | "bank" | "bankClearing";

/**
 * The three settlement accounts, matching `RECONCILABLE_ACCOUNTS` in
 * bank-reconciliation.ts. بانک is here because a cheque clears *into the
 * bank* (Phase 30) — a business taking cheques had movements on ۱۱۱۰ and no
 * way to reconcile the account this very screen is named after.
 */
const ACCOUNTS: { code: AccountCode; label: string; hint: string; icon: typeof BanknoteIcon }[] = [
  { code: "cash", label: "صندوق (نقدی)", hint: "حساب ۱۱۰۰", icon: BanknoteIcon },
  { code: "bank", label: "بانک", hint: "حساب ۱۱۱۰ — وصول چک و انتقال بانکی", icon: LandmarkIcon },
  { code: "bankClearing", label: "کارت‌خوان (در راه)", hint: "حساب ۱۱۲۰", icon: CreditCardIcon },
];

interface ReconciliationSummary {
  id: string;
  accountCode: AccountCode;
  statementDate: string;
  statementBalance: number;
  status: "in_progress" | "completed";
  completedAt: string | null;
  completedByName: string | null;
  createdBy: string | null;
  createdByName: string | null;
}

interface ReconciliationLine {
  journalLineId: string;
  entryId: string;
  entryDate: string;
  postedAt: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  reference: string | null;
  debit: number;
  credit: number;
  cleared: boolean;
}

interface ReconciliationDetail extends ReconciliationSummary {
  openingBalance: number;
  clearedTotal: number;
  computedBalance: number;
  difference: number;
  candidateCount: number;
  clearedCount: number;
  matchedCount: number;
  lines: ReconciliationLine[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

/**
 * A statement date in the future is refused by the server, so the form says so
 * before the click instead of after it.
 *
 * "Today" is Tehran's calendar day, not UTC's. `toISOString()` is still the
 * previous date until 03:30 local, so between midnight and half past three the
 * warning fired on a statement dated *today* — the single most likely date for
 * someone reconciling at close of business.
 */
function isFutureDate(iso: string): boolean {
  if (!iso) return false;
  return iso > todayIsoDate();
}

/** One «انتخاب همه» is several requests when the selection outruns the batch cap. */
function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
}

/** The optimistic correction between the server's last totals and the screen's. */
interface PendingTotals {
  amount: number;
  count: number;
}

const NO_PENDING: PendingTotals = { amount: 0, count: 0 };

export function ReconciliationSection({
  busy,
  run,
  canManage,
}: {
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;
  /**
   * Whether this member holds `finance.reconciliation_manage` — the capability
   * every mutating route behind this screen requires. `undefined` when the page
   * could not read the member's effective permissions; the controls are drawn
   * then and the API stays the gate, matching how the manual-entry review queue
   * treats the same gap.
   */
  canManage?: boolean;
}) {
  const money = useMoney();
  const manageable = canManage !== false;
  const [accountCode, setAccountCode] = useState<AccountCode>("cash");
  const [history, setHistory] = useState<ReconciliationSummary[] | null>(null);
  const [detail, setDetail] = useState<ReconciliationDetail | null>(null);
  /** Pages fetched by «نمایش بیشتر», appended to the first page's lines. */
  const [extraLines, setExtraLines] = useState<ReconciliationLine[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const [statementDate, setStatementDate] = useState("");
  const [statementBalance, setStatementBalance] = useState("");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [clearedOnly, setClearedOnly] = useState(false);

  const [loadFailed, setLoadFailed] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  /** Line ids with a tick in flight — each keeps its own spot disabled, not the whole table. */
  const [pendingLines, setPendingLines] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  /** Ticks the server has not confirmed yet, so the totals move with the click. */
  const [pendingTotals, setPendingTotals] = useState<PendingTotals>(NO_PENDING);

  /** Which completed reconciliation is open, and what its locked lines were. */
  const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);
  const [historyDetail, setHistoryDetail] = useState<Record<string, ReconciliationDetail>>({});
  const [historyFailed, setHistoryFailed] = useState(false);

  const activeAccount = ACCOUNTS.find((a) => a.code === accountCode)!;

  // A search is typed, not chosen: wait for the pause rather than sending a
  // request per keystroke, each of which would repaint the whole table.
  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setExtraLines([]);
    setHistory(null);
    setLoadFailed(false);
    setDetailFailed(false);
    setError("");
    setOpenHistoryId(null);
    setHistoryDetail({});
    setHistoryFailed(false);
    api<{ reconciliations: ReconciliationSummary[] }>(
      `/api/ledger/reconciliations?accountCode=${accountCode}`,
    ).then(({ ok, data }) => {
      // A stale response from the account we just switched away from must not
      // land on top of the new one — switching quickly between the three tabs
      // used to be able to show one account's history under another's heading.
      if (cancelled) return;
      // `ledger_account_missing` is the real case here: a chart of accounts
      // without ۱۱۱۰ cannot be reconciled, and an endless skeleton never said so.
      if (ok) setHistory(data.reconciliations);
      else {
        setLoadFailed(true);
        setError(errorMessage((data as { error?: string }).error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountCode, refreshKey]);

  const current = history?.find((r) => r.status === "in_progress") ?? null;
  const currentId = current?.id ?? null;

  /** The list query, shared by the first page and «نمایش بیشتر». */
  const linesUrl = useCallback(
    (id: string, nextCursor: string | null) => {
      const params = new URLSearchParams({ limit: String(MAX_RECONCILIATION_LINES_PAGE) });
      if (search) params.set("q", search);
      if (clearedOnly) params.set("cleared", "true");
      if (nextCursor) params.set("cursor", nextCursor);
      return `/api/ledger/reconciliations/${id}?${params.toString()}`;
    },
    [search, clearedOnly],
  );

  useEffect(() => {
    if (!currentId) {
      setDetail(null);
      setExtraLines([]);
      return;
    }
    let cancelled = false;
    setDetailFailed(false);
    setExtraLines([]);
    api<ReconciliationDetail>(linesUrl(currentId, null)).then(({ ok, data }) => {
      if (cancelled) return;
      // Without this the screen sat on a skeleton for ever when the detail
      // failed — indistinguishable from a slow network, with no way to retry.
      if (ok) {
        setDetail(data);
        setCursor(data.nextCursor);
        setPendingTotals(NO_PENDING);
      } else {
        setDetailFailed(true);
        setError(errorMessage((data as { error?: string }).error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentId, refreshKey, linesUrl]);

  /** The lines on screen: the first page, plus whatever «نمایش بیشتر» appended. */
  const visibleLines = useMemo(
    () => (detail ? [...detail.lines, ...extraLines] : []),
    [detail, extraLines],
  );

  /**
   * The header totals: the server's own, moved by whatever is ticked but not
   * yet confirmed.
   *
   * The server now sends the authoritative totals (it has to — the list is a
   * page, and a total over one page would make «مغایرت» depend on how far the
   * reader had scrolled). A tick still has to move the numbers instantly, so
   * the screen adds the tick's own signed delta until the next read replaces
   * it. Same `lineDelta`/`computedBalanceOf`/`differenceOf` the service uses, so
   * the optimistic number and the one the server will lock on cannot disagree.
   */
  const totals = useMemo(() => {
    if (!detail) return null;
    const clearedTotal = detail.clearedTotal + pendingTotals.amount;
    const computedBalance = computedBalanceOf(detail.openingBalance, clearedTotal);
    return {
      clearedTotal,
      computedBalance,
      difference: differenceOf(detail.statementBalance, computedBalance),
      clearedCount: detail.clearedCount + pendingTotals.count,
    };
  }, [detail, pendingTotals]);

  /** Flip lines on screen — the optimistic half of every tick. */
  const applyLines = useCallback((ids: ReadonlySet<string>, cleared: boolean) => {
    const flip = (line: ReconciliationLine) =>
      ids.has(line.journalLineId) ? { ...line, cleared } : line;
    setDetail((prev) => (prev ? { ...prev, lines: prev.lines.map(flip) } : prev));
    setExtraLines((prev) => prev.map(flip));
  }, []);

  const reload = useCallback(() => {
    setCursor(null);
    setExtraLines([]);
    setRefreshKey((k) => k + 1);
  }, []);

  async function startReconciliation() {
    setError("");
    if (!statementDate) return setError(errorMessage("statement_date_required"));
    if (isFutureDate(statementDate)) return setError(errorMessage("statement_date_in_future"));
    let rial: number;
    try {
      rial = money.parse(statementBalance || "0");
    } catch {
      return setError(errorMessage("invalid_amount"));
    }
    const ok = await run(() =>
      api("/api/ledger/reconciliations", {
        method: "POST",
        body: JSON.stringify({ accountCode, statementDate, statementBalance: rial }),
      }),
    );
    if (ok) {
      setStatementDate("");
      setStatementBalance("");
      setRefreshKey((k) => k + 1);
    }
  }

  /**
   * Tick or untick one line.
   *
   * Applied to local state first and reverted if the server refuses, so the
   * checkbox responds to the click rather than to the network. The previous
   * version awaited a PATCH *and* a full re-fetch before the box moved, which
   * on a slow link read as a dead control — and ticking twenty lines meant
   * twenty full reloads of the table.
   */
  const toggleLine = useCallback(
    async (line: ReconciliationLine, cleared: boolean) => {
      if (!currentId || line.cleared === cleared) return;
      const journalLineId = line.journalLineId;
      const amount = cleared ? lineDelta(line) : -lineDelta(line);
      setError("");
      setPendingLines((prev) => new Set(prev).add(journalLineId));
      applyLines(new Set([journalLineId]), cleared);
      setPendingTotals((prev) => ({
        amount: prev.amount + amount,
        count: prev.count + (cleared ? 1 : -1),
      }));

      const { ok, data } = await api(`/api/ledger/reconciliations/${currentId}/lines`, {
        method: "PATCH",
        body: JSON.stringify({ journalLineId, cleared }),
      });

      setPendingLines((prev) => {
        const next = new Set(prev);
        next.delete(journalLineId);
        return next;
      });

      if (!ok) {
        applyLines(new Set([journalLineId]), !cleared);
        setPendingTotals((prev) => ({
          amount: prev.amount - amount,
          count: prev.count + (cleared ? -1 : 1),
        }));
        setError(errorMessage((data as { error?: string }).error));
      }
    },
    [applyLines, currentId],
  );

  /**
   * Tick or untick everything on screen, in one request per batch.
   *
   * «انتخاب همه» used to be a burst of one PATCH per line — hundreds of
   * round-trips on a month of card settlements, each its own chance to fail
   * half-way and leave the reconciliation part-ticked. The batch endpoint does
   * it in one transaction; this is the UI half of that contract, chunked at the
   * cap the endpoint states, and re-reading the server whenever a chunk is
   * refused so the screen never shows a state the database does not have.
   */
  async function bulkToggle(lines: readonly ReconciliationLine[], cleared: boolean) {
    if (!currentId) return;
    const targets = lines.filter((line) => line.cleared !== cleared);
    if (targets.length === 0) return;
    const ids = new Set(targets.map((line) => line.journalLineId));
    const amount = targets.reduce(
      (sum, line) => sum + (cleared ? lineDelta(line) : -lineDelta(line)),
      0,
    );

    setError("");
    setBulkBusy(true);
    setPendingLines(ids);
    applyLines(ids, cleared);
    setPendingTotals((prev) => ({
      amount: prev.amount + amount,
      count: prev.count + (cleared ? targets.length : -targets.length),
    }));

    try {
      for (const chunk of chunked(targets.map((line) => line.journalLineId), MAX_RECONCILIATION_LINE_BATCH)) {
        const { ok, data } = await api(`/api/ledger/reconciliations/${currentId}/lines`, {
          method: "PATCH",
          body: JSON.stringify({ journalLineIds: chunk, cleared }),
        });
        if (!ok) {
          setError(errorMessage((data as { error?: string }).error));
          // A refused chunk may still have been preceded by an accepted one, so
          // the honest move is to ask the server what it holds rather than to
          // guess at rolling back a partial batch.
          reload();
          return;
        }
      }
    } finally {
      setPendingLines(new Set());
      setBulkBusy(false);
    }
  }

  async function loadMore() {
    if (!currentId || !cursor || loadingMore) return;
    setLoadingMore(true);
    const { ok, data } = await api<ReconciliationDetail>(linesUrl(currentId, cursor));
    setLoadingMore(false);
    if (!ok) {
      setError(errorMessage((data as unknown as { error?: string }).error));
      return;
    }
    // Appended, and de-duplicated: a line posted between the two reads would
    // otherwise appear twice under two keys.
    const seen = new Set(visibleLines.map((line) => line.journalLineId));
    setExtraLines((prev) => [...prev, ...data.lines.filter((line) => !seen.has(line.journalLineId))]);
    setCursor(data.nextCursor);
  }

  async function complete() {
    if (!detail) return;
    setError("");
    const ok = await run(() =>
      api(`/api/ledger/reconciliations/${detail.id}/complete`, { method: "POST" }),
    );
    if (ok) setRefreshKey((k) => k + 1);
  }

  /**
   * Discard an in-progress reconciliation.
   *
   * Confirmed first because it throws away the ticks already made — but it
   * only ever releases claims, never ledger data, and the lines simply return
   * to the candidate pool for the next attempt.
   */
  async function discard() {
    if (!detail) return;
    if (
      !window.confirm(
        "این تطبیق ناتمام حذف شود؟ اقلام تطبیق‌شده آزاد می‌شوند و می‌توانید تطبیق را از نو شروع کنید.",
      )
    ) {
      return;
    }
    setError("");
    const ok = await run(() =>
      api(`/api/ledger/reconciliations/${detail.id}`, { method: "DELETE" }),
    );
    if (ok) {
      setStatementDate("");
      setStatementBalance("");
      setRefreshKey((k) => k + 1);
    }
  }

  /**
   * Open a completed reconciliation's locked record.
   *
   * Fetched on demand: a business with three years of monthly reconciliations
   * should not pay for thirty line sets to look at one.
   */
  async function toggleHistory(id: string) {
    if (openHistoryId === id) {
      setOpenHistoryId(null);
      return;
    }
    setOpenHistoryId(id);
    if (historyDetail[id]) return;
    setHistoryFailed(false);
    const { ok, data } = await api<ReconciliationDetail>(
      `/api/ledger/reconciliations/${id}?limit=${MAX_RECONCILIATION_LINES_PAGE}&cleared=true`,
    );
    if (ok) setHistoryDetail((prev) => ({ ...prev, [id]: data }));
    else {
      setHistoryFailed(true);
      setError(errorMessage((data as { error?: string }).error));
    }
  }

  const completedHistory = history?.filter((r) => r.status === "completed") ?? [];
  const tickable = visibleLines.filter((line) => !line.cleared);
  const untickable = visibleLines.filter((line) => line.cleared);
  const futureStatement = isFutureDate(statementDate);

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className={cardClass}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کنترل وجوه</p>
              <h2 className="mt-1 text-base font-semibold text-foreground">تطبیق بانکی و صندوق</h2>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                مانده صورتحساب را با اقلام قابل تطبیق همان حساب مقایسه و در صورت برابری قفل کنید.
              </p>
            </div>
          </div>

          {/*
            Three labels never fit one 320px row: they used to wrap mid-word and
            the touch targets collapsed. The strip scrolls horizontally on a
            phone and lays out as three equal columns from `sm` up.
          */}
          <div
            role="group"
            aria-label="حساب قابل تطبیق"
            className="-mx-4 mt-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 sm:pb-0"
          >
            {ACCOUNTS.map((a) => {
              const isActive = accountCode === a.code;
              const Icon = a.icon;
              return (
                <FilterChip
                  key={a.code}
                  selected={isActive}
                  title={a.hint}
                  onClick={() => setAccountCode(a.code)}
                  className="flex min-h-12 snap-start items-center justify-center gap-2 sm:shrink"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="whitespace-nowrap">{a.label}</span>
                </FilterChip>
              );
            })}
          </div>
          {/* The account's ledger code, which was only ever in a `title` — invisible on a touch screen. */}
          <p className="mt-2 text-xs text-muted-foreground">{activeAccount.hint}</p>
        </div>

        <div className="p-4 sm:p-5">
          {!manageable ? (
            /*
              The APIs behind every control here require
              `finance.reconciliation_manage`; a member with only
              `ledger.view` could open the section and was handed buttons that
              answered 403. The screen says what it is instead.
            */
            <InfoBox>
              این بخش برای شما فقط خواندنی است؛ شروع، تطبیق اقلام و قفل کردن دوره به دسترسی «تطبیق
              بانکی» نیاز دارد.
            </InfoBox>
          ) : null}

          {loadFailed ? (
            <div className="space-y-3">
              <EmptyState>
                بارگذاری تطبیق‌های این حساب ناموفق بود؛ اگر حساب موردنظر در سرفصل حساب‌ها نیست، ابتدا آن را
                بررسی کنید.
              </EmptyState>
              <div className="max-w-xs">
                <SecondaryButton onClick={() => setRefreshKey((k) => k + 1)}>تلاش دوباره</SecondaryButton>
              </div>
            </div>
          ) : !history ? (
            <LoadingSkeleton rows={3} label="در حال بارگذاری تطبیق‌های حساب" />
          ) : !current ? (
            manageable ? (
              <div className="rounded-xl border border-border/80 bg-muted/60 p-4">
                <h3 className="text-sm font-semibold text-foreground">شروع تطبیق جدید</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  تاریخ پایان صورتحساب و مانده پایانی آن را وارد کنید. اقلام ثبت‌شده تا همان تاریخ برای تطبیق
                  نمایش داده می‌شوند.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-foreground">تاریخ صورتحساب</span>
                    <JalaliDatePicker value={statementDate} onChange={setStatementDate} placeholder="تاریخ" />
                    {futureStatement ? (
                      <span className="mt-1.5 block text-xs text-amber-700 dark:text-amber-300">
                        تاریخ در آینده است؛ تطبیق تنها تا تاریخ امروز قابل شروع است.
                      </span>
                    ) : null}
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-foreground">
                      مانده صورتحساب ({money.unitLabel})
                    </span>
                    {/*
                      A till and a card-reader float cannot hold less than
                      nothing, so the minus key is simply not offered there; a
                      bank account can be overdrawn, so ۱۱۱۰ keeps it.
                    */}
                    <PersianNumberInput
                      className={inputClass}
                      dir="ltr"
                      inputMode="numeric"
                      allowNegative={accountCode === "bank"}
                      value={statementBalance}
                      onChange={(e) => setStatementBalance(e.target.value)}
                      placeholder="۰"
                    />
                    <span className="mt-1.5 block text-xs text-muted-foreground">
                      {accountCode === "bank"
                        ? "مانده پایانی صورتحساب، نه گردش دوره. برای حساب بدهکار، مقدار منفی وارد کنید."
                        : "مانده پایانی صورتحساب، نه گردش دوره."}
                    </span>
                  </label>
                </div>
                <div className="mt-4 max-w-xs">
                  <PrimaryButton
                    onClick={startReconciliation}
                    disabled={busy || !statementDate || futureStatement}
                  >
                    {busy ? "در حال ثبت…" : "شروع تطبیق جدید"}
                  </PrimaryButton>
                </div>
              </div>
            ) : (
              <EmptyState>تطبیق بازی برای این حساب در جریان نیست.</EmptyState>
            )
          ) : detailFailed ? (
            <div className="space-y-3">
              <EmptyState>بارگذاری اقلام این تطبیق ناموفق بود.</EmptyState>
              <div className="max-w-xs">
                <SecondaryButton onClick={() => setRefreshKey((k) => k + 1)}>تلاش دوباره</SecondaryButton>
              </div>
            </div>
          ) : !detail || !totals ? (
            <LoadingSkeleton rows={4} label="در حال بارگذاری اقلام تطبیق" />
          ) : (
            <div className="space-y-4">
              {/* Which statement is being reconciled — the screen never said. */}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge tone="active">تطبیق باز</StatusBadge>
                <span>
                  صورتحساب تا تاریخ{" "}
                  <span className="font-medium text-foreground">
                    {toPersianDigits(formatJalali(detail.statementDate))}
                  </span>
                </span>
              </div>

              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-border/80 bg-muted/60 p-3">
                  <dt className="text-xs text-muted-foreground">مانده صورتحساب</dt>
                  <dd className="mt-1 font-bold text-foreground">{money.format(detail.statementBalance)}</dd>
                </div>
                <div className="rounded-xl border border-border/80 bg-muted/60 p-3">
                  <dt className="text-xs text-muted-foreground">مانده اول دوره</dt>
                  <dd className="mt-1 font-bold text-foreground">{money.format(detail.openingBalance)}</dd>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    از آخرین تطبیق قفل‌شدهٔ این حساب
                  </p>
                </div>
                <div className="rounded-xl border border-border/80 bg-muted/60 p-3">
                  <dt className="text-xs text-muted-foreground">جمع اقلام تطبیق‌شده</dt>
                  <dd className="mt-1 font-bold text-foreground">{money.format(totals.clearedTotal)}</dd>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    {toPersianDigits(totals.clearedCount)} از {toPersianDigits(detail.candidateCount)} قلم
                  </p>
                </div>
                <div
                  className={`rounded-xl border p-3 ${
                    totals.difference === 0
                      ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/10"
                      : "border-destructive/30 bg-destructive/5"
                  }`}
                >
                  <dt className="text-xs text-muted-foreground">مغایرت</dt>
                  <dd
                    aria-live="polite"
                    className={`mt-1 font-bold ${
                      totals.difference === 0
                        ? "text-emerald-700 dark:text-emerald-300"
                        : "text-destructive"
                    }`}
                  >
                    {money.format(Math.abs(totals.difference))}
                  </dd>
                  {/*
                    A signed number alone doesn't say which side is short. Naming
                    the direction is the difference between "there's a gap" and
                    "look for a deposit the books haven't recorded".
                  */}
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    {totals.difference === 0
                      ? "برابر است؛ آمادهٔ قفل کردن"
                      : totals.difference > 0
                        ? "صورتحساب بیشتر از دفاتر است؛ قلم ثبت‌نشده را بررسی کنید."
                        : "دفاتر بیشتر از صورتحساب است؛ قلم وصول‌نشده را بررسی کنید."}
                  </p>
                </div>
              </dl>

              {/*
                Search, filter and «انتخاب همه». A month of card settlements is
                hundreds of rows: without these the only way to find one
                settlement was to scroll, and the only way to tick them all was
                to click each one.
              */}
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <SearchField
                  className="lg:max-w-sm"
                  label="جستجو در اقلام قابل تطبیق"
                  placeholder="شرح، شماره چک یا شماره سند"
                  value={searchInput}
                  onChange={setSearchInput}
                />
                <FilterChip selected={clearedOnly} onClick={() => setClearedOnly((v) => !v)}>
                  فقط تطبیق‌شده‌ها
                </FilterChip>
                {manageable ? (
                  <div className="flex flex-wrap gap-2 lg:ms-auto">
                    <SecondaryButton
                      onClick={() => bulkToggle(tickable, true)}
                      disabled={busy || bulkBusy || tickable.length === 0}
                    >
                      <CheckCheckIcon aria-hidden="true" className="size-4" />
                      تطبیق همهٔ نمایان ({toPersianDigits(tickable.length)})
                    </SecondaryButton>
                    <SecondaryButton
                      onClick={() => bulkToggle(untickable, false)}
                      disabled={busy || bulkBusy || untickable.length === 0}
                    >
                      <Undo2Icon aria-hidden="true" className="size-4" />
                      لغو تطبیق نمایان‌ها ({toPersianDigits(untickable.length)})
                    </SecondaryButton>
                  </div>
                ) : null}
              </div>

              {/*
                What the batch about to be sent is worth, so «تطبیق همه» is a
                decision rather than a leap of faith: this is the same
                `clearedTotalOf` the server totals with, over exactly the lines
                the button will send.
              */}
              {manageable && tickable.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  جمع {toPersianDigits(tickable.length)} قلم نمایش‌داده‌شده:{" "}
                  <span className="font-medium text-foreground">{money.format(clearedTotalOf(tickable))}</span>
                </p>
              ) : null}

              {detail.matchedCount === 0 ? (
                <EmptyState>
                  {search || clearedOnly
                    ? "قلمی با این جستجو پیدا نشد؛ عبارت دیگری را امتحان کنید."
                    : "تا تاریخ این صورتحساب، قلم تطبیق‌نشده‌ای برای این حساب ثبت نشده است."}
                </EmptyState>
              ) : (
                <>
                  <DataTable
                    caption={`اقلام قابل تطبیق ${activeAccount.label} تا تاریخ ${toPersianDigits(formatJalali(detail.statementDate))}`}
                    className="hidden lg:block"
                  >
                    <DataTableHead>
                      {manageable ? <Th>تطبیق</Th> : null}
                      <Th>تاریخ</Th>
                      <Th>منبع</Th>
                      <Th>مرجع</Th>
                      <Th>شرح</Th>
                      <Th numeric>بدهکار</Th>
                      <Th numeric>بستانکار</Th>
                    </DataTableHead>
                    <DataTableBody>
                      {visibleLines.map((l) => (
                        <DataTableRow key={l.journalLineId} selected={l.cleared}>
                          {manageable ? (
                            <Td>
                              <input
                                type="checkbox"
                                className="size-5 accent-primary"
                                checked={l.cleared}
                                onChange={(e) => toggleLine(l, e.target.checked)}
                                disabled={pendingLines.has(l.journalLineId) || bulkBusy}
                                aria-label={`تطبیق ${l.memo ?? "سند"} به تاریخ ${toPersianDigits(
                                  formatJalali(l.entryDate),
                                )}`}
                              />
                            </Td>
                          ) : null}
                          <Td nowrap muted>
                            {toPersianDigits(formatJalali(l.entryDate))}
                          </Td>
                          <Td muted>
                            {ledgerSourceLabel(l.sourceType)}
                          </Td>
                          <Td muted nowrap>
                            {l.reference ? toPersianDigits(l.reference) : "—"}
                          </Td>
                          <Td>{l.memo ?? "—"}</Td>
                          <Td numeric nowrap>
                            {l.debit ? money.format(l.debit) : "—"}
                          </Td>
                          <Td numeric nowrap>
                            {l.credit ? money.format(l.credit) : "—"}
                          </Td>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>

                  <div className="space-y-3 lg:hidden">
                    {visibleLines.map((l) => (
                      <div
                        key={l.journalLineId}
                        className={`rounded-xl border p-4 transition-colors ${
                          l.cleared
                            ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10"
                            : "border-border/80 bg-muted/60"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          {manageable ? (
                            <input
                              type="checkbox"
                              checked={l.cleared}
                              onChange={(e) => toggleLine(l, e.target.checked)}
                              disabled={pendingLines.has(l.journalLineId) || bulkBusy}
                              className="mt-1 size-5 shrink-0 accent-primary"
                              aria-label={`تطبیق ${l.memo ?? "سند"} به تاریخ ${toPersianDigits(
                                formatJalali(l.entryDate),
                              )}`}
                            />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap justify-between gap-2">
                              <h3 className="text-sm font-semibold text-foreground">{l.memo ?? "—"}</h3>
                              <span className="text-xs text-muted-foreground">
                                {toPersianDigits(formatJalali(l.entryDate))}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {ledgerSourceLabel(l.sourceType)}
                              {l.reference ? ` — ${toPersianDigits(l.reference)}` : ""}
                            </p>
                            <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                              <div>
                                <dt className="text-xs text-muted-foreground">بدهکار</dt>
                                <dd className="mt-1 font-semibold text-foreground">
                                  {l.debit ? money.format(l.debit) : "—"}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-xs text-muted-foreground">بستانکار</dt>
                                <dd className="mt-1 font-semibold text-foreground">
                                  {l.credit ? money.format(l.credit) : "—"}
                                </dd>
                              </div>
                            </dl>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      {toPersianDigits(visibleLines.length)} از {toPersianDigits(detail.matchedCount)} قلم
                      نمایش داده شده است.
                    </span>
                    {cursor ? (
                      <SecondaryButton onClick={loadMore} disabled={loadingMore || bulkBusy}>
                        {loadingMore ? "در حال بارگذاری…" : "نمایش بیشتر"}
                      </SecondaryButton>
                    ) : null}
                  </div>
                </>
              )}

              {manageable ? (
                <div className="flex flex-col gap-2 border-t border-border/80 pt-4 sm:flex-row sm:items-center">
                  <div className="max-w-xs sm:w-64">
                    <PrimaryButton onClick={complete} disabled={busy || bulkBusy || totals.difference !== 0}>
                      {busy ? "در حال قفل کردن…" : "تکمیل و قفل کردن تطبیق"}
                    </PrimaryButton>
                  </div>
                  {/*
                    A disabled button that never says why is a dead end; this is the
                    one sentence that turns it into an instruction.
                  */}
                  <p className="text-xs leading-5 text-muted-foreground">
                    {totals.difference === 0
                      ? "پس از قفل شدن، اقلام تطبیق‌شده قابل تغییر نخواهند بود."
                      : "تا زمانی که مغایرت صفر نشود، امکان قفل کردن وجود ندارد."}
                  </p>
                  {/*
                    The way out of a typo. A statement balance cannot be edited and
                    only one reconciliation may be open per account, so without this
                    a mistyped closing balance wedged the account for good.
                  */}
                  <div className="sm:ms-auto">
                    <SecondaryButton onClick={discard} disabled={busy || bulkBusy}>
                      انصراف و حذف این تطبیق
                    </SecondaryButton>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {completedHistory.length > 0 ? (
        <div className={cardClass}>
          <header className="border-b border-border/80 px-4 py-4 sm:px-5">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">تاریخچه تطبیق‌ها</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              تطبیق‌های قفل‌شدهٔ {activeAccount.label}؛ اقلام آن‌ها دیگر قابل تغییر نیستند.
            </p>
          </header>
          <div className="p-4 sm:p-5">
            {historyFailed ? <ErrorBox>بارگذاری جزئیات تطبیق قفل‌شده ناموفق بود.</ErrorBox> : null}
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border/80 text-sm">
              {completedHistory.map((r) => {
                const open = openHistoryId === r.id;
                const record = historyDetail[r.id];
                return (
                  <li key={r.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => toggleHistory(r.id)}
                        aria-expanded={open}
                        className="flex min-w-0 items-center gap-2 text-start text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40"
                      >
                        <ChevronDownIcon
                          aria-hidden="true"
                          className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                            open ? "rotate-180" : ""
                          }`}
                        />
                        <LockIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                        <span>{toPersianDigits(formatJalali(r.statementDate))}</span>
                        {/*
                          Who signed the period off, and when: the two facts an
                          audit asks for and the history list never carried.
                        */}
                        <span className="text-xs text-muted-foreground">
                          {r.completedByName ? `قفل‌شده توسط ${r.completedByName}` : "قفل‌شده"}
                          {r.completedAt ? ` — ${toPersianDigits(formatJalali(r.completedAt, { withTime: true }))}` : ""}
                        </span>
                      </button>
                      <span className="font-bold text-foreground">{money.format(r.statementBalance)}</span>
                    </div>

                    {open ? (
                      <div className="border-t border-border/80 bg-muted/40 px-4 py-4">
                        {!record ? (
                          <LoadingSkeleton rows={2} label="در حال بارگذاری اقلام تطبیق قفل‌شده" />
                        ) : (
                          <div className="space-y-4">
                            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                              <div className="rounded-xl border border-border/80 bg-card p-3">
                                <dt className="text-xs text-muted-foreground">مانده اول دوره</dt>
                                <dd className="mt-1 font-bold text-foreground">
                                  {money.format(record.openingBalance)}
                                </dd>
                              </div>
                              <div className="rounded-xl border border-border/80 bg-card p-3">
                                <dt className="text-xs text-muted-foreground">جمع اقلام تطبیق‌شده</dt>
                                <dd className="mt-1 font-bold text-foreground">
                                  {money.format(record.clearedTotal)}
                                </dd>
                                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                                  {toPersianDigits(record.clearedCount)} قلم
                                </p>
                              </div>
                              <div className="rounded-xl border border-border/80 bg-card p-3">
                                <dt className="text-xs text-muted-foreground">مانده صورتحساب</dt>
                                <dd className="mt-1 font-bold text-foreground">
                                  {money.format(record.statementBalance)}
                                </dd>
                              </div>
                              <div className="rounded-xl border border-border/80 bg-card p-3">
                                <dt className="text-xs text-muted-foreground">شروع تطبیق</dt>
                                <dd className="mt-1 font-bold text-foreground">
                                  {record.createdByName ?? "—"}
                                </dd>
                              </div>
                            </dl>

                            {record.lines.length === 0 ? (
                              <EmptyState>قلم تطبیق‌شده‌ای برای این دوره ثبت نشده است.</EmptyState>
                            ) : (
                              <DataTable
                                caption={`اقلام قفل‌شدهٔ تطبیق ${toPersianDigits(formatJalali(r.statementDate))}`}
                                className="hidden lg:block"
                              >
                                <DataTableHead>
                                  <Th>تاریخ</Th>
                                  <Th>منبع</Th>
                                  <Th>مرجع</Th>
                                  <Th>شرح</Th>
                                  <Th numeric>بدهکار</Th>
                                  <Th numeric>بستانکار</Th>
                                </DataTableHead>
                                <DataTableBody>
                                  {record.lines.map((l) => (
                                    <DataTableRow key={l.journalLineId} selected>
                                      <Td nowrap muted>
                                        {toPersianDigits(formatJalali(l.entryDate))}
                                      </Td>
                                      <Td muted>{ledgerSourceLabel(l.sourceType)}</Td>
                                      <Td muted nowrap>
                                        {l.reference ? toPersianDigits(l.reference) : "—"}
                                      </Td>
                                      <Td>{l.memo ?? "—"}</Td>
                                      <Td numeric nowrap>
                                        {l.debit ? money.format(l.debit) : "—"}
                                      </Td>
                                      <Td numeric nowrap>
                                        {l.credit ? money.format(l.credit) : "—"}
                                      </Td>
                                    </DataTableRow>
                                  ))}
                                </DataTableBody>
                              </DataTable>
                            )}

                            {record.lines.length > 0 ? (
                              <ul className="space-y-2 lg:hidden">
                                {record.lines.map((l) => (
                                  <li
                                    key={l.journalLineId}
                                    className="rounded-xl border border-border/80 bg-card p-3 text-sm"
                                  >
                                    <div className="flex flex-wrap justify-between gap-2">
                                      <span className="font-semibold text-foreground">{l.memo ?? "—"}</span>
                                      <span className="text-xs text-muted-foreground">
                                        {toPersianDigits(formatJalali(l.entryDate))}
                                      </span>
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {ledgerSourceLabel(l.sourceType)}
                                      {l.reference ? ` — ${toPersianDigits(l.reference)}` : ""}
                                    </p>
                                    <p className="mt-2 text-xs text-muted-foreground">
                                      بدهکار {l.debit ? money.format(l.debit) : "—"} · بستانکار{" "}
                                      {l.credit ? money.format(l.credit) : "—"}
                                    </p>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
