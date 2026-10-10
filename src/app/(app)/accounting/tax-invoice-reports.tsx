"use client";

/**
 * Issue #866 — the taxpayer register's reports: the tie-out to the sales ledger,
 * the queue waiting on the authority, and the errors the authority and the
 * transport kept returning. Every figure is read from the server; nothing here
 * computes a tax total. The tie-out is the check that matters: a sale is
 * accepted only when a live record for it stands with the same totals.
 */
import { TaxCustomerFilter } from "./tax-customer-filter";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KpiCard, KpiRow, LoadingSkeleton, SectionCard, StatusBadge, TabBar } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { FilterChip, FilterChipRow } from "@/app/dashboard/filters";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, InfoBox, inputClass, PrimaryButton, SecondaryButton, errorMessageOrRaw } from "@/app/dashboard/ui";
import { useMoney, type MoneyApi } from "@/components/money/money-context";
import { formatJalali, todayIsoDate } from "@/lib/jalali";
import type { ReconState } from "@/lib/tax-invoice-core";
import { TAX_KIND_LABELS, TAX_STATUS_LABELS, taxStatusTone } from "@/lib/tax-invoice";
import type { PendingRow, ProviderErrorRow, ReconciliationPage } from "@/lib/tax-invoice-queries";
import type { TaxInvoiceCapabilities } from "./tax-invoice-capabilities";
import type { TaxLocation } from "./tax-invoice-settings";

type ReportTab = "reconciliation" | "queue" | "provider";

const REPORT_TABS: readonly { key: ReportTab; label: string }[] = [
  { key: "reconciliation", label: "تطبیق با فروش" },
  { key: "queue", label: "صف ارسال و استعلام" },
  { key: "provider", label: "خطاهای مؤدیان" },
];

/** The reconciliation's states, in the order an operator works through them. */
const RECON_ORDER: readonly ReconState[] = ["mismatch", "missing", "error", "pending", "rejected", "accepted", "cancelled", "voided"];

const RECON_LABELS: Record<ReconState, string> = {
  accepted: "پذیرفته‌شده",
  pending: "در انتظار نتیجه",
  error: "خطای ارسال",
  rejected: "ردشده",
  cancelled: "ابطال‌شده",
  mismatch: "مغایرت مبلغ",
  missing: "بدون رکورد مؤدی",
  voided: "فروش باطل‌شده",
};

const RECON_TONE: Record<ReconState, "active" | "positive" | "neutral" | "danger"> = {
  accepted: "positive",
  pending: "active",
  error: "danger",
  rejected: "danger",
  cancelled: "neutral",
  mismatch: "danger",
  missing: "danger",
  voided: "neutral",
};

/** The table shows this many rows; the state chips narrow the rest. */
const RECON_DISPLAY_LIMIT = 500;

/** A send call takes at most this many ids (the route's cap). */
const SEND_BATCH = 50;

type Money = MoneyApi;

type Reply = { error?: string; message?: string };

function errorText(data: unknown): string {
  const reply = (data ?? {}) as Reply;
  return reply.message ?? errorMessageOrRaw(reply.error);
}

