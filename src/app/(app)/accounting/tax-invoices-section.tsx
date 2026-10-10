"use client";

/**
 * Issue #866 — «صورتحساب مؤدیان»: the taxpayer register inside Accounting.
 *
 * Three views over one register (ارسال‌نشده، ارسال‌شده، خطا), the actions each
 * record offers, the worklist of completed sales that still need a record, and
 * the reports and settings in their own modules. Every action shown is one the
 * member's capabilities grant; the API checks the same grant again.
 *
 * Dates are Shamsi and money is the business's unit, as everywhere in Accounting.
 */
import Link from "next/link";
import { TaxCustomerFilter } from "./tax-customer-filter";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, LoadingSkeleton, PageHeader, SectionCard, StatusBadge, TabBar } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { FilterChip, FilterChipRow } from "@/app/dashboard/filters";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, InfoBox, inputClass, PrimaryButton, SecondaryButton, errorMessageOrRaw } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { formatJalali, todayIsoDate } from "@/lib/jalali";
import {
  availableTaxActions,
  TAX_ACTION_LABELS,
  TAX_ENVIRONMENT_LABELS,
  TAX_KIND_LABELS,
  TAX_STATUS_LABELS,
  TAX_STATUSES,
  TAX_VIEW_LABELS,
  taxStatusTone,
  type TaxAction,
  type TaxKind,
  type TaxStatus,
  type TaxView,
} from "@/lib/tax-invoice";
import type { TaxEventRow, TaxRecordDetail, TaxRegisterPage, TaxRegisterRow, UnpreparedSale } from "@/lib/tax-invoice-queries";
import type { PrepareResult } from "@/lib/tax-invoice-service";
import { taxInvoiceCapabilitiesFor, type TaxInvoiceCapabilities } from "./tax-invoice-capabilities";
import { TaxInvoiceReports } from "./tax-invoice-reports";
import { TaxInvoiceSettings, type TaxLocation } from "./tax-invoice-settings";

type Tab = "register" | "unprepared" | "reports" | "settings";
type ViewChoice = "all" | TaxView;

const EVENT_LABELS: Record<string, string> = {
  archived: "بایگانی شد",
  provider_callback: "پیام شرکت معتمد",
  callback_received_in_flight: "پیام در حین ارسال",
  prepared: "آماده‌سازی",
  queued: "ورود به صف",
  send_started: "شروع ارسال",
  submitted: "ارسال شد",
  send_failed: "ارسال ناموفق",
  inquired: "استعلام",
  accepted: "پذیرفته شد",
  rejected: "رد شد",
  not_received: "دریافت نشده؛ ارسال مجدد",
  lease_expired: "قطع ارسال؛ استعلام",
  retry_requested: "درخواست تلاش مجدد",
  cancelled: "ابطال شد",
};

const ACTION_ENDPOINT: Partial<Record<TaxAction, (id: string) => string>> = {
  retry: (id) => `/api/ledger/tax-invoices/${id}/retry`,
  resubmit: (id) => `/api/ledger/tax-invoices/${id}/resubmit`,
  amend: (id) => `/api/ledger/tax-invoices/${id}/amend`,
  cancel: (id) => `/api/ledger/tax-invoices/${id}/cancel`,
};

function errorText(data: { error?: string; message?: string } | undefined): string {
  return data?.message ?? errorMessageOrRaw(data?.error);
}

