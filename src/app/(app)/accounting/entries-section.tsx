"use client";

/**
 * «دفتر روزنامه» — the general journal.
 *
 * A journal is a book an accountant *scans*, so this screen is a compact
 * one-row-per-document list that opens on demand, not a page of full-size
 * cards each carrying a whole table. The old shape rendered every document's
 * every line up front, and on a phone every *line* became another card: fine
 * for the twelve entries a demo has, unreadable and expensive at real volume.
 * Lines and audit metadata live in the row's detail panel now.
 *
 * What this screen is careful about, and why:
 *
 *  - **Money is never a JS `number`.** `journal_lines.debit/credit` are
 *    PostgreSQL BIGINT and arrive as strings; the old code ran them through
 *    `Number(...)` and summed the document that way, which silently rounds
 *    past 2^53 rial. Everything here stays a decimal string and renders
 *    through `money.formatText`.
 *  - **The reversal button follows `ledger.approve`.** The API always
 *    required it; the button did not, so a manager saw a live destructive
 *    accounting control and learned otherwise from a 403. And it opens a
 *    confirmation dialog rather than posting immediately — a reversal is a
 *    new permanent document, not an undo.
 *  - **Filters live in the URL.** A filtered journal is a link somebody can
 *    send, a bookmark, and a Back button that returns to the slice you were
 *    reading. Refinement uses `replace`, so leaving the screen is one press.
 *  - **Pagination is keyset.** «نمایش اسناد قدیمی‌تر» sends the last
 *    document's ordering tuple, not `OFFSET n`, so a posting made while
 *    somebody reads page one can no longer duplicate or skip a row.
 *  - **The count never lies.** The server returns the filter's real total;
 *    the old copy printed the number of *loaded* rows as «۱۰۰ سند در این
 *    فیلتر».
 *  - **A failed filter list is visible.** When the pickers cannot load, the
 *    screen says so and offers a retry instead of silently showing «همهٔ
 *    منابع» as though the business had no sources.
 *
 * The rules themselves are framework-free in `journal-view.ts` (and
 * `@/lib/journal-filters.ts`, shared with the API), which is where they are
 * tested.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDownIcon, DownloadIcon } from "lucide-react";
import { SectionCardSkeleton, StatusBadge, cardClass } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { api, ErrorBox, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import { accountingSectionHref } from "./accounting-routes";
import type { AccountRow } from "./accounting-manager";
import { JournalReversalDialog } from "./journal-reversal-dialog";
import {
  EMPTY_JOURNAL_FILTERS,
  activeJournalFilterCount,
  canReverseJournalEntry,
  hasActiveJournalFilters,
  journalCountLabel,
  journalCounterpartEntryId,
  journalErrorMessage,
  journalFilterParams,
  journalFiltersFromParams,
  journalDetailId,
  journalReversalBadge,
  journalRowId,
  amountToRialText,
  rialTextToAmountInput,
  type JournalEntryView,
  type JournalFilterState,
} from "./journal-view";
import { JOURNAL_EXPORT_ROW_CAP } from "@/lib/journal-filters";

interface JournalPageResponse {
  entries: JournalEntryView[];
  hasMore: boolean;
  nextCursor: string | null;
  totalCount: number | null;
  error?: string;
}

interface FilterOptions {
  sourceTypes: string[];
  locations: { id: string; name: string }[];
  creators: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}

const NO_OPTIONS: FilterOptions = { sourceTypes: [], locations: [], creators: [], projects: [] };

const REVERSAL_STATE_OPTIONS = [
  { value: "any", label: "همه" },
  { value: "none", label: "بدون برگشت" },
  { value: "reversed", label: "برگشت‌خورده" },
  { value: "reversal", label: "سند برگشتی" },
];

const ENTRY_KIND_OPTIONS = [
  { value: "any", label: "همه" },
  { value: "manual", label: "اسناد دستی" },
  { value: "system", label: "اسناد سیستمی" },
];

export function EntriesSection({
  refreshKey,
  busy,
  accounts,
  canApprove,
  onRefresh,
}: {
  refreshKey: number;
  busy: boolean;
  /** The chart of accounts the workspace already loaded — the «حساب» filter picks from it rather than fetching it twice. */
  accounts: AccountRow[];
  /** `ledger.approve`. `undefined` when the page could not read the member's permissions; the API stays the gate. */
  canApprove: boolean | undefined;
  /** Ask the workspace to reload after a reversal, so every other ledger section sees it too. */
  onRefresh: () => void;
}) {
  const money = useMoney();
  const router = useRouter();
  const searchParams = useSearchParams();

  const filters = useMemo(
    () => journalFiltersFromParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const filtersKey = journalFilterParams(filters).toString();
  const filtered = hasActiveJournalFilters(filters);
  const activeCount = activeJournalFilterCount(filters);

  const [entries, setEntries] = useState<JournalEntryView[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const [options, setOptions] = useState<FilterOptions>(NO_OPTIONS);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [optionsKey, setOptionsKey] = useState(0);

  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [reversing, setReversing] = useState<JournalEntryView | null>(null);
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [notice, setNotice] = useState("");

  /** `?entry=` — the document a reversal link (or a link from elsewhere) is pointing at. */
  const focusEntryId = searchParams.get("entry");

  // ---------------------------------------------------------------- filters
  const writeFilters = useCallback(
    (next: JournalFilterState, opts: { keepFocus?: boolean } = {}) => {
      const params = journalFilterParams(next);
      if (opts.keepFocus && focusEntryId) params.set("entry", focusEntryId);
      const queryString = params.toString();
      // `replace`, not `push`: refining a filter is reading one screen, and it
      // must not cost five back presses to leave the journal.
      router.replace(
        queryString ? `${accountingSectionHref("entries")}?${queryString}` : accountingSectionHref("entries"),
        { scroll: false },
      );
    },
    [focusEntryId, router],
  );

  const setFilter = useCallback(
    <K extends keyof JournalFilterState>(key: K, value: JournalFilterState[K]) => {
      writeFilters({ ...filters, [key]: value });
    },
    [filters, writeFilters],
  );

  /*
   * The search box is typed into, so it keeps a local draft and lands in the
   * URL on a debounce. Without that, every keystroke would be a history entry
   * and a request; with it, the URL still ends up carrying the search, so the
   * filtered view stays shareable.
   */
  const [qDraft, setQDraft] = useState(filters.q);
  const qDraftRef = useRef(filters.q);
  useEffect(() => {
    // An external change (Back, a shared link, «پاک کردن فیلترها») wins over
    // the draft; a draft the reader is still typing does not get reset by the
    // URL write it caused itself.
    if (filters.q !== qDraftRef.current) {
      qDraftRef.current = filters.q;
      setQDraft(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    if (qDraft === filters.q) return;
    const timer = setTimeout(() => {
      qDraftRef.current = qDraft;
      writeFilters({ ...filters, q: qDraft });
    }, 300);
    return () => clearTimeout(timer);
  }, [qDraft, filters, writeFilters]);

  // ------------------------------------------------------------ filter list
  useEffect(() => {
    let cancelled = false;
    setOptionsFailed(false);
    void api<FilterOptions>("/api/ledger/entries/filters").then(({ ok, data, aborted }) => {
      if (cancelled || aborted) return;
      if (ok) {
        setOptions({
          sourceTypes: data.sourceTypes ?? [],
          locations: data.locations ?? [],
          creators: data.creators ?? [],
          projects: data.projects ?? [],
        });
      } else {
        // Silence here was indistinguishable from «این کسب‌وکار هیچ منبعی
        // ندارد» — a claim rather than a failure.
        setOptions(NO_OPTIONS);
        setOptionsFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, optionsKey]);

  // ------------------------------------------------------------------- list
  const load = useCallback(
    async (cursor: string | null) => {
      const params = new URLSearchParams(filtersKey);
      if (cursor) params.set("cursor", cursor);
      const currentRequest = ++requestId.current;
      setError("");
      if (cursor) setLoadingMore(true);
      const { ok, data, aborted } = await api<JournalPageResponse>(`/api/ledger/entries?${params}`);
      if (aborted || currentRequest !== requestId.current) return;
      if (ok) {
        setEntries((previous) => (cursor && previous ? [...previous, ...data.entries] : data.entries));
        setHasMore(!!data.hasMore);
        setNextCursor(data.nextCursor ?? null);
        // Only the first page carries a count; a «بیشتر» response must not
        // wipe the total the screen is already showing.
        if (!cursor) setTotalCount(data.totalCount ?? null);
      } else {
        setError(journalErrorMessage(data.error));
      }
      if (cursor) setLoadingMore(false);
    },
    [filtersKey],
  );

  useEffect(() => {
    // Invalidate any in-flight request the moment the filter changes: results
    // for the previous query must not flash into the new filter's state.
    requestId.current += 1;
    setEntries(null);
    setHasMore(false);
    setNextCursor(null);
    setTotalCount(null);
    setLoadingMore(false);
    void load(null);
  }, [load, refreshKey]);

  // --------------------------------------------- original ⇄ reversal walking
  const openEntry = useCallback(
    (entryId: string) => {
      setExpanded((previous) => new Set(previous).add(entryId));
      const params = new URLSearchParams(filtersKey);
      params.set("entry", entryId);
      router.replace(`${accountingSectionHref("entries")}?${params}`, { scroll: false });
    },
    [filtersKey, router],
  );

  const [announced, setAnnounced] = useState<string | null>(null);
  useEffect(() => {
    if (!focusEntryId || !entries) return;
    if (announced === focusEntryId) return;
    const found = entries.some((entry) => entry.id === focusEntryId);
    setAnnounced(focusEntryId);
    if (found) {
      setExpanded((previous) => new Set(previous).add(focusEntryId));
      // The linked document may be several pages down; scrolling is best
      // effort, and the amber highlight is what actually locates it.
      requestAnimationFrame(() =>
        document
          .getElementById(journalRowId(focusEntryId))
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
      setNotice("");
    } else {
      setNotice(
        "سند مرتبط در این بازه یا با این فیلترها نیست؛ فیلترها را پاک کنید تا آن را ببینید.",
      );
    }
  }, [announced, entries, focusEntryId]);

  // ----------------------------------------------------------------- export
  async function exportJournal(format: "csv" | "xlsx") {
    setExporting(format);
    setError("");
    setNotice("");
    try {
      const params = new URLSearchParams(filtersKey);
      params.set("format", format);
      const res = await fetch(`/api/ledger/entries?${params}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(journalErrorMessage(data.error));
        return;
      }
      if (res.headers.get("X-Journal-Export-Truncated")) {
        setNotice(
          `خروجی به ${toPersianDigits(JOURNAL_EXPORT_ROW_CAP)} سند محدود شد؛ بازهٔ تاریخ را کوچک‌تر کنید.`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `journal.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("خطا در دریافت خروجی دفتر روزنامه.");
    } finally {
      setExporting(null);
    }
  }

  // ------------------------------------------------------------------ parts
  const accountOptions = useMemo(
    () => [
      { value: "", label: "همهٔ حساب‌ها" },
      ...accounts.map((account) => ({
        value: account.id,
        label: `${account.code} ${account.name}`,
        searchString: `${account.code} ${account.name}`,
      })),
    ],
    [accounts],
  );

  function toggleExpanded(entryId: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  const countLabel = journalCountLabel({
    loaded: entries?.length ?? 0,
    totalCount,
    hasMore,
    filtered,
  });

  return (
    <div className="space-y-4">
      <section className={cardClass}>
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دفاتر مالی</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">دفتر روزنامه</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              همهٔ اسناد خودکار و دستی به ترتیب تاریخ سند. روی هر سطر بزنید تا ردیف‌ها و اطلاعات
              ممیزی آن باز شود؛ برگشت فقط برای اسناد دستیِ برگشت‌نخورده و با دسترسی «تأیید سند».
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton
              onClick={() => void exportJournal("csv")}
              disabled={exporting !== null || !entries || entries.length === 0}
            >
              <DownloadIcon aria-hidden="true" className="size-4" />
              {exporting === "csv" ? "در حال تهیه…" : "خروجی CSV"}
            </SecondaryButton>
            <SecondaryButton
              onClick={() => void exportJournal("xlsx")}
              disabled={exporting !== null || !entries || entries.length === 0}
            >
              <DownloadIcon aria-hidden="true" className="size-4" />
              {exporting === "xlsx" ? "در حال تهیه…" : "خروجی اکسل"}
            </SecondaryButton>
          </div>
        </header>

        <div className="border-b border-border/80 p-4 sm:p-5">
          <div className="grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 lg:grid-cols-4 lg:items-end">
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">از تاریخ</span>
              <JalaliDatePicker
                value={filters.dateFrom}
                onChange={(iso) => setFilter("dateFrom", iso)}
                placeholder="از ابتدا"
                ariaLabel="از تاریخ"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">تا تاریخ</span>
              <JalaliDatePicker
                value={filters.dateTo}
                onChange={(iso) => setFilter("dateTo", iso)}
                placeholder="تا امروز"
                ariaLabel="تا تاریخ"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">منبع سند</span>
              <SearchableSelect
                value={filters.sourceType}
                onChange={(value) => setFilter("sourceType", value)}
                ariaLabel="منبع سند"
                disabled={optionsFailed}
                options={[
                  { value: "", label: optionsFailed ? "در دسترس نیست" : "همهٔ منابع" },
                  ...options.sourceTypes.map((code) => ({ value: code, label: ledgerSourceLabel(code) })),
                ]}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">جست‌وجو</span>
              <input
                className={inputClass}
                value={qDraft}
                onChange={(event) => setQDraft(event.target.value)}
                placeholder="شرح، ثبت‌کننده یا نام/کد حساب…"
              />
            </label>
          </div>

          {showMoreFilters ? (
            <div className="mt-3 grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 lg:grid-cols-4 lg:items-end">
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">شعبه</span>
                <SearchableSelect
                  value={filters.location}
                  onChange={(value) => setFilter("location", value)}
                  ariaLabel="شعبه"
                  disabled={optionsFailed}
                  options={[
                    { value: "", label: optionsFailed ? "در دسترس نیست" : "همهٔ شعب" },
                    ...options.locations.map((loc) => ({ value: loc.id, label: loc.name })),
                  ]}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">حساب</span>
                <SearchableSelect
                  value={filters.account}
                  onChange={(value) => setFilter("account", value)}
                  ariaLabel="حساب"
                  options={accountOptions}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">ثبت‌کننده</span>
                <SearchableSelect
                  value={filters.creator}
                  onChange={(value) => setFilter("creator", value)}
                  ariaLabel="ثبت‌کننده"
                  disabled={optionsFailed}
                  options={[
                    { value: "", label: optionsFailed ? "در دسترس نیست" : "همهٔ ثبت‌کنندگان" },
                    ...options.creators.map((user) => ({ value: user.id, label: user.name })),
                  ]}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">پروژه / مرکز هزینه</span>
                <SearchableSelect
                  value={filters.project}
                  onChange={(value) => setFilter("project", value)}
                  ariaLabel="پروژه"
                  disabled={optionsFailed || options.projects.length === 0}
                  options={[
                    { value: "", label: options.projects.length === 0 ? "بدون پروژه" : "همهٔ پروژه‌ها" },
                    ...options.projects.map((project) => ({ value: project.id, label: project.name })),
                  ]}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">وضعیت برگشت</span>
                <SearchableSelect
                  value={filters.reversal}
                  onChange={(value) => setFilter("reversal", value as JournalFilterState["reversal"])}
                  ariaLabel="وضعیت برگشت"
                  options={REVERSAL_STATE_OPTIONS}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">نوع سند</span>
                <SearchableSelect
                  value={filters.kind}
                  onChange={(value) => setFilter("kind", value as JournalFilterState["kind"])}
                  ariaLabel="نوع سند"
                  options={ENTRY_KIND_OPTIONS}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">
                  حداقل مبلغ ({money.unitLabel})
                </span>
                <PersianNumberInput
                  className={inputClass}
                  inputMode="numeric"
                  value={rialTextToAmountInput(filters.amountMin, money.unit)}
                  onChange={(event) =>
                    setFilter("amountMin", amountToRialText(event.target.value, money.parseText))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">
                  حداکثر مبلغ ({money.unitLabel})
                </span>
                <PersianNumberInput
                  className={inputClass}
                  inputMode="numeric"
                  value={rialTextToAmountInput(filters.amountMax, money.unit)}
                  onChange={(event) =>
                    setFilter("amountMax", amountToRialText(event.target.value, money.parseText))
                  }
                />
              </label>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <SecondaryButton onClick={() => setShowMoreFilters((open) => !open)}>
              {showMoreFilters ? "بستن فیلترهای بیشتر" : "فیلترهای بیشتر"}
              {activeCount > 0 ? ` (${toPersianDigits(activeCount)})` : ""}
            </SecondaryButton>
            {filtered ? (
              <SecondaryButton onClick={() => writeFilters(EMPTY_JOURNAL_FILTERS)}>
                پاک کردن فیلترها
              </SecondaryButton>
            ) : null}
            <span className="text-xs text-muted-foreground">{entries ? countLabel : ""}</span>
          </div>

          {filters.entryId ? (
            /*
             * The reports drill-down links one line to its document
             * («بازکردن سند»). The journal honours that as a filter, so the
             * reader has to be told the book is showing one document and
             * given the way back out — the same escape the previous
             * offset-based screen offered, kept through the rewrite.
             */
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-amber-400/70 px-3 py-3 dark:border-amber-500/50">
              <p className="text-xs leading-5 text-muted-foreground">
                فقط سند پیوندشده نمایش داده می‌شود: {toPersianDigits(filters.entryId.slice(0, 8))}
              </p>
              <SecondaryButton onClick={() => setFilter("entryId", "")}>نمایش همهٔ اسناد</SecondaryButton>
            </div>
          ) : null}

          {optionsFailed ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-3 py-3">
              <p className="text-xs leading-5 text-muted-foreground">
                فهرست منابع، شعب و ثبت‌کنندگان بارگذاری نشد؛ این فیلترها موقتاً غیرفعال‌اند.
              </p>
              <SecondaryButton onClick={() => setOptionsKey((key) => key + 1)}>تلاش دوباره</SecondaryButton>
            </div>
          ) : null}
        </div>

        <div className="p-4 sm:p-5">
          <ErrorBox>{error}</ErrorBox>
          {notice ? (
            <p className="mb-3 rounded-xl border border-dashed border-border px-3 py-2 text-xs leading-5 text-muted-foreground">
              {notice}
            </p>
          ) : null}

          {!entries ? (
            error ? null : <SectionCardSkeleton rows={4} label="در حال بارگذاری دفتر روزنامه" />
          ) : entries.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              {filtered ? "سندی با این فیلترها پیدا نشد." : "هنوز سندی ثبت نشده است."}
            </p>
          ) : (
            <>
              <DataTable caption="اسناد دفتر روزنامه" className="hidden lg:block">
                <DataTableHead>
                  <Th>تاریخ</Th>
                  <Th>منبع</Th>
                  <Th>شرح</Th>
                  <Th>شعبه</Th>
                  <Th>ثبت‌کننده</Th>
                  <Th>وضعیت</Th>
                  <Th numeric>جمع سند</Th>
                  <Th>
                    <span className="sr-only">جزئیات</span>
                  </Th>
                </DataTableHead>
                <DataTableBody>
                  {entries.map((entry) => {
                    const open = expanded.has(entry.id);
                    const badge = journalReversalBadge(entry);
                    return (
                      <Fragment key={entry.id}>
                        <DataTableRow
                          id={journalRowId(entry.id)}
                          selected={entry.id === focusEntryId}
                          onClick={() => toggleExpanded(entry.id)}
                        >
                          <Td nowrap muted>
                            {formatJalali(entry.entryDate)}
                          </Td>
                          <Td muted nowrap>
                            {ledgerSourceLabel(entry.sourceType)}
                          </Td>
                          <Td>
                            <span className="line-clamp-2">{entry.memo || "سند بدون شرح"}</span>
                          </Td>
                          <Td muted nowrap>
                            {entry.locationName ?? "—"}
                          </Td>
                          <Td muted nowrap>
                            {entry.createdByName ?? "—"}
                          </Td>
                          <Td>
                            {badge === "reversal" ? (
                              <StatusBadge tone="active">سند برگشتی</StatusBadge>
                            ) : badge === "reversed" ? (
                              <StatusBadge tone="neutral">برگشت‌خورده</StatusBadge>
                            ) : (
                              <StatusBadge tone="positive">عادی</StatusBadge>
                            )}
                          </Td>
                          <Td numeric nowrap>
                            {money.formatText(entry.totalDebit)}
                          </Td>
                          <Td nowrap>
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-controls={journalDetailId(entry.id)}
                              aria-label={open ? "بستن جزئیات سند" : "نمایش جزئیات سند"}
                              onClick={() => toggleExpanded(entry.id)}
                              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring focus-visible:ring-ring/50"
                            >
                              <ChevronDownIcon
                                aria-hidden="true"
                                className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
                              />
                            </button>
                          </Td>
                        </DataTableRow>
                        {open ? (
                          <DataTableRow id={journalDetailId(entry.id)} className="bg-muted/60">
                            <Td colSpan={8}>
                              <JournalEntryDetail
                                entry={entry}
                                canApprove={canApprove}
                                busy={busy}
                                onReverse={() => setReversing(entry)}
                                onOpenEntry={openEntry}
                              />
                            </Td>
                          </DataTableRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </DataTableBody>
              </DataTable>

              <div className="space-y-2 lg:hidden">
                {entries.map((entry) => {
                  const open = expanded.has(entry.id);
                  const badge = journalReversalBadge(entry);
                  return (
                    <article
                      key={entry.id}
                      className={`rounded-xl border p-3 ${
                        entry.id === focusEntryId
                          ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10"
                          : "border-border/80 bg-muted/60"
                      }`}
                    >
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => toggleExpanded(entry.id)}
                        className="flex w-full items-start justify-between gap-3 text-start"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {entry.memo || "سند بدون شرح"}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {ledgerSourceLabel(entry.sourceType)} — {formatJalali(entry.entryDate)}
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          <span className="text-sm font-semibold tabular-nums text-foreground">
                            {money.formatText(entry.totalDebit)}
                          </span>
                          {badge === "reversal" ? (
                            <StatusBadge tone="active">سند برگشتی</StatusBadge>
                          ) : badge === "reversed" ? (
                            <StatusBadge tone="neutral">برگشت‌خورده</StatusBadge>
                          ) : null}
                        </span>
                      </button>
                      {open ? (
                        <JournalEntryDetail
                          entry={entry}
                          canApprove={canApprove}
                          busy={busy}
                          onReverse={() => setReversing(entry)}
                          onOpenEntry={openEntry}
                        />
                      ) : null}
                    </article>
                  );
                })}
              </div>

              {hasMore ? (
                <div className="mt-3 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-3 py-4 text-center">
                  <p className="text-xs leading-6 text-muted-foreground">{countLabel}</p>
                  <SecondaryButton
                    onClick={() => void load(nextCursor)}
                    disabled={loadingMore || busy || !nextCursor}
                  >
                    {loadingMore ? "در حال بارگذاری…" : "نمایش اسناد قدیمی‌تر"}
                  </SecondaryButton>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>

      {reversing ? (
        <JournalReversalDialog
          entry={reversing}
          onClose={() => setReversing(null)}
          onReversed={(reversalEntryId) => {
            setReversing(null);
            openEntry(reversalEntryId);
            onRefresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The row's detail: the document's lines, the audit metadata the model
 * carries, the link to the other half of a reversal pair, and the reversal
 * action itself.
 *
 * Deliberately *not* in the compact list: a journal is scanned by date, source
 * and amount, and `source_id` / `posted_at` / `project_id` / `reversed_by` are
 * answers to a question somebody asks about one document, not columns.
 */
function JournalEntryDetail({
  entry,
  canApprove,
  busy,
  onReverse,
  onOpenEntry,
}: {
  entry: JournalEntryView;
  canApprove: boolean | undefined;
  busy: boolean;
  onReverse: () => void;
  onOpenEntry: (entryId: string) => void;
}) {
  const money = useMoney();
  const counterpart = journalCounterpartEntryId(entry);
  const canReverse = canReverseJournalEntry(entry, canApprove);

  return (
    <div className="mt-3 space-y-3 border-t border-border/80 pt-3">
      <DataTable caption={`ردیف‌های سند ${entry.memo ?? ""}`}>
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
              <Td numeric nowrap>
                {line.debit !== "0" ? money.formatText(line.debit) : "—"}
              </Td>
              <Td numeric nowrap>
                {line.credit !== "0" ? money.formatText(line.credit) : "—"}
              </Td>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <AuditField label="شناسهٔ سند" value={entry.id} mono />
        <AuditField label="تاریخ سند" value={formatJalali(entry.entryDate)} />
        <AuditField label="زمان ثبت" value={formatJalali(entry.postedAt, { withTime: true })} />
        <AuditField label="منبع" value={ledgerSourceLabel(entry.sourceType)} />
        <AuditField label="شناسهٔ مرجع" value={entry.sourceId} mono />
        <AuditField label="شعبه" value={entry.locationName} />
        <AuditField label="پروژه / مرکز هزینه" value={entry.projectName} />
        <AuditField label="ثبت‌کننده" value={entry.createdByName} />
        {entry.reversedAt ? (
          <>
            <AuditField label="تاریخ برگشت" value={formatJalali(entry.reversedAt, { withTime: true })} />
            <AuditField label="برگشت‌زننده" value={entry.reversedByName} />
          </>
        ) : null}
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        {counterpart ? (
          <SecondaryButton onClick={() => onOpenEntry(counterpart.id)}>
            {counterpart.direction === "original" ? "مشاهدهٔ سند اصلی" : "مشاهدهٔ سند برگشتی"}
          </SecondaryButton>
        ) : null}
        {canReverse ? (
          <SecondaryButton onClick={onReverse} disabled={busy}>
            برگشت سند
          </SecondaryButton>
        ) : null}
        {entry.sourceType === "manual" && !entry.reversesEntryId && !entry.reversedAt && canApprove === false ? (
          <span className="text-xs text-muted-foreground">
            برگشت این سند نیاز به دسترسی «تأیید سند» دارد.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AuditField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 truncate text-foreground ${mono ? "font-mono" : ""}`}>
        {value || "—"}
      </dd>
    </div>
  );
}
