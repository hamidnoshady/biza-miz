"use client";

/**
 * Phase 42b — «رسید و حواله‌های انبار»: the ledger of the RETAIL warehouse's
 * own documents. Filters by kind (رسید/حواله) and warehouse, plus a search
 * over number/recipient/note; each row opens the document's lines (with lot,
 * expiry, cost and totals) in a detail dialog.
 */
import { ArrowUpCircleIcon, ArrowDownCircleIcon, EyeIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api, inputClass } from "../ui";
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
  reversed_of: string | null;
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
}

interface DetailResponse {
  document: Omit<WarehouseDocument, "line_count">;
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

const chipClass = (active: boolean) =>
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 ${
    active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
      : "border-border bg-card text-foreground  hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-foreground dark:hover:text-stone-100"
  }`;

export function DocumentsSection() {
  const money = useMoney();
  const [documents, setDocuments] = useState<WarehouseDocument[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [locationId, setLocationId] = useState("");
  const [search, setSearch] = useState("");
  // The debounced copy the fetch effect follows — typing must not fire a
  // request per keystroke.
  const [searchQuery, setSearchQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [reverseConfirm, setReverseConfirm] = useState(false);
  // The id of the detail request in flight — a slow response for a previously
  // opened document must not overwrite the one the user is looking at now.
  const detailRequestRef = useRef<string | null>(null);

  useEffect(() => {
    api<{ warehouses: Warehouse[] }>("/api/stock/warehouses").then(({ ok, data }) => {
      if (ok) setWarehouses(data.warehouses);
    });
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => setSearchQuery(search.trim()), 350);
    return () => window.clearTimeout(handle);
  }, [search]);

  // Cancellation-guarded: switching filters quickly must not let a stale
  // response land on top of the newer one.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (kindFilter !== "all") params.set("kind", kindFilter);
    if (locationId) params.set("locationId", locationId);
    if (searchQuery) params.set("search", searchQuery);
    api<{ documents: WarehouseDocument[] }>(`/api/stock/warehouse-documents?${params.toString()}`).then(
      ({ ok, data }) => {
        if (cancelled) return;
        setLoadFailed(!ok);
        setDocuments(ok ? data.documents : []);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kindFilter, locationId, searchQuery, reloadKey]);

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

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند انبار</p>
            <h2 className="mt-1 font-semibold text-foreground">رسید و حواله‌های انبار</h2>
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
                onClick={() => setKindFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="w-full sm:w-56">
            <SearchableSelect
              value={locationId}
              onChange={setLocationId}
              options={warehouseOptions}
              ariaLabel="فیلتر بر اساس انبار"
            />
          </div>
          <div className="relative w-full sm:w-64">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground" />
            <input
              className={`${inputClass} ps-9`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="جستجوی شماره سند / گیرنده / یادداشت"
              aria-label="جستجوی سندها"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard flush>
        {documents === null ? (
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
                onClick={() => setReloadKey((k) => k + 1)}
              >
                <RefreshCwIcon aria-hidden="true" className="size-4" />
                تلاش دوباره
              </Button>
            </EmptyState>
          </div>
        ) : documents.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              {kindFilter === "all" && !locationId && !search
                ? "هنوز رسید یا حواله‌ای ثبت نشده است. از «ثبت رسید انبار/حواله» اولین سند را بسازید."
                : "سندی با این فیلترها پیدا نشد."}
            </EmptyState>
          </div>
        ) : (
          <DataTable caption="اسناد رسید و حواله انبار" tableClassName="min-w-[760px]">
            <DataTableHead>
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
                    // Space activates a button-role element too; prevent the
                    // page from scrolling instead of opening the dialog.
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openDetail(doc.id);
                    }
                  }}
                >
                  <Td nowrap className="tabular-nums sm:px-5">{formatJalali(doc.created_at)}</Td>
                  <Td>
                    {doc.kind === "receipt" ? (
                      <StatusBadge tone="positive">
                        <ArrowUpCircleIcon aria-hidden="true" className="size-3.5" />
                        رسید
                      </StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">
                        <ArrowDownCircleIcon aria-hidden="true" className="size-3.5" />
                        حواله
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
        {/* sm:max-w-2xl (not max-w-2xl): the base class must keep the mobile
            max-w-[calc(100%-2rem)] margin and only widen from sm up. */}
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {detail?.document.kind === "issue" ? "حواله انبار" : "رسید انبار"}
              {detail?.document.document_number ? ` — سند ${toPersianDigits(detail.document.document_number)}` : ""}
            </DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.document.location_name} · ${formatJalali(detail.document.created_at)}${
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
                {/* A receipt has no recipient by definition — only show the row where it means something. */}
                {detail.document.kind === "issue" ? (
                  <p className="text-muted-foreground">
                    گیرنده/مقصد: <span className="text-foreground">{detail.document.recipient ?? "—"}</span>
                  </p>
                ) : null}
                {detail.document.note ? (
                  <p className="text-muted-foreground">
                    یادداشت: <span className="text-foreground">{detail.document.note}</span>
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
                      <Td>{line.item_name}</Td>
                      <Td nowrap muted className="text-xs">{line.lot_number ?? "—"}</Td>
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
                        setReloadKey((k) => k + 1);
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
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