function registerQuery(view: ViewChoice, status: string, kind: string, from: string, to: string, locationId: string, q: string, customerId: string, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (view !== "all") params.set("view", view);
  if (status) params.set("status", status);
  if (kind) params.set("kind", kind);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (locationId) params.set("locationId", locationId);
  if (q.trim()) params.set("q", q.trim());
  if (customerId) params.set("customerId", customerId);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export function TaxInvoicesSection({ refreshKey, capabilities: rawCapabilities }: { refreshKey: number; capabilities?: TaxInvoiceCapabilities }) {
  const money = useMoney();
  const capabilities = rawCapabilities ?? taxInvoiceCapabilitiesFor([]);
  const [tab, setTab] = useState<Tab>("register");
  const [locations, setLocations] = useState<TaxLocation[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!capabilities.view) return;
    let cancelled = false;
    void (async () => {
      const res = await api<{ units: { locationId: string; locationName: string }[] }>("/api/ledger/tax-invoices/settings");
      if (!cancelled && res.ok) setLocations(res.data.units.map((unit) => ({ id: unit.locationId, name: unit.locationName })));
    })();
    return () => {
      cancelled = true;
    };
  }, [capabilities.view, refreshKey]);

  const tabs = useMemo(() => {
    const list: { key: Tab; label: string }[] = [{ key: "register", label: "ثبت‌ها" }];
    list.push({ key: "unprepared", label: "فروش‌های آماده‌نشده" });
    if (capabilities.view) list.push({ key: "reports", label: "گزارش‌ها" });
    if (capabilities.manageSettings) list.push({ key: "settings", label: "مؤدی و تنظیمات" });
    return list;
  }, [capabilities.view, capabilities.manageSettings]);

  if (!capabilities.view) {
    return (
      <EmptyState title="دسترسی ندارید">
        برای دیدن صورتحساب‌های مؤدیان به دسترسی «مشاهده صورتحساب مؤدیان» نیاز است.
      </EmptyState>
    );
  }

  const changed = () => setReloadKey((n) => n + 1);

  return (
    <div className="space-y-5">
      <PageHeader
        title="صورتحساب مؤدیان"
        description="ارسال صورتحساب‌های الکترونیکی به سامانه مودیان، پیگیری پذیرش آن‌ها و تطبیق با فروش. هر رکورد پس از ساخت تغییر نمی‌کند؛ اصلاح و ابطال، رکورد تازه‌ای با پیوند به اصلی است."
      />
      <TabBar idPrefix="tax-invoices" label="بخش‌های صورتحساب مؤدیان" tabs={tabs} active={tab} onChange={setTab} />

      {tab === "register" ? (
        <RegisterPanel key={`r-${refreshKey}-${reloadKey}`} capabilities={capabilities} locations={locations} money={money} onChanged={changed} />
      ) : null}
      {tab === "unprepared" ? (
        <UnpreparedPanel key={`u-${refreshKey}-${reloadKey}`} capabilities={capabilities} locations={locations} money={money} onChanged={changed} onOpenSettings={() => setTab("settings")} />
      ) : null}
      {tab === "reports" && capabilities.view ? (
        <TaxInvoiceReports key={`p-${refreshKey}-${reloadKey}`} capabilities={capabilities} locations={locations} money={money} />
      ) : null}
      {tab === "settings" && capabilities.manageSettings ? (
        <TaxInvoiceSettings key={`s-${refreshKey}-${reloadKey}`} onSaved={changed} />
      ) : null}
    </div>
  );
}

type Money = ReturnType<typeof useMoney>;