/** The last thirty days, inclusive, in the business's calendar. */
function defaultRange(): { from: string; to: string } {
  const to = todayIsoDate();
  const start = new Date(`${to}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  return { from: start.toISOString().slice(0, 10), to };
}

export function TaxInvoiceReports({
  capabilities,
  locations,
  money,
}: {
  capabilities: TaxInvoiceCapabilities;
  locations: readonly TaxLocation[];
  money: Money;
}) {
  const [tab, setTab] = useState<ReportTab>("reconciliation");

  return (
    <div className="space-y-5">
      <TabBar idPrefix="tax-reports" label="گزارش‌های صورتحساب مؤدیان" tabs={REPORT_TABS} active={tab} onChange={setTab} />
      {tab === "reconciliation" ? <ReconciliationPanel capabilities={capabilities} locations={locations} money={money} /> : null}
      {tab === "queue" ? <QueuePanel capabilities={capabilities} /> : null}
      {tab === "provider" ? <ProviderErrorPanel /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tie-out to the sales ledger
// ---------------------------------------------------------------------------

function ReconciliationPanel({
  capabilities,
  locations,
  money,
}: {
  capabilities: TaxInvoiceCapabilities;
  locations: readonly TaxLocation[];
  money: Money;
}) {
  const [range, setRange] = useState(defaultRange);
  const [locationId, setLocationId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [stateFilter, setStateFilter] = useState<ReconState | "all">("all");
  const [data, setData] = useState<ReconciliationPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!range.from || !range.to) {
      setData(null);
      setError("بازهٔ تاریخ را مشخص کنید.");
      return;
    }
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (locationId) params.set("locationId", locationId);
    if (customerId) params.set("customerId", customerId);
    const res = await api<ReconciliationPage>(`/api/ledger/tax-invoices/reconciliation?${params.toString()}`);
    setLoading(false);
    if (!res.ok) {
      setData(null);
      setError(errorText(res.data));
      return;
    }
    setData(res.data);
  }, [range.from, range.to, locationId, customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => (data ? data.rows.filter((row) => stateFilter === "all" || row.state === stateFilter) : []), [data, stateFilter]);
  const shown = rows.slice(0, RECON_DISPLAY_LIMIT);

  const exportParams = new URLSearchParams({ from: range.from, to: range.to });
  if (locationId) exportParams.set("locationId", locationId);
  if (customerId) exportParams.set("customerId", customerId);
  const exportHref = `/api/ledger/tax-invoices/export?${exportParams.toString()}`;

  return (
    <SectionCard
      title="تطبیق صورتحساب‌های مؤدی با فروش‌ها"
      description="هر فروش کامل با رکورد زندهٔ مؤدی و جمع‌های یکسان «پذیرفته‌شده» است. مبلغ‌ها از همان سندهای فروش و مالیات خوانده می‌شوند؛ دفتر دیگری ساخته نمی‌شود."
      actions={
        capabilities.exportRegister ? (
          <SecondaryButton onClick={() => (window.location.href = exportHref)}>خروجی CSV ثبت‌ها</SecondaryButton>
        ) : null
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="block">
            <span className="mb-1 block text-xs text-muted-foreground">از تاریخ فروش</span>
            <JalaliDatePicker value={range.from} onChange={(value) => setRange((prev) => ({ ...prev, from: value }))} ariaLabel="از تاریخ فروش" clearable={false} />
          </div>
          <div className="block">
            <span className="mb-1 block text-xs text-muted-foreground">تا تاریخ فروش</span>
            <JalaliDatePicker value={range.to} onChange={(value) => setRange((prev) => ({ ...prev, to: value }))} ariaLabel="تا تاریخ فروش" clearable={false} />
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">شعبه</span>
            <select className={inputClass} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">همهٔ شعبه‌ها</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
          <TaxCustomerFilter value={customerId} onChange={setCustomerId} />
        </div>

        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {data?.truncated ? (
          <InfoBox>بیش از ۵٬۰۰۰ فروش در این بازه است؛ برای تطبیق کامل بازهٔ کوتاه‌تری انتخاب کنید.</InfoBox>
        ) : null}

        {data ? (
          <>
            <KpiRow>
              <KpiCard label="فروش‌های کامل در بازه" value={String(data.totals.sourceCount)} hint={`جمع ${money.format(data.totals.sourceTotalRial)}`} />
              <KpiCard label="مالیات فروش‌ها" value={money.format(data.totals.sourceVatRial)} />
              <KpiCard
                label="مغایرت (فروش منهای رکورد)"
                value={money.format(data.totals.differenceTotalRial)}
                hint={`${data.totals.byState.mismatch.count} فروش با مغایرت`}
              />
              <KpiCard
                label="فروش بدون رکورد مؤدی"
                value={money.format(data.totals.unrecordedTotalRial)}
                hint={`${data.totals.byState.missing.count} فروش`}
              />
            </KpiRow>

            <FilterChipRow label="فیلتر وضعیت تطبیق">
              <FilterChip selected={stateFilter === "all"} onClick={() => setStateFilter("all")}>
                همه
              </FilterChip>
              {RECON_ORDER.map((state) => (
                <FilterChip key={state} selected={stateFilter === state} onClick={() => setStateFilter(state)}>
                  {`${RECON_LABELS[state]} (${data.totals.byState[state].count})`}
                </FilterChip>
              ))}
            </FilterChipRow>

            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">فروشی با این وضعیت در بازهٔ انتخاب‌شده نیست.</p>
            ) : (
              <>
                {rows.length > RECON_DISPLAY_LIMIT ? (
                  <InfoBox>{`${RECON_DISPLAY_LIMIT} ردیف نخست نمایش داده شده است؛ با فیلتر وضعیت، ردیف‌های مورد نظر را جدا کنید.`}</InfoBox>
                ) : null}
                <DataTable caption="تطبیق فروش‌ها با رکوردهای مؤدی">
                  <DataTableHead>
                    <Th>تاریخ فروش</Th>
                    <Th numeric>شماره فروش</Th>
                    <Th>شعبه</Th>
                    <Th>وضعیت تطبیق</Th>
                    <Th>شماره ارجاع</Th>
                    <Th numeric>جمع فروش</Th>
                    <Th numeric>جمع رکورد</Th>
                    <Th numeric>مالیات فروش</Th>
                    <Th numeric>مالیات رکورد</Th>
                  </DataTableHead>
                  <DataTableBody>
                    {shown.map((row) => (
                      <DataTableRow key={row.orderId}>
                        <Td nowrap>{formatJalali(row.closedAt, { withTime: true })}</Td>
                        <Td numeric>{row.orderNumber}</Td>
                        <Td>{row.locationName}</Td>
                        <Td>
                          <StatusBadge tone={RECON_TONE[row.state]}>{RECON_LABELS[row.state]}</StatusBadge>
                        </Td>
                        <Td muted>
                          <span dir="ltr" className="font-mono text-xs">
                            {row.reference ?? "—"}
                          </span>
                        </Td>
                        <Td numeric nowrap>{money.format(row.sourceTotalRial)}</Td>
                        <Td numeric nowrap>{row.recordId ? money.format(row.recordTotalRial) : "—"}</Td>
                        <Td numeric nowrap>{money.format(row.sourceVatRial)}</Td>
                        <Td numeric nowrap>{row.recordId ? money.format(row.recordVatRial) : "—"}</Td>
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                </DataTable>
              </>
            )}
          </>
        ) : loading ? (
          <LoadingSkeleton rows={3} label="در حال تطبیق" />
        ) : null}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Queue awaiting the authority
// ---------------------------------------------------------------------------

function QueuePanel({ capabilities }: { capabilities: TaxInvoiceCapabilities }) {
  const [rows, setRows] = useState<PendingRow[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ rows: PendingRow[] }>("/api/ledger/tax-invoices/queue");
    if (!res.ok) {
      setError(errorText(res.data));
      return;
    }
    setRows(res.data.rows);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const queuedIds = useMemo(() => (rows ?? []).filter((row) => row.status === "queued").map((row) => row.id), [rows]);

  const inquire = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    const res = await api<{ inquired: number } & Reply>("/api/ledger/tax-invoices/inquiry", { method: "POST", body: JSON.stringify({}) });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res.data));
      return;
    }
    setNotice(`${res.data.inquired} رکورد از مؤدی استعلام شد.`);
    await load();
  };

  const sendQueued = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    const ids = queuedIds.slice(0, SEND_BATCH);
    const res = await api<Reply>("/api/ledger/tax-invoices/send", { method: "POST", body: JSON.stringify({ ids }) });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res.data));
      return;
    }
    setNotice(`${ids.length} رکورد در صف به مؤدی فرستاده شد.`);
    await load();
  };

  return (
    <SectionCard
      title="صف ارسال و استعلام"
      description="رکوردهایی که هنوز به مؤدی نرفته‌اند یا منتظر پاسخ آن‌اند. رکوردی که پاسخ نگرفته، بدون استعلام دوباره فرستاده نمی‌شود."
      actions={
        <div className="flex flex-wrap gap-2">
          {capabilities.inquire ? (
            <SecondaryButton disabled={busy || !rows || rows.length === 0} onClick={() => void inquire()}>
              استعلام همهٔ منتظرها
            </SecondaryButton>
          ) : null}
          {capabilities.send && queuedIds.length > 0 ? (
            <PrimaryButton disabled={busy} type="button" onClick={() => void sendQueued()}>
              {`ارسال ${Math.min(queuedIds.length, SEND_BATCH)} رکورد صف`}
            </PrimaryButton>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        {rows === null ? (
          <LoadingSkeleton rows={3} label="در حال بارگذاری گزارش" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">صفی وجود ندارد؛ همهٔ رکوردها نتیجه گرفته‌اند.</p>
        ) : (
          <DataTable caption="رکوردهای در انتظار">
            <DataTableHead>
              <Th>شماره ارجاع</Th>
              <Th>نوع</Th>
              <Th numeric>شماره فروش</Th>
              <Th>وضعیت</Th>
              <Th numeric>تلاش</Th>
              <Th>تلاش بعدی</Th>
              <Th>آماده‌سازی</Th>
              <Th>آخرین خطا</Th>
            </DataTableHead>
            <DataTableBody>
              {rows.map((row) => (
                <DataTableRow key={row.id}>
                  <Td nowrap>
                    <span dir="ltr" className="font-mono text-xs">
                      {row.referenceNumber}
                    </span>
                  </Td>
                  <Td>{TAX_KIND_LABELS[row.kind]}</Td>
                  <Td numeric>{row.orderNumber ?? "—"}</Td>
                  <Td>
                    <StatusBadge tone={taxStatusTone(row.status)}>{TAX_STATUS_LABELS[row.status]}</StatusBadge>
                  </Td>
                  <Td numeric>{row.attempts}</Td>
                  <Td nowrap>{row.nextAttemptAt ? formatJalali(row.nextAttemptAt, { withTime: true }) : "—"}</Td>
                  <Td nowrap>{formatJalali(row.preparedAt, { withTime: true })}</Td>
                  <Td>
                    {row.lastErrorCode ? (
                      <span dir="ltr" className="font-mono text-xs">
                        {row.lastErrorCode}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// What the authority and the transport kept refusing
// ---------------------------------------------------------------------------

function ProviderErrorPanel() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<ProviderErrorRow[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const res = await api<{ rows: ProviderErrorRow[] }>(`/api/ledger/tax-invoices/provider-errors?${params.toString()}`);
    if (!res.ok) {
      setError(errorText(res.data));
      return;
    }
    setError("");
    setRows(res.data.rows);
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SectionCard
      title="خطاهای مؤدیان"
      description="خطاهایی که مؤدی یا مسیر ارسال بازگردانده، یک‌جا و بر اساس کد. هر کد یک بار نشان داده می‌شود؛ شمارش رخدادها کنار آن است."
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="block">
            <span className="mb-1 block text-xs text-muted-foreground">از تاریخ آماده‌سازی</span>
            <JalaliDatePicker value={from} onChange={setFrom} ariaLabel="از تاریخ آماده‌سازی" clearable />
          </div>
          <div className="block">
            <span className="mb-1 block text-xs text-muted-foreground">تا تاریخ آماده‌سازی</span>
            <JalaliDatePicker value={to} onChange={setTo} ariaLabel="تا تاریخ آماده‌سازی" clearable />
          </div>
        </div>
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {rows === null ? (
          <LoadingSkeleton rows={3} label="در حال بارگذاری گزارش" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">در این بازه خطایی ثبت نشده است.</p>
        ) : (
          <DataTable caption="خطاهای مؤدیان بر اساس کد">
            <DataTableHead>
              <Th>کد خطا</Th>
              <Th>پیام</Th>
              <Th numeric>رکوردهای درگیر</Th>
              <Th numeric>رخداد</Th>
            </DataTableHead>
            <DataTableBody>
              {rows.map((row) => (
                <DataTableRow key={row.code}>
                  <Td nowrap>
                    <span dir="ltr" className="font-mono text-xs">
                      {row.code}
                    </span>
                  </Td>
                  <Td>
                    <span dir="auto">{row.message || "—"}</span>
                  </Td>
                  <Td numeric>{row.records}</Td>
                  <Td numeric>{row.occurrences}</Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </div>
    </SectionCard>
  );
}
