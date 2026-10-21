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
import { ArrowUpCircleIcon, ArrowDownCircleIcon, EyeIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useMoney } from "@/components/money/money-context";
import { api, inputClass } from "../ui";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";
import { type Warehouse } from "./warehouses-section";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

interface WarehouseDocument {
  id: string;
  kind: "receipt" | "issue";
  location_id: string;
  location_name: string;
  recipient: string | null;
  document_number: string | null;
  voucher_number: string | null;
  business_date: string | null;
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

interface DetailResponse {
  document: Omit<WarehouseDocument, "line_count"> & {
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

type KindFilter = "all" | "receipt" | "issue";

const KIND_FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: "all", label: "همه" },
  { key: "receipt", label: "رسید" },
  { key: "issue", label: "حواله" },
];

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

  const [documents, setDocuments] = useState<WarehouseDocument[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehousesFailed, setWarehousesFailed] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const detailRequestRef = useRef<string | null>(null);
  const listRequestRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the search input so typing does not fire a request per keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => setSearchQuery(search.trim()), 350);
    return () => window.clearTimeout(handle);
  }, [search]);

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
    if (nextCursor) params.set("cursor", nextCursor);
    else params.delete("cursor");
    const next = params.toString();
    if (next !== searchParams.toString()) router.replace(`${pathname}?${next}`, { scroll: false });
  }, [kindFilter, locationId, searchQuery, dateFrom, dateTo, nextCursor, searchParams, router, pathname]);

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

  const fetchList = useCallback(
    (append: boolean) => {
      const ctrl = new AbortController();
      listRequestRef.current = ctrl;
      setLoading(true);
      setLoadFailed(false);

      const params = new URLSearchParams();
      if (kindFilter !== "all") params.set("kind", kindFilter);
      if (locationId) params.set("locationId", locationId);
      if (searchQuery) params.set("search", searchQuery);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
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
    [kindFilter, locationId, searchQuery, dateFrom, dateTo, nextCursor],
  );

  useEffect(() => {
    setNextCursor(null);
    fetchList(false);
  }, [kindFilter, locationId, searchQuery, dateFrom, dateTo, fetchList]);

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

  const warehouseOptions = useMemo(
    () => [{ value: "", label: "همهٔ انبارها" }, ...warehouses.map((w) => ({ value: w.id, label: w.name }))],
    [warehouses],
  );

  const activeFilters =
    kindFilter !== "all" || locationId || searchQuery || dateFrom || dateTo;

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
                      {formatJalali(doc.business_date ?? doc.created_at)}
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
                    detail.document.business_date
                      ? formatJalali(detail.document.business_date)
                      : formatJalali(detail.document.created_at)
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
                  تاریخ سند: <span className="text-foreground">{formatJalali(detail.document.business_date ?? detail.document.created_at)}</span>
                </p>
                <p className="text-muted-foreground">
                  وقت ثبت: <span className="text-foreground text-xs">{formatJalali(detail.document.created_at, { withTime: true })}</span>
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
                        وقت ثبت: <span className="text-foreground">{formatJalali(detail.document.ledger.postedAt, { withTime: true })}</span>
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
    </div>
  );
}