function RegisterPanel({
  capabilities,
  locations,
  money,
  onChanged,
}: {
  capabilities: TaxInvoiceCapabilities;
  locations: TaxLocation[];
  money: Money;
  onChanged: () => void;
}) {
  const [view, setView] = useState<ViewChoice>("all");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [locationId, setLocationId] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState<TaxRegisterPage | null>(null);
  const [rows, setRows] = useState<TaxRegisterRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(
    async (nextCursor: string | null) => {
      setLoading(true);
      setLoadError("");
      const res = await api<TaxRegisterPage>(`/api/ledger/tax-invoices?${registerQuery(view, status, kind, from, to, locationId, q, customerId, nextCursor)}`);
      setLoading(false);
      if (!res.ok) {
        setLoadError(errorText(res.data as { error?: string; message?: string }));
        return;
      }
      setPage(res.data);
      setCursor(res.data.nextCursor);
      setRows((prev) => (nextCursor ? [...prev, ...res.data.rows] : res.data.rows));
    },
    [view, status, kind, from, to, locationId, q, customerId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runBatch = async (url: string, ids: string[] | null, label: string) => {
    setBusy(true);
    setNotice("");
    const res = await api<{ results?: { id?: string; status?: TaxStatus | null; skipped?: string | null }[] }>(url, {
      method: "POST",
      body: JSON.stringify(ids ? { ids } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setNotice(errorText(res.data as { error?: string; message?: string }));
      return;
    }
    const done = res.data.results?.length ?? 0;
    setNotice(`${label}: ${done} مورد پردازش شد.`);
    setSelected(new Set());
    onChanged();
    void load(null);
  };

  const sendSelected = () => runBatch("/api/ledger/tax-invoices/send", [...selected], "ارسال");
  const inquireSelected = () => runBatch("/api/ledger/tax-invoices/inquiry", [...selected], "استعلام");
  const inquireAllPending = () => runBatch("/api/ledger/tax-invoices/inquiry", null, "استعلام معلق‌ها");

  const exportUrl = `/api/ledger/tax-invoices/export?${registerQuery(view, status, kind, from, to, locationId, q, customerId)}`;
  const viewCounts = page?.counts;

  return (
    <div className="space-y-4">
      <SectionCard
        title="ثبت‌های صورتحساب"
        description="نمای ارسال‌نشده، ارسال‌شده و خطا؛ فیلترها را برای بازه، شعبه و خریدار تنظیم کنید."
        actions={
          capabilities.exportRegister ? (
            <SecondaryButton onClick={() => (window.location.href = exportUrl)}>خروجی CSV</SecondaryButton>
          ) : null
        }
      >
        <div className="space-y-3">
          <FilterChipRow label="نمای ثبت‌ها">
            <FilterChip selected={view === "all"} onClick={() => setView("all")}>
              همه{viewCounts ? ` (${viewCounts.total})` : ""}
            </FilterChip>
            {(["unsent", "sent", "error"] as TaxView[]).map((item) => (
              <FilterChip key={item} selected={view === item} onClick={() => setView(item)}>
                {TAX_VIEW_LABELS[item]}
                {viewCounts ? ` (${viewCounts[item]})` : ""}
              </FilterChip>
            ))}
          </FilterChipRow>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">وضعیت</span>
              <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">همه وضعیت‌ها</option>
                {TAX_STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {TAX_STATUS_LABELS[item]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">نوع</span>
              <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">همه</option>
                {(Object.keys(TAX_KIND_LABELS) as TaxKind[]).map((item) => (
                  <option key={item} value={item}>
                    {TAX_KIND_LABELS[item]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">شعبه</span>
              <select className={inputClass} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">همه شعبه‌ها</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <TaxCustomerFilter value={customerId} onChange={setCustomerId} />
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">جستجو</span>
              <input className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} placeholder="شماره ارجاع، شماره فروش یا خریدار" />
            </label>
            <div className="block">
              <span className="mb-1 block text-xs text-muted-foreground">از تاریخ فروش</span>
              <JalaliDatePicker value={from} onChange={setFrom} ariaLabel="از تاریخ فروش" clearable />
            </div>
            <div className="block">
              <span className="mb-1 block text-xs text-muted-foreground">تا تاریخ فروش</span>
              <JalaliDatePicker value={to} onChange={setTo} ariaLabel="تا تاریخ فروش" clearable />
            </div>
          </div>
        </div>
      </SectionCard>

      {notice ? <InfoBox>{notice}</InfoBox> : null}
      {loadError ? <ErrorBox>{loadError}</ErrorBox> : null}

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
          <span className="text-sm text-muted-foreground">{selected.size} مورد انتخاب شده</span>
          {capabilities.send ? (
            <PrimaryButton disabled={busy} type="button" onClick={sendSelected}>
              ارسال انتخاب‌شده‌ها
            </PrimaryButton>
          ) : null}
          {capabilities.inquire ? (
            <SecondaryButton disabled={busy} onClick={inquireSelected}>
              استعلام انتخاب‌شده‌ها
            </SecondaryButton>
          ) : null}
        </div>
      ) : null}
      {capabilities.inquire ? (
        <div className="flex justify-end">
          <SecondaryButton disabled={busy} onClick={inquireAllPending}>
            استعلام همهٔ معلق‌ها
          </SecondaryButton>
        </div>
      ) : null}

      {openId ? (
        <RecordDetail
          key={openId}
          id={openId}
          capabilities={capabilities}
          money={money}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            onChanged();
            void load(null);
          }}
        />
      ) : null}

      {rows.length === 0 && !loading && !loadError ? (
        <EmptyState title="ثبتی پیدا نشد">
          با این فیلترها صورتحسابی نیست. فروش‌های تکمیل‌شده را از تب «فروش‌های آماده‌نشده» آماده کنید.
        </EmptyState>
      ) : (
        <DataTable caption="ثبت‌های صورتحساب مؤدیان">
          <DataTableHead>
              <Th className="w-10">
                <span className="sr-only">انتخاب</span>
              </Th>
              <Th>شماره ارجاع</Th>
              <Th>نوع</Th>
              <Th>فروش</Th>
              <Th>تاریخ فروش</Th>
              <Th>شعبه</Th>
              <Th>خریدار</Th>
              <Th numeric>مبلغ کل</Th>
              <Th>وضعیت</Th>
              <Th numeric>تلاش</Th>
              <Th>عملیات</Th>
          </DataTableHead>
          <DataTableBody>
            {rows.map((row) => (
              <DataTableRow key={row.id} selected={selected.has(row.id)}>
                <Td>
                  <input
                    type="checkbox"
                    className="size-4 rounded border-border text-primary focus-visible:ring-ring/50"
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                    aria-label={`انتخاب ${row.referenceNumber}`}
                  />
                </Td>
                <Td nowrap>
                  <span className="font-mono text-xs" dir="ltr">
                    {row.referenceNumber}
                  </span>
                  {row.environment === "sandbox" ? (
                    <span className="mr-2">
                      <StatusBadge tone="neutral">آزمایشی</StatusBadge>
                    </span>
                  ) : null}
                </Td>
                <Td>{TAX_KIND_LABELS[row.kind]}{row.revision > 1 ? ` (نسخه ${row.revision})` : ""}</Td>
                <Td numeric>{row.orderNumber ?? "—"}</Td>
                <Td nowrap>{row.closedAt ? formatJalali(row.closedAt) : "—"}</Td>
                <Td>{row.locationName ?? "—"}</Td>
                <Td>{row.buyerName ?? "—"}</Td>
                <Td numeric nowrap>{money.format(row.totalRial)}</Td>
                <Td>
                  <StatusBadge tone={taxStatusTone(row.status)}>{TAX_STATUS_LABELS[row.status]}</StatusBadge>
                  {row.lastErrorCode ? <div className="mt-1 text-xs text-muted-foreground">{row.lastErrorCode}</div> : null}
                </Td>
                <Td numeric>{row.attempts}</Td>
                <Td>
                  <SecondaryButton onClick={() => setOpenId(row.id)}>جزئیات</SecondaryButton>
                </Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}

      {cursor ? (
        <div className="flex justify-center">
          <SecondaryButton disabled={loading} onClick={() => void load(cursor)}>
            {loading ? "در حال بارگذاری…" : "نمایش بیشتر"}
          </SecondaryButton>
        </div>
      ) : null}
    </div>
  );
}

function RecordDetail({
  id,
  capabilities,
  money,
  onClose,
  onChanged,
}: {
  id: string;
  capabilities: TaxInvoiceCapabilities;
  money: Money;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [record, setRecord] = useState<TaxRecordDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasonFor, setReasonFor] = useState<"amend" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");

  const reload = useCallback(async () => {
    const res = await api<{ record: TaxRecordDetail }>(`/api/ledger/tax-invoices/${id}`);
    if (!res.ok) {
      setError(errorText(res.data as { error?: string; message?: string }));
      return;
    }
    setRecord(res.data.record);
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!record) return <LoadingSkeleton rows={4} label="در حال بارگذاری جزئیات" />;

  const allowed = availableTaxActions(record).filter((action) => {
    if (action === "send" || action === "retry") return capabilities.send;
    if (action === "inquire") return capabilities.inquire;
    if (action === "resubmit") return capabilities.prepare;
    if (action === "amend") return capabilities.amend;
    if (action === "cancel") return capabilities.cancel;
    return false;
  });

  const runAction = async (action: TaxAction) => {
    setBusy(true);
    setMessage("");
    type Reply = { error?: string; message?: string };
    let res: { ok: boolean; data: Reply };
    if (action === "send") {
      res = await api<Reply>(`/api/ledger/tax-invoices/send`, { method: "POST", body: JSON.stringify({ ids: [id] }) });
    } else if (action === "inquire") {
      res = await api<Reply>(`/api/ledger/tax-invoices/inquiry`, { method: "POST", body: JSON.stringify({ ids: [id] }) });
    } else {
      const body = action === "amend" || action === "cancel" ? JSON.stringify({ reason }) : undefined;
      res = await api<Reply>(ACTION_ENDPOINT[action]!(id), { method: "POST", body });
    }
    setBusy(false);
    if (!res.ok) {
      setMessage(errorText(res.data));
      return;
    }
    setReasonFor(null);
    setReason("");
    setMessage(`${TAX_ACTION_LABELS[action]} انجام شد.`);
    await reload();
    onChanged();
  };

  return (
    <SectionCard
      title={`${TAX_KIND_LABELS[record.kind]} ${record.referenceNumber}`}
      description={`${TAX_STATUS_LABELS[record.status]} · ${TAX_ENVIRONMENT_LABELS[record.environment]}`}
      actions={<SecondaryButton onClick={onClose}>بستن</SecondaryButton>}
    >
      <div className="space-y-5">
        {message ? <InfoBox>{message}</InfoBox> : null}
        {record.retentionHoldAt ? <ErrorBox>شواهد متناقض یا نامشخص ارائه‌دهنده ثبت شده است. نگهداری دائمی و توقف ارسال برای این فروش اعمال شده؛ بررسی انسانی با ارائه‌دهنده لازم است.</ErrorBox> : null}
        {record.lastErrorMessage ? <ErrorBox>{record.lastErrorMessage}</ErrorBox> : null}
        {record.providerErrors.length > 0 ? (
          <ul className="list-disc space-y-1 ps-5 text-sm text-destructive">
            {record.providerErrors.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                {issue.message}
                {issue.field ? ` (${issue.field})` : ""}
              </li>
            ))}
          </ul>
        ) : null}

        <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
          <Meta label="شناسه یکتای ارسال" value={record.uid} ltr />
          <Meta label="شناسه رسید سامانه" value={record.receiptId ?? "—"} ltr />
          <Meta label="فروش" value={record.orderNumber ? `شمارهٔ ${record.orderNumber} — ${record.locationName ?? ""}` : "—"} />
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">فروش اصلی</dt>
            <dd>
              <Link href={`/accounting/orders?order=${record.orderId}`} className="text-primary underline-offset-4 hover:underline">
                باز کردن فروش
              </Link>
            </dd>
          </div>
          <Meta label="تاریخ فروش" value={record.closedAt ? formatJalali(record.closedAt, { withTime: true }) : "—"} />
          <Meta label="زمان آماده‌سازی" value={formatJalali(record.preparedAt, { withTime: true })} />
          <Meta label="زمان ارسال" value={record.submittedAt ? formatJalali(record.submittedAt, { withTime: true }) : "—"} />
          <Meta label="زمان پذیرش" value={record.acceptedAt ? formatJalali(record.acceptedAt, { withTime: true }) : "—"} />
          <Meta label="تعداد تلاش" value={String(record.attempts)} />
          <Meta label="خریدار" value={record.buyerName ?? "مصرف‌کننده"} />
          <Meta label="جمع کل / مالیات" value={`${money.format(record.totalRial)} / ${money.format(record.vatRial)}`} />
          <Meta label="هش محتوای ارسالی" value={record.payloadHash} ltr />
          <Meta label="نسخهٔ قالب" value={record.payloadVersion} ltr />
        </dl>

        {record.archivedAt && capabilities.exportRegister ? (
          <SecondaryButton onClick={() => { window.location.href = `/api/ledger/tax-invoices/archive?submissionId=${id}`; }}>دریافت بایگانی JSON</SecondaryButton>
        ) : null}
        {record.archivedAt ? <InfoBox>بایگانی دائمی: {formatJalali(record.archivedAt, { withTime: true })}</InfoBox> : null}

        {allowed.length > 0 ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {allowed.map((action) =>
                action === "amend" || action === "cancel" ? (
                  <SecondaryButton key={action} disabled={busy} onClick={() => setReasonFor(action)}>
                    {TAX_ACTION_LABELS[action]}
                  </SecondaryButton>
                ) : (
                  <PrimaryButton key={action} disabled={busy} type="button" onClick={() => void runAction(action)}>
                    {TAX_ACTION_LABELS[action]}
                  </PrimaryButton>
                ),
              )}
            </div>
            {reasonFor ? (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">
                    {reasonFor === "cancel" ? "دلیل ابطال (الزامی، در گزارش ثبت می‌شود)" : "دلیل اصلاح (الزامی، در گزارش ثبت می‌شود)"}
                  </span>
                  <textarea className={inputClass} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
                <div className="flex gap-2">
                  <PrimaryButton disabled={busy || reason.trim().length < 3} type="button" onClick={() => void runAction(reasonFor)}>
                    ثبت {TAX_ACTION_LABELS[reasonFor]}
                  </PrimaryButton>
                  <SecondaryButton onClick={() => setReasonFor(null)}>انصراف</SecondaryButton>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {record.siblings.length > 0 ? (
          <div className="text-sm">
            <span className="font-medium">سایر ثبت‌های همین فروش: </span>
            {record.siblings.map((sibling) => `${TAX_KIND_LABELS[sibling.kind]} ${sibling.referenceNumber} (${TAX_STATUS_LABELS[sibling.status]})`).join("، ")}
          </div>
        ) : null}

        <div>
          <h3 className="mb-2 text-sm font-medium">اقلام ارسال‌شده (همان‌طور که ذخیره شده)</h3>
          <DataTable caption="اقلام صورتحساب">
            <DataTableHead>
              <Th>ردیف</Th>
              <Th>کالا/خدمت</Th>
              <Th>شناسه</Th>
              <Th numeric>تعداد</Th>
              <Th numeric>قیمت واحد</Th>
              <Th numeric>مالیات</Th>
              <Th numeric>جمع</Th>
            </DataTableHead>
            <DataTableBody>
              {record.payloadSnapshot.lines.map((line) => (
                <DataTableRow key={line.no}>
                  <Td>{line.no}</Td>
                  <Td>{line.name}</Td>
                  <Td nowrap><span className="font-mono text-xs" dir="ltr">{line.taxCode}</span></Td>
                  <Td numeric>{line.quantity}</Td>
                  <Td numeric nowrap>{money.format(line.unitPriceRial)}</Td>
                  <Td numeric nowrap>{money.format(line.vatRial)}</Td>
                  <Td numeric nowrap>{money.format(line.totalRial)}</Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">تاریخچه (ثبت‌شده و غیرقابل ویرایش)</h3>
          <EventList events={record.events} />
        </div>
      </div>
    </SectionCard>
  );
}

function Meta({ label, value, ltr = false }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`break-all ${ltr ? "font-mono text-xs" : ""}`} dir={ltr ? "ltr" : undefined}>
        {value}
      </dd>
    </div>
  );
}

function EventList({ events }: { events: TaxEventRow[] }) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">رویدادی ثبت نشده است.</p>;
  return (
    <ol className="space-y-2 text-sm">
      {events.map((event) => (
        <li key={event.id} className="flex flex-wrap gap-x-3 gap-y-1 border-s-2 border-border ps-3">
          <span className="text-xs text-muted-foreground">{formatJalali(event.createdAt, { withTime: true })}</span>
          <span className="font-medium">{EVENT_LABELS[event.eventType] ?? event.eventType}</span>
          {event.fromStatus || event.toStatus ? (
            <span className="text-muted-foreground">
              {event.fromStatus ? TAX_STATUS_LABELS[event.fromStatus] : "—"} ← {event.toStatus ? TAX_STATUS_LABELS[event.toStatus] : "—"}
            </span>
          ) : null}
          <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">{event.correlationId.slice(0, 8)}</span>
        </li>
      ))}
    </ol>
  );
}

function UnpreparedPanel({
  capabilities,
  locations,
  money,
  onChanged,
  onOpenSettings,
}: {
  capabilities: TaxInvoiceCapabilities;
  locations: TaxLocation[];
  money: Money;
  onChanged: () => void;
  onOpenSettings: () => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [locationId, setLocationId] = useState("");
  const [sales, setSales] = useState<UnpreparedSale[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [results, setResults] = useState<PrepareResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (locationId) params.set("locationId", locationId);
    const res = await api<{ sales: UnpreparedSale[] }>(`/api/ledger/tax-invoices/unprepared?${params.toString()}`);
    if (!res.ok) {
      setError(errorText(res.data as { error?: string; message?: string }));
      return;
    }
    setError("");
    setSales(res.data.sales);
  }, [from, to, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const prepare = async () => {
    setBusy(true);
    setError("");
    const res = await api<{ results: PrepareResult[] }>(`/api/ledger/tax-invoices/prepare`, {
      method: "POST",
      body: JSON.stringify({ orderIds: [...selected] }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res.data as { error?: string; message?: string }));
      return;
    }
    setResults(res.data.results);
    setSelected(new Set());
    onChanged();
    void load();
  };

  const allSelected = sales !== null && sales.length > 0 && selected.size === sales.length;

  return (
    <div className="space-y-4">
      <SectionCard
        title="فروش‌های آماده‌نشده"
        description="فروش‌های تکمیل‌شده که هنوز صورتحساب ندارند. آماده‌سازی چیزی را ارسال نمی‌کند؛ ارسال جداگانه انجام می‌شود."
        actions={
          capabilities.prepare ? (
            <PrimaryButton disabled={busy || selected.size === 0} type="button" onClick={() => void prepare()}>
              آماده‌سازی {selected.size > 0 ? `(${selected.size})` : ""}
            </PrimaryButton>
          ) : null
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="block">
            <span className="mb-1 block text-xs text-muted-foreground">از تاریخ فروش</span>
            <JalaliDatePicker value={from} onChange={setFrom} ariaLabel="از تاریخ فروش" clearable />
          </div>
          <div className="block">
            <span className="mb-1 block text-xs text-muted-foreground">تا تاریخ فروش</span>
            <JalaliDatePicker value={to} onChange={setTo} ariaLabel="تا تاریخ فروش" clearable />
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">شعبه</span>
            <select className={inputClass} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">همه شعبه‌ها</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </SectionCard>

      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {results ? (
        <SectionCard title="نتیجهٔ آماده‌سازی" actions={<SecondaryButton onClick={() => setResults(null)}>بستن</SecondaryButton>}>
          <ul className="space-y-2 text-sm">
            {results.map((result) => (
              <li key={result.orderId} className="flex flex-wrap items-start gap-2">
                <StatusBadge tone={result.outcome === "prepared" ? "positive" : result.outcome === "existing" ? "neutral" : "danger"}>
                  {result.outcome === "prepared" ? "آماده شد" : result.outcome === "existing" ? "قبلاً آماده بود" : result.outcome === "blocked" ? "مسدود" : "ناموفق"}
                </StatusBadge>
                {result.reference ? <span className="font-mono text-xs" dir="ltr">{result.reference}</span> : null}
                {result.blockers.map((blocker, index) => (
                  <span key={`${blocker.code}-${index}`} className="text-destructive">
                    {blocker.message}
                  </span>
                ))}
                {result.error ? <span className="text-destructive">{errorMessageOrRaw(result.error)}</span> : null}
              </li>
            ))}
          </ul>
          {results.some((result) => result.blockers.some((blocker) => blocker.code === "item_code_missing")) && capabilities.manageSettings ? (
            <div className="mt-3">
              <SecondaryButton onClick={onOpenSettings}>تکمیل شناسه کالا/خدمت</SecondaryButton>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {sales === null ? (
        <LoadingSkeleton rows={3} label="در حال بارگذاری ثبت‌ها" />
      ) : sales.length === 0 ? (
        <EmptyState title="همه فروش‌ها آماده‌اند">فروش تکمیل‌شده‌ای بدون صورتحساب در این بازه نیست.</EmptyState>
      ) : (
        <DataTable caption="فروش‌های آماده‌نشده">
          <DataTableHead>
            <Th className="w-10">
              <input
                type="checkbox"
                className="size-4 rounded border-border text-primary focus-visible:ring-ring/50"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(sales.map((sale) => sale.orderId)))}
                aria-label="انتخاب همه"
              />
            </Th>
            <Th numeric>شمارهٔ فروش</Th>
            <Th>تاریخ</Th>
            <Th>شعبه</Th>
            <Th>خریدار</Th>
            <Th numeric>مبلغ کل</Th>
            <Th numeric>مالیات</Th>
            <Th>شناسه کالا</Th>
          </DataTableHead>
          <DataTableBody>
            {sales.map((sale) => (
              <DataTableRow key={sale.orderId} selected={selected.has(sale.orderId)}>
                <Td>
                  <input
                    type="checkbox"
                    className="size-4 rounded border-border text-primary focus-visible:ring-ring/50"
                    checked={selected.has(sale.orderId)}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(sale.orderId)) next.delete(sale.orderId);
                        else next.add(sale.orderId);
                        return next;
                      })
                    }
                    aria-label={`انتخاب فروش ${sale.orderNumber}`}
                  />
                </Td>
                <Td numeric>{sale.orderNumber}</Td>
                <Td nowrap>{formatJalali(sale.closedAt, { withTime: true })}</Td>
                <Td>{sale.locationName}</Td>
                <Td>{sale.buyerName ?? "مصرف‌کننده"}</Td>
                <Td numeric nowrap>{money.format(sale.totalRial)}</Td>
                <Td numeric nowrap>{money.format(sale.vatRial)}</Td>
                <Td>
                  {sale.uncodedLines > 0 ? (
                    <StatusBadge tone="danger">{sale.uncodedLines} قلم بدون شناسه</StatusBadge>
                  ) : (
                    <StatusBadge tone="positive">کامل</StatusBadge>
                  )}
                </Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </div>
  );
}
