"use client";

/**
 * Phase 42b — «رسید و حواله‌های انبار»: the ledger of the RETAIL warehouse's
 * own documents. Filters by kind (رسید/حواله) and warehouse, plus a debounced
 * search over number/recipient/note; pages deterministically with a keyset
 * cursor; every filter combination is shareable through the URL.
 *
 * Issue #923:
 *   * Branch scope (P0) is enforced by the API; this screen only requests what
 *     the member's permitted branches allow.
 *   * Immutable identity (P1): the detail reads snapshotted line identity and
 *     shows voucher number, business date, posting timestamp and actor.
 *   * Retail lot/expiry stability (P1): each line shows the lot number and
 *     expiry it actually carried (generated lot numbers included), with a
 *     snapshot flag distinguishing snapshotted from legacy values.
 *   * Accounting traceability (P1): the linked GL journal entry is linked.
 */
import {
  ArrowUpCircleIcon,
  ArrowDownCircleIcon,
  ArrowLeftRightIcon,
  DownloadIcon,
  EyeIcon,
  HistoryIcon,
  PrinterIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  formatBranchTimestamp,
  formatBusinessDate,
  formatDocumentDate,
  timeZoneLabel,
} from "@/lib/business-date-display";
import {
  WAREHOUSE_POSTING_STATES,
  WAREHOUSE_REGISTER_SORTS,
  WAREHOUSE_REGISTER_SORT_LABELS,
  type WarehousePostingState,
  type WarehouseRegisterSort,
} from "@/lib/warehouse-document-register-options";
import printStyles from "../warehouse-documents-print.module.css";
import { useMoney } from "@/components/money/money-context";
import { api, inputClass } from "../ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";
import { type Warehouse } from "./warehouses-section";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

interface WarehouseDocument {
  id: string;
  kind: "receipt" | "issue" | "disposal" | "internal_use";
  location_id: string;
  location_name: string;
  recipient: string | null;
  document_number: string | null;
  internal_voucher_number: string | null;
  /** The register's display identity: internal voucher, else external number. */
  voucher_number: string | null;
  /** The branch's own business day, computed server-side (`app_business_date`). */
  business_date: string;
  /** The branch's IANA zone — the screen shows its timestamps in it. */
  location_timezone: string;
  reversed_of: string | null;
  reversal_reason: string | null;
  is_reversal: boolean;
  note: string | null;
  total_value_rial: string;
  created_at: string;
  created_by_name: string | null;
  line_count: number;
}

interface DocumentLine {
  id: string;
  item_name: string;
  tracking: string;
  lot_number: string | null;
  expiry_date: string | null;
  quantity: string;
  unit_cost: string;
  value_rial: string;
  item_snapshot: boolean;
}

interface DocumentLedgerLine {
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
}

/** One end of a correction/reversal chain, as the history panel shows it. */
interface ReversalLink {
  id: string;
  kind: string;
  voucherNumber: string | null;
  businessDate: string;
  createdAt: string;
  actorName: string | null;
  reason: string | null;
  reversesVoucherNumber: string | null;
}

interface ReversalHistory {
  original: ReversalLink | null;
  reversal: ReversalLink | null;
}

interface DetailResponse {
  document: Omit<WarehouseDocument, "line_count"> & {
    history: ReversalHistory;
    ledger: {
      entryId: string | null;
      postedAt: string | null;
      memo: string | null;
      status: "posted" | "not_posted";
      lines: DocumentLedgerLine[];
    };
  };
  lines: DocumentLine[];
}

type KindFilter = "all" | "receipt" | "issue" | "disposal" | "internal_use";

const KIND_FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: "all", label: "همه" },
  { key: "receipt", label: "رسید" },
  { key: "issue", label: "حواله" },
  { key: "disposal", label: "امحا" },
  { key: "internal_use", label: "مصرف داخلی" },
];

/** The posting-state filter's options — the badge the detail already shows. */
const POSTING_STATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "همهٔ وضعیت‌ها" },
  { value: WAREHOUSE_POSTING_STATES[0], label: "ثبت‌شده در حساب‌ها" },
  { value: WAREHOUSE_POSTING_STATES[1], label: "بدون سند حسابداری" },
];

const SORT_OPTIONS: Array<{ value: string; label: string }> = WAREHOUSE_REGISTER_SORTS.map(
  (key) => ({ value: key, label: WAREHOUSE_REGISTER_SORT_LABELS[key] }),
);

const chipClass = (active: boolean) =>
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 ${active ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200" : "border-border bg-card text-foreground hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-foreground dark:hover:text-stone-100"}`;

export function DocumentsSection() {
  const money = useMoney();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const readParam = (name: string): string => searchParams.get(name) ?? "";

  const [kindFilter, setKindFilterState] = useState<KindFilter>(
    (readParam("kind") as KindFilter) ?? "all",
  );
  const [locationId, setLocationIdState] = useState(readParam("locationId"));
  // `search` echoes keystrokes immediately; `searchQuery` is its debounced copy
  // that the fetch effect (and the shareable URL) actually follows.
  const [search, setSearch] = useState(readParam("search"));
  const [searchQuery, setSearchQuery] = useState(readParam("search"));
  const [dateFrom, setDateFromState] = useState(readParam("dateFrom"));
  const [dateTo, setDateToState] = useState(readParam("dateTo"));
  // P2 filters (#923): an amount band, the creator, the posting state and the
  // register's order. Every one of them is shareable through the URL exactly
  // like kind/branch/search/date, so a filtered view can be sent to someone.
  const [amountMin, setAmountMinState] = useState(readParam("amountMin"));
  const [amountMax, setAmountMaxState] = useState(readParam("amountMax"));
  const [createdBy, setCreatedByState] = useState(readParam("createdBy"));
  const [postingState, setPostingStateState] = useState<"" | WarehousePostingState>(
    readParam("postingState") as "" | WarehousePostingState,
  );
  const [sort, setSortState] = useState<WarehouseRegisterSort>(
    (readParam("sort") as WarehouseRegisterSort) || "created_desc",
  );
  // #1026's two register filters: the item collection/season and whether the
  // lines carry a cost. Shareable through the URL like every other filter.
  const [category, setCategoryState] = useState(readParam("category"));
  const [valuation, setValuationState] = useState<"all" | "valued" | "missing">(
    (readParam("valuation") as "all" | "valued" | "missing") || "all",
  );
  const [creators, setCreators] = useState<Array<{ id: string; name: string; documentCount: number }>>([]);
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // The print sheet is the *complete* filtered register (capped), not the page
  // on screen — the export's rule, so the paper and the file agree.
  const [printData, setPrintData] = useState<{ rows: WarehouseDocument[]; truncated: boolean } | null>(null);
  const [printing, setPrinting] = useState(false);
  const [portalReady, setPortalReady] = useState(false);

  const [documents, setDocuments] = useState<WarehouseDocument[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehousesFailed, setWarehousesFailed] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [reverseConfirm, setReverseConfirm] = useState(false);
  // The id of the detail request in flight — a slow response for a previously
  // opened document must not overwrite the one the user is looking at now.
  const detailRequestRef = useRef<string | null>(null);
  const listRequestRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the search input so typing does not fire a request per keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => setSearchQuery(search.trim()), 350);
    return () => window.clearTimeout(handle);
  }, [search]);

  // The print sheet lives on <body>, so it needs a client mount to portal into.
  useEffect(() => setPortalReady(true), []);

  useEffect(() => {
    if (!printData) return;
    // Let the portal paint, then hand over to the browser's print/PDF dialog
    // and drop the sheet when it closes.
    const timer = window.setTimeout(() => window.print(), 60);
    const clear = () => setPrintData(null);
    window.addEventListener("afterprint", clear);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", clear);
    };
  }, [printData]);

  // Keep every filter combination shareable through the URL.
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    if (kindFilter !== "all") params.set("kind", kindFilter);
    else params.delete("kind");
    if (locationId) params.set("locationId", locationId);
    else params.delete("locationId");
    if (searchQuery) params.set("search", searchQuery);
    else params.delete("search");
    if (dateFrom) params.set("dateFrom", dateFrom);
    else params.delete("dateFrom");
    if (dateTo) params.set("dateTo", dateTo);
    else params.delete("dateTo");
    for (const [key, value] of [
      ["amountMin", amountMin],
      ["amountMax", amountMax],
      ["createdBy", createdBy],
      ["postingState", postingState],
      ["category", category.trim()],
      ["valuation", valuation === "all" ? "" : valuation],
    ] as const) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    if (sort !== "created_desc") params.set("sort", sort);
    else params.delete("sort");
    if (nextCursor) params.set("cursor", nextCursor);
    else params.delete("cursor");
    const next = params.toString();
    if (next !== searchParams.toString()) router.replace(`${pathname}?${next}`, { scroll: false });
  }, [kindFilter, locationId, searchQuery, dateFrom, dateTo, amountMin, amountMax, createdBy, postingState, sort, category, valuation, nextCursor, searchParams, router, pathname]);

  useEffect(() => {
    setWarehousesFailed(false);
    let cancelled = false;
    api<{ warehouses: Warehouse[] }>("/api/stock/warehouses").then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) setWarehouses(data.warehouses);
      else setWarehousesFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * An amount typed in the business's display unit → exact Rial digits for the
   * API, or `null` when the text is not a complete amount. `null` means "no
   * filter" rather than a guess: guessing (rounding a half-typed «12») would
   * filter the register by an amount the person never entered.
   */
  const amountToRial = useCallback(
    (input: string): string | null => {
      if (!input.trim()) return null;
      try {
        return money.parseText(input);
      } catch {
        return null;
      }
    },
    [money],
  );

  const creatorOptions = useMemo(
    () => [
      { value: "", label: "همهٔ ثبت‌کننده‌ها" },
      ...creators.map((c) => ({ value: c.id, label: `${c.name} (${toPersianDigits(String(c.documentCount))})` })),
    ],
    [creators],
  );

  /**
   * One place decides what the register request asks for. The list, the export
   * and the print sheet all call this, so a printout can never silently
   * disagree with the screen it was taken from.
   */
  const filterParams = useCallback(
    (params: URLSearchParams) => {
      if (kindFilter !== "all") params.set("kind", kindFilter);
      if (locationId) params.set("locationId", locationId);
      if (searchQuery) params.set("search", searchQuery);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const minRial = amountToRial(amountMin);
      const maxRial = amountToRial(amountMax);
      if (minRial) params.set("amountMin", minRial);
      if (maxRial) params.set("amountMax", maxRial);
      if (createdBy) params.set("createdBy", createdBy);
      if (postingState) params.set("postingState", postingState);
      if (category.trim()) params.set("category", category.trim());
      if (valuation !== "all") params.set("valuation", valuation);
      if (sort !== "created_desc") params.set("sort", sort);
      return params;
    },
    [kindFilter, locationId, searchQuery, dateFrom, dateTo, amountMin, amountMax, amountToRial, createdBy, postingState, category, valuation, sort],
  );

  const activeFilters =
    kindFilter !== "all" || locationId || searchQuery || dateFrom || dateTo ||
    amountMin || amountMax || createdBy || postingState || category.trim() || valuation !== "all" ||
    sort !== "created_desc";

  /**
   * CSV / Excel of the complete filtered register. The browser downloads a
   * blob the API rendered — the export is server-side so the branch scope is
   * the server's (the same check the list ran), not something the screen
   * assembled.
   */
  const exportRegister = useCallback(
    async (format: "csv" | "xlsx") => {
      setExporting(format);
      setExportError(null);
      try {
        const params = filterParams(new URLSearchParams());
        params.set("format", format);
        const res = await fetch(`/api/stock/warehouse-documents?${params.toString()}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setExportError(
            body.error === "forbidden"
              ? "دسترسی به این شعبه برای خروجی مجاز نیست."
              : "تهیهٔ خروجی ناموفق بود.",
          );
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `warehouse-documents.${format}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch {
        setExportError("تهیهٔ خروجی ناموفق بود.");
      } finally {
        setExporting(null);
      }
    },
    [filterParams],
  );

  /** Walk the keyset to the end (capped) and print the register as a sheet. */
  const printRegister = useCallback(async () => {
    if (printing) return;
    setPrinting(true);
    setExportError(null);
    const PRINT_CAP = 2000;
    try {
      const rows: WarehouseDocument[] = [];
      let cursor: string | null = null;
      let truncated = false;
      for (let page = 0; page < 40 && rows.length < PRINT_CAP; page++) {
        const params = filterParams(new URLSearchParams());
        params.set("limit", "100");
        if (cursor) params.set("cursor", cursor);
        const res = await fetch(`/api/stock/warehouse-documents?${params.toString()}`);
        if (!res.ok) {
          setExportError("تهیهٔ نسخهٔ چاپی ناموفق بود.");
          return;
        }
        const data = (await res.json()) as {
          documents: WarehouseDocument[];
          hasMore: boolean;
          nextCursor: string | null;
        };
        rows.push(...data.documents);
        cursor = data.nextCursor;
        truncated = rows.length >= PRINT_CAP && data.hasMore;
        if (!cursor) break;
      }
      setPrintData({ rows: rows.slice(0, PRINT_CAP), truncated });
    } catch {
      setExportError("تهیهٔ نسخهٔ چاپی ناموفق بود.");
    } finally {
      setPrinting(false);
    }
  }, [filterParams, printing]);

  const fetchList = useCallback(
    (append: boolean) => {
      const ctrl = new AbortController();
      listRequestRef.current = ctrl;
      setLoading(true);
      setLoadFailed(false);

      const params = filterParams(new URLSearchParams());
      if (!append) params.delete("cursor");
      else if (nextCursor) params.set("cursor", nextCursor);

      api<{
        documents: WarehouseDocument[];
        hasMore: boolean;
        nextCursor: string | null;
      }>(`/api/stock/warehouse-documents?${params.toString()}`, { signal: ctrl.signal }).then(
        ({ ok, data, aborted }) => {
          if (aborted || ctrl.signal.aborted) return;
          if (listRequestRef.current !== ctrl) return;
          setLoading(false);
          if (!ok) {
            setLoadFailed(true);
            return;
          }
          setDocuments((prev) => (append ? [...prev, ...data.documents] : data.documents));
          setNextCursor(data.hasMore ? data.nextCursor : null);
        },
        () => {
          if (ctrl.signal.aborted) return;
          if (listRequestRef.current !== ctrl) return;
          setLoading(false);
          setLoadFailed(true);
        },
      );
    },
    [filterParams, nextCursor],
  );

  useEffect(() => {
    setNextCursor(null);
    fetchList(false);
  }, [fetchList]);

  // Creator options follow the branch filter: listing actors from branches the
  // member is not currently looking at would offer filters that can only
  // return nothing. A failed load is silent — the dropdown simply stays empty
  // and the register still works.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (locationId) params.set("locationId", locationId);
    api<{ creators: Array<{ id: string; name: string; documentCount: number }> }>(
      `/api/stock/warehouse-documents/creators?${params.toString()}`,
    ).then(({ ok, data }) => {
      if (!cancelled && ok) setCreators(data.creators);
    });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  const openDetail = useCallback((id: string) => {
    setDetailId(id);
    setDetail(null);
    setDetailFailed(false);
    detailRequestRef.current = id;
    api<DetailResponse>(`/api/stock/warehouse-documents/${id}`).then(({ ok, data }) => {
      if (detailRequestRef.current !== id) return;
      if (ok) setDetail(data);
      else setDetailFailed(true);
    });
  }, []);

  /** The register's short label for a kind, from its own chip list. */
  const kindShortLabel = useCallback(
    (kind: string) => KIND_FILTERS.find((f) => f.key === kind)?.label ?? kind,
    [],
  );

  /** One line describing the filters the sheet was printed with. */
  const printFilterSummary = useMemo(() => {
    const parts: string[] = [kindFilter === "all" ? "همهٔ اسناد" : kindShortLabel(kindFilter)];
    if (locationId) parts.push(warehouses.find((w) => w.id === locationId)?.name ?? "انبار انتخابی");
    if (dateFrom || dateTo) {
      parts.push(`تاریخ ${dateFrom ? formatBusinessDate(dateFrom) : "…"} تا ${dateTo ? formatBusinessDate(dateTo) : "…"}`);
    }
    if (amountMin) parts.push(`از مبلغ ${toPersianDigits(amountMin)}`);
    if (amountMax) parts.push(`تا مبلغ ${toPersianDigits(amountMax)}`);
    const creator = creators.find((c) => c.id === createdBy);
    if (creator) parts.push(`ثبت‌کننده ${creator.name}`);
    if (postingState) parts.push(postingState === "posted" ? "ثبت‌شده در حساب‌ها" : "بدون سند حسابداری");
    if (sort !== "created_desc") parts.push(WAREHOUSE_REGISTER_SORT_LABELS[sort]);
    return parts.join(" · ");
  }, [
    kindFilter,
    locationId,
    warehouses,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    creators,
    createdBy,
    postingState,
    sort,
    kindShortLabel,
  ]);

  const warehouseOptions = useMemo(
    () => [{ value: "", label: "همهٔ انبارها" }, ...warehouses.map((w) => ({ value: w.id, label: w.name }))],
    [warehouses],
  );


  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند انبار</p>
            <h2 className="mt-1 font-semibold text-foreground">رسید و حولهای انبار</h2>
          </div>
        }
        description="همهٔ سندهای ورودی (رسید) و خروجی (حواله) که در انبارهای این کسب‌وکار ثبت شده‌اند."
      >
        {/* Print/PDF and the file exports. Both read the *complete* filtered
            register through the API, so the branch scope check is the server's. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={printing || documents.length === 0}
            onClick={() => void printRegister()}
          >
            <PrinterIcon aria-hidden="true" className="size-4 mr-2" />
            {printing ? "در حال تهیه…" : "چاپ / PDF"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={exporting !== null || documents.length === 0}
            onClick={() => void exportRegister("csv")}
          >
            <DownloadIcon aria-hidden="true" className="size-4 mr-2" />
            {exporting === "csv" ? "در حال تهیه…" : "خروجی CSV"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={exporting !== null || documents.length === 0}
            onClick={() => void exportRegister("xlsx")}
          >
            <DownloadIcon aria-hidden="true" className="size-4 mr-2" />
            {exporting === "xlsx" ? "در حال تهیه…" : "خروجی Excel"}
          </Button>
          {exportError ? (
            <span role="alert" className="text-xs text-destructive">
              {exportError}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label="نوع سند">
            {KIND_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={chipClass(kindFilter === f.key)}
                aria-pressed={kindFilter === f.key}
                onClick={() => setKindFilterState(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="w-full sm:w-64">
            <SearchableSelect
              value={locationId}
              onChange={(v) => {
                setLocationIdState(v);
                setNextCursor(null);
              }}
              options={warehouseOptions}
              ariaLabel="فیلتر بر اساس انبار"
            />
          </div>
          <div className="relative w-full sm:w-64">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground" />
            <input
              className={`${inputClass} ps-9`}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setNextCursor(null);
              }}
              placeholder="جستجوی شماره سند / گیرنده / یادداشت"
              aria-label="جستجوی سندها"
            />
          </div>
          <div className="w-full sm:w-72">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">از تاریخ</label>
            <JalaliDatePicker
              value={dateFrom}
              onChange={(iso) => {
                setDateFromState(iso);
                setNextCursor(null);
              }}
              id="documents-date-from"
              ariaLabel="از تاریخ"
            />
          </div>
          <div className="w-full sm:w-72">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">تا تاریخ</label>
            <JalaliDatePicker
              value={dateTo}
              onChange={(iso) => {
                setDateToState(iso);
                setNextCursor(null);
              }}
              id="documents-date-to"
              ariaLabel="تا تاریخ"
            />
          </div>
          <div className="w-full sm:w-44">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">دسته</label>
            <input
              className={inputClass}
              value={category}
              onChange={(e) => {
                setCategoryState(e.target.value);
                setNextCursor(null);
              }}
              placeholder="مجموعه / فصل"
              aria-label="فیلتر دسته"
            />
          </div>
          <div className="w-full sm:w-44">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">ارزش‌گذاری</label>
            <select
              className={inputClass}
              value={valuation}
              onChange={(e) => {
                setValuationState(e.target.value as "all" | "valued" | "missing");
                setNextCursor(null);
              }}
              aria-label="فیلتر ارزش‌گذاری"
            >
              <option value="all">همه</option>
              <option value="valued">دارای بهای تمام‌شده</option>
              <option value="missing">بدون بهای تمام‌شده</option>
            </select>
          </div>
          {/* P2 filters (#923): amount band, creator, posting state, order. */}
          <div className="w-full sm:w-44">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              مبلغ از ({money.unitLabel})
            </label>
            <PersianNumberInput
              className={inputClass}
              value={amountMin}
              onChange={(e) => {
                setAmountMinState(e.target.value);
                setNextCursor(null);
              }}
              placeholder="۰"
              aria-label="حداقل مبلغ"
              aria-invalid={amountMin.trim() !== "" && amountToRial(amountMin) === null}
            />
          </div>
          <div className="w-full sm:w-44">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              مبلغ تا ({money.unitLabel})
            </label>
            <PersianNumberInput
              className={inputClass}
              value={amountMax}
              onChange={(e) => {
                setAmountMaxState(e.target.value);
                setNextCursor(null);
              }}
              placeholder="—"
              aria-label="حداکثر مبلغ"
              aria-invalid={amountMax.trim() !== "" && amountToRial(amountMax) === null}
            />
          </div>
          <div className="w-full sm:w-56">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">ثبت‌کننده</label>
            <SearchableSelect
              value={createdBy}
              onChange={(v) => {
                setCreatedByState(v);
                setNextCursor(null);
              }}
              options={creatorOptions}
              ariaLabel="فیلتر بر اساس ثبت‌کننده"
            />
          </div>
          <div className="w-full sm:w-52">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">وضعیت ثبت</label>
            <SearchableSelect
              value={postingState}
              onChange={(v) => {
                setPostingStateState(v as "" | WarehousePostingState);
                setNextCursor(null);
              }}
              options={POSTING_STATE_OPTIONS}
              ariaLabel="فیلتر بر اساس وضعیت ثبت حسابداری"
            />
          </div>
          <div className="w-full sm:w-56">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">ترتیب</label>
            <SearchableSelect
              value={sort}
              onChange={(v) => {
                setSortState(v as WarehouseRegisterSort);
                setNextCursor(null);
              }}
              options={SORT_OPTIONS}
              ariaLabel="ترتیب نمایش اسناد"
            />
          </div>
          {activeFilters && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setKindFilterState("all");
                setLocationIdState("");
                setSearch("");
                setSearchQuery("");
                setDateFromState("");
                setDateToState("");
                setAmountMinState("");
                setAmountMaxState("");
                setCreatedByState("");
                setPostingStateState("");
                setSortState("created_desc");
                setNextCursor(null);
              }}
            >
              <RefreshCwIcon aria-hidden="true" className="size-4 mr-2" /> پاک‌کردن فیلترها
            </Button>
          )}
        </div>
        {warehouses.length === 0 && !warehousesFailed && !loading ? (
          <p className="mt-2 text-xs text-muted-foreground">انباری برای این عضویت تعریف نشده است.</p>
        ) : null}
        {warehousesFailed && (
          <div className="mt-2 p-2 rounded-lg border border-destructive/30 bg-destructive/5 text-sm text-destructive">
            بارگذاری لیست انبارها ناموفق بود.
            <Button type="button" variant="outline" size="sm" onClick={() => fetchList(false)}>
              تلاش دوباره
            </Button>
          </div>
        )}
      </SectionCard>

      <SectionCard flush>
        {loading ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={5} label="در حال بارگذاری سندهای انبار" />
          </div>
        ) : loadFailed ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              <span className="block">دریافت سندهای انبار ناموفق بود.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => fetchList(false)}
              >
                <RefreshCwIcon aria-hidden="true" className="size-4" />
                تلاش دوباره
              </Button>
            </EmptyState>
          </div>
        ) : documents.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              {!activeFilters
                ? "هنوز رسید یا حواله‌ای ثبت نشده است. از «ثبت رسید انبار/حواله» اولین سند را بسازید."
                : "سندی با این فیلترها پیدا نشد."}
            </EmptyState>
          </div>
        ) : (
          <div className="space-y-3">
            <DataTable caption="اسناد رسید و حولهای انبار" tableClassName="min-w-[760px]">
              <DataTableHead>
                <Th>شماره انبار</Th>
                <Th>تاریخ</Th>
                <Th>نوع</Th>
                <Th>انبار</Th>
                <Th>گیرنده / شماره سند</Th>
                <Th numeric>اقلام</Th>
                <Th numeric>مبلغ</Th>
                <Th className="text-end">جزئیات</Th>
              </DataTableHead>
              <DataTableBody>
                {documents.map((doc) => (
                  <DataTableRow
                    key={doc.id}
                    onClick={() => openDetail(doc.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDetail(doc.id);
                      }
                    }}
                  >
                    <Td nowrap className="tabular-nums sm:px-5">
                      {doc.voucher_number ? (
                        <span className="font-semibold">{toPersianDigits(doc.voucher_number)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td nowrap className="tabular-nums sm:px-5">
                      {formatDocumentDate(doc.business_date, doc.created_at, doc.location_timezone)}
                    </Td>
                    <Td>
                      {doc.kind === "receipt" ? (
                        <StatusBadge tone="positive">
                          <ArrowUpCircleIcon aria-hidden="true" className="size-3.5" />
                          رسید
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">
                          <ArrowDownCircleIcon aria-hidden="true" className="size-3.5" />
                          حولهای
                        </StatusBadge>
                      )}
                    </Td>
                    <Td>{doc.location_name}</Td>
                    <Td className="max-w-[220px] truncate">
                      {doc.recipient}
                      {doc.document_number ? (
                        <span className="text-xs text-muted-foreground"> · سند {toPersianDigits(doc.document_number)}</span>
                      ) : null}
                      {!doc.recipient && !doc.document_number ? "—" : null}
                    </Td>
                    <Td numeric>{toPersianDigits(String(doc.line_count))}</Td>
                    <Td numeric nowrap>{money.formatText(doc.total_value_rial)}</Td>
                    <Td className="text-end sm:pe-5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:bg-muted/60 dark:hover:bg-stone-900/40 hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetail(doc.id);
                        }}
                        aria-label={`جزئیات سند ${doc.kind === "receipt" ? "رسید" : "حواله"} ${doc.location_name}`}
                        title="جزئیات سند"
                      >
                        <EyeIcon aria-hidden="true" className="size-4" />
                      </Button>
                    </Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>

            {nextCursor ? (
              <div className="flex items-center justify-between sm:justify-end">
                <p className="text-xs text-muted-foreground">
                  {documents.length} سند بارگذاری بود.
                </p>
                <Button
                  type="button"
                  onClick={() => fetchList(true)}
                  disabled={loading}
                  className="ml-2"
                >
                  {loading ? "در حال بارگذاری…" : "نمایش بیشتر"}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-end">
                رأس فهرست — تمامی سندهای مطابق فیلترها بارگذاری بود.
              </p>
            )}
          </div>
        )}
      </SectionCard>

      <Dialog
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null);
            detailRequestRef.current = null;
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {detail?.document.kind === "issue" ? "حولهای انبار" : "رسید انبار"}
              {detail?.document.voucher_number ? ` — انبار ${toPersianDigits(detail.document.voucher_number)}` : ""}
            </DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.document.location_name} · توضیحات: ${
                    formatDocumentDate(
                      detail.document.business_date,
                      detail.document.created_at,
                      detail.document.location_timezone,
                    )
                  }${
                    detail.document.created_by_name ? ` · ${detail.document.created_by_name}` : ""
                  }`
                : " "}
            </DialogDescription>
          </DialogHeader>

          {detailFailed ? (
            <EmptyState>
              <span className="block">دریافت جزئیات سند ناموفق بود.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => detailId && openDetail(detailId)}
              >
                <RefreshCwIcon aria-hidden="true" className="size-4" />
                تلاش دوباره
              </Button>
            </EmptyState>
          ) : detail === null ? (
            <LoadingSkeleton rows={4} label="در حال بارگذاری جزئیات سند" />
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <p className="text-muted-foreground">
                  شماره انبار: <span className="text-foreground">{detail.document.voucher_number ?? "—"}</span>
                </p>
                {detail.document.kind === "issue" ? (
                  <p className="text-muted-foreground">
                    گیرنده/مقصد: <span className="text-foreground">{detail.document.recipient ?? "—"}</span>
                  </p>
                ) : null}
                <p className="text-muted-foreground">
                  تاریخ سند: <span className="text-foreground">
                    {formatDocumentDate(
                      detail.document.business_date,
                      detail.document.created_at,
                      detail.document.location_timezone,
                    )}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  وقت ثبت:{" "}
                  <span className="text-foreground text-xs">
                    {formatBranchTimestamp(detail.document.created_at, detail.document.location_timezone, {
                      withTime: true,
                    })}
                    {timeZoneLabel(detail.document.location_timezone)
                      ? ` (${timeZoneLabel(detail.document.location_timezone)})`
                      : ""}
                  </span>
                </p>
                {detail.document.note ? (
                  <p className="text-muted-foreground">
                    یادداشت: <span className="text-foreground">{detail.document.note}</span>
                  </p>
                ) : null}
                {detail.document.created_by_name ? (
                  <p className="text-muted-foreground">
                    ثبت‌کننده: <span className="text-foreground">{detail.document.created_by_name}</span>
                  </p>
                ) : null}
              </div>
              {/* Printable sheet: the platform's A4 template rendered server-side
                  after the same branch authorization the detail ran. */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    window.open(
                      `/api/stock/warehouse-documents/${detail.document.id}/print`,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  <PrinterIcon aria-hidden="true" className="size-4 mr-2" />
                  چاپ / PDF سند
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  برگهٔ A4 با قالب چاپ پلتفرم؛ از پنجرهٔ چاپ، «ذخیره به PDF» هم در دسترس است.
                </span>
              </div>

              <DataTable caption="اقلام این سند انبار" tableClassName="min-w-[560px]">
                <DataTableHead>
                  <Th>کالا</Th>
                  <Th>بچ/لات</Th>
                  <Th>انقضا</Th>
                  <Th numeric>تعداد</Th>
                  <Th numeric>بهای واحد</Th>
                  <Th numeric>ارزش</Th>
                </DataTableHead>
                <DataTableBody>
                  {detail.lines.map((line) => (
                    <DataTableRow key={line.id}>
                      <Td>
                        {line.item_name}
                        {!line.item_snapshot ? (
                          <span className="text-xs text-muted-foreground ml-1">[جاری]</span>
                        ) : null}
                      </Td>
                      <Td nowrap muted className="text-xs">
                        {line.lot_number ?? "—"}
                      </Td>
                      <Td nowrap muted className="text-xs">
                        {line.expiry_date ? formatJalali(line.expiry_date) : "—"}
                      </Td>
                      <Td numeric nowrap>{formatQuantity(line.quantity)}</Td>
                      <Td numeric nowrap>{money.formatText(line.unit_cost)}</Td>
                      <Td numeric nowrap>{money.formatText(line.value_rial)}</Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
                <DataTableFoot>
                  <tr>
                    <Td colSpan={5} className="text-xs font-semibold text-muted-foreground">
                      جمع کل
                    </Td>
                    <Td numeric nowrap>
                      {money.formatText(detail.document.total_value_rial)}
                    </Td>
                  </tr>
                </DataTableFoot>
              </DataTable>
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
                {detail.document.internal_voucher_number ? (
                  <p>
                    شماره داخلی: <span className="font-mono">{detail.document.internal_voucher_number}</span>
                  </p>
                ) : null}
                {detail.document.is_reversal ? (
                  <p className="mt-1 text-amber-700 dark:text-amber-300">
                    این سند برگشتِ سند {toPersianDigits(detail.document.reversed_of ?? "")} است.
                  </p>
                ) : null}
                {!detail.document.is_reversal ? (
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={reversing}
                      onClick={() => setReverseConfirm(true)}
                      className="border-amber-300 text-amber-800 hover:bg-amber-50 dark:border-amber-500/30 dark:text-amber-200"
                    >
                      {reversing ? "در حال برگشت…" : "برگشت سند (سند معکوس)"}
                    </Button>
                    <span className="text-[11px] text-muted-foreground">سند معکوس؛ موجودی و اسناد مالی برمی‌گردد.</span>
                  </div>
                ) : null}
                {reverseError ? <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{reverseError}</p> : null}
              </div>
              {reverseConfirm ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-950/20">
                  <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">تأیید برگشت سند؟</p>
                  <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
                    سند معکوس با مقادیر دقیق همین سند ثبت می‌شود و اثر موجودی/مالی آن را خنثی می‌کند. این عمل قابل بازگشت نیست.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={reversing}
                      onClick={async () => {
                        setReverseConfirm(false);
                        setReversing(true);
                        setReverseError(null);
                        const idempotencyKey = crypto.randomUUID();
                        const { ok, data } = await api<{ error?: string; message?: string }>(
                          `/api/stock/warehouse-documents/${detailId}/reverse`,
                          {
                            method: "POST",
                            body: JSON.stringify({ note: `برگشت سند ${detail.document.internal_voucher_number ?? detailId}`, idempotencyKey }),
                            headers: { "Idempotency-Key": idempotencyKey },
                          },
                        ).catch(() => ({ ok: false, data: { error: "network_error" } }) as never);
                        setReversing(false);
                        if (!ok) {
                          const msg = (data as { error?: string }).error === "already_reversed" ? "این سند قبلاً برگشت خورده است." : (data as { message?: string }).message ?? (data as { error?: string }).error ?? "برگشت ناموفق بود.";
                          setReverseError(msg);
                          return;
                        }
                        setDetailId(null);
                        setDetail(null);
                        // The reversal wrote a new voucher into the register:
                        // drop the keyset cursor and reload the first page so
                        // it (and the reversed document's new state) appears.
                        setNextCursor(null);
                        fetchList(false);
                      }}
                    >
                      تأیید برگشت
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setReverseConfirm(false)}>
                      انصراف
                    </Button>
                  </div>
                </div>
              ) : null}

              {/* Correction/reversal history: the linked original this document
                  replaced, and the reversal that replaced it — with each one's
                  reason and actor. #922 owns the reversal operation; this panel
                  only shows what it recorded. */}
              {(detail.document.history.original || detail.document.history.reversal) && (
                <div className="rounded-xl border border-amber-200/70 bg-amber-50/40 p-3 dark:border-amber-500/25 dark:bg-amber-950/10">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
                    <HistoryIcon aria-hidden="true" className="size-3.5" />
                    سابقهٔ اصلاح و برگشت
                  </p>
                  <div className="mt-2 space-y-2">
                    {detail.document.history.original ? (
                      <LinkedDocumentRow
                        role="سند اصلی"
                        link={detail.document.history.original}
                        onOpen={() => openDetail(detail.document.history.original!.id)}
                      />
                    ) : null}
                    {detail.document.history.reversal ? (
                      <LinkedDocumentRow
                        role="سند برگشت"
                        link={detail.document.history.reversal}
                        onOpen={() => openDetail(detail.document.history.reversal!.id)}
                      />
                    ) : null}
                  </div>
                </div>
              )}

              {detail.document.ledger.entryId && (
                <div className="border border-border/60 rounded-xl p-3 bg-muted/20">
                  <p className="text-xs font-semibold text-muted-foreground">پیوست به سند حسابداری</p>
                  <div className="grid gap-1 text-sm sm:grid-cols-2">
                    <p className="text-muted-foreground">
                      شماره سند حسابداری: <span className="text-foreground">{detail.document.ledger.entryId}</span>
                    </p>
                    <p className="text-muted-foreground">
                      وضعیت: <span className="text-foreground font-medium">
                        {detail.document.ledger.status === "posted" ? "ثبت‌شده" : "ثبت نشده"}
                      </span>
                    </p>
                    {detail.document.ledger.postedAt && (
                      <p className="text-muted-foreground">
                        وقت ثبت: <span className="text-foreground">
                          {formatBranchTimestamp(
                            detail.document.ledger.postedAt,
                            detail.document.location_timezone,
                            { withTime: true },
                          )}
                        </span>
                      </p>
                    )}
                    {detail.document.ledger.memo && (
                      <p className="text-muted-foreground">
                        شرح: <span className="text-foreground">{detail.document.ledger.memo}</span>
                      </p>
                    )}
                  </div>
                  <DataTable caption="سطرهای سند حسابداری" tableClassName="min-w-[480px] mt-3">
                    <DataTableHead>
                      <Th>حساب</Th>
                      <Th className="text-end sm:pe-5">عنوان حساب</Th>
                      <Th numeric>بدهکار</Th>
                      <Th numeric>بستانکار</Th>
                    </DataTableHead>
                    <DataTableBody>
                      {detail.document.ledger.lines.map((line) => (
                        <DataTableRow key={`${line.accountCode}-${line.debit}-${line.credit}`}>
                          <Td>{line.accountCode}</Td>
                          <Td>{line.accountName}</Td>
                          <Td numeric nowrap>{line.debit !== "0" ? money.formatText(line.debit) : "—"}</Td>
                          <Td numeric nowrap>{line.credit !== "0" ? money.formatText(line.credit) : "—"}</Td>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                </div>
              )}
              {!detail.document.ledger.entryId && detail.document.ledger.status === "not_posted" && (
                <div className="p-2 rounded-lg border border-destructive/30 bg-destructive/5 text-sm text-destructive">
                  ثبت حسابداری برای این سند پیدا نشد؛ سند حسابداری مرتبط ثبت نشده است.
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {portalReady && printData
        ? createPortal(
            <div id="print-sheet-root" className={printStyles.sheet} aria-hidden="true">
              <header>
                <h1>رسید و حواله‌های انبار</h1>
                <p className="meta">{printFilterSummary}</p>
                <p className="meta">
                  {toPersianDigits(String(printData.rows.length))} سند
                  {printData.truncated
                    ? " — نسخهٔ چاپی محدود است؛ برای همهٔ ردیف‌ها خروجی CSV یا Excel بگیرید."
                    : ""}
                </p>
                <p className="meta">
                  تاریخ تولید: {toPersianDigits(formatJalali(new Date(), { withMonthName: true }))}
                </p>
              </header>
              <table>
                <thead>
                  <tr>
                    <th>شماره انبار</th>
                    <th>تاریخ</th>
                    <th>نوع</th>
                    <th>انبار</th>
                    <th>طرف‌حساب</th>
                    <th>اقلام</th>
                    <th>{`مبلغ (${money.unitLabel})`}</th>
                    <th>ثبت‌کننده</th>
                    <th>یادداشت</th>
                  </tr>
                </thead>
                <tbody>
                  {printData.rows.map((row) => (
                    <tr key={row.id}>
                      <td className={printStyles.num} dir="ltr">
                        {row.voucher_number ?? "—"}
                      </td>
                      <td>{formatDocumentDate(row.business_date, row.created_at, row.location_timezone)}</td>
                      <td>{kindShortLabel(row.kind)}</td>
                      <td>{row.location_name}</td>
                      <td>{row.recipient ?? "—"}</td>
                      <td className={printStyles.num}>{toPersianDigits(String(row.line_count))}</td>
                      <td className={printStyles.num}>{money.formatText(row.total_value_rial, { withUnit: false })}</td>
                      <td>{row.created_by_name ?? "—"}</td>
                      <td>{row.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * One end of a reversal chain: what it is, its voucher, when and by whom, and
 * why — plus a way to open it. Every value is snapshotted on the document, so
 * the history stays readable after an actor or an item is renamed.
 */
function LinkedDocumentRow({
  role,
  link,
  onOpen,
}: {
  role: string;
  link: ReversalLink;
  onOpen: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-foreground">
          {role}
          {" · "}
          {toPersianDigits(link.voucherNumber ?? "—")}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onOpen}>
          <ArrowLeftRightIcon aria-hidden="true" className="size-3.5 mr-1" />
          باز کردن سند
        </Button>
      </div>
      <p className="mt-1 text-muted-foreground">
        تاریخ: <span className="text-foreground">{formatBusinessDate(link.businessDate)}</span>
        {" · "}
        ثبت:{" "}
        <span className="text-foreground">
          {formatBranchTimestamp(link.createdAt, null, { withTime: true })}
        </span>
        {link.actorName ? (
          <>
            {" · "}
            ثبت‌کننده: <span className="text-foreground">{link.actorName}</span>
          </>
        ) : null}
      </p>
      {link.reason ? (
        <p className="mt-1 text-muted-foreground">
          دلیل: <span className="text-foreground">{link.reason}</span>
        </p>
      ) : null}
    </div>
  );
}
