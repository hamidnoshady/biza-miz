"use client";

/**
 * The platform audit log — an investigation tool with real server-side
 * pagination and filtering (task section 12).
 *
 * Every privileged cross-tenant action, newest first: who did it, to which
 * business, when, and — in the detail drawer — the structured payload. The list
 * stays compact and chronological; the large JSON never lands in the primary
 * table. Filters live in the URL so a scoped view survives refresh and can be
 * shared. Read-only; the log is immutable.
 */
import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { Button } from "@/components/ui/button";
import {
  PlatformPageHeader,
  PlatformPageContainer,
  PlatformDataTable,
  PlatformFilterBar,
  PlatformSearch,
  PlatformRefreshButton,
  PlatformPagination,
  PlatformStatusBadge,
  PlatformDetailDrawer,
  PlatformDetailSection,
  PlatformDetailRow,
  type Column,
} from "@/components/platform";
import { usePlatformQuery } from "../_lib/use-platform-data";
import { useUrlFilters, useDebouncedValue } from "../_lib/use-url-filters";
import { fmtDateTime, fmtRelative } from "@/lib/platform-format";
import { auditMetaFor, AUDIT_ACTION_FAMILIES } from "./action-meta";

interface AuditEntry {
  id: string;
  adminName: string | null;
  businessId: string | null;
  businessName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  payload: unknown;
  createdAt: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  meta?: { total: number; page: number; pageSize: number };
}

const PAGE_SIZE = 40;

const DEFAULTS = {
  search: "",
  actionFamily: "",
  businessId: "",
  from: "",
  to: "",
  page: "1",
};

function AuditInner() {
  const { values, set, reset, isFiltered } = useUrlFilters(DEFAULTS);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const debouncedSearch = useDebouncedValue(values.search, 350);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (values.actionFamily) params.set("actionFamily", values.actionFamily);
    if (values.businessId) params.set("businessId", values.businessId);
    if (values.from) params.set("from", values.from);
    if (values.to) params.set("to", values.to);
    params.set("page", values.page || "1");
    params.set("pageSize", String(PAGE_SIZE));
    return `/api/platform/audit?${params.toString()}`;
  }, [debouncedSearch, values.actionFamily, values.businessId, values.from, values.to, values.page]);

  const query = usePlatformQuery<AuditResponse>(url, [url]);
  const entries = query.data?.entries ?? null;
  const meta = query.data?.meta;
  const page = Number(values.page) || 1;

  const columns: Column<AuditEntry>[] = [
    {
      key: "action",
      header: "رویداد",
      cell: (e) => {
        const meta = auditMetaFor(e.action);
        const Icon = meta.icon;
        return (
          <span className="flex items-center gap-2">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <PlatformStatusBadge tone={meta.tone} label={meta.label} />
          </span>
        );
      },
    },
    {
      key: "business",
      header: "کسب‌وکار",
      cell: (e) =>
        e.businessName ? (
          <Link
            href={`/platform/businesses/${e.businessId}`}
            className="text-primary hover:underline"
            onClick={(ev) => ev.stopPropagation()}
          >
            {e.businessName}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: "admin", header: "مدیر", hideOnMobile: true, cell: (e) => e.adminName ?? "سیستم" },
    {
      key: "createdAt",
      header: "زمان",
      align: "end",
      cell: (e) => (
        <span className="whitespace-nowrap text-muted-foreground" title={fmtDateTime(e.createdAt)}>
          {fmtRelative(e.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <PlatformPageContainer width="wide">
      <PlatformPageHeader
        title="رویدادها"
        description="هر اقدام مدیریتی روی کسب‌وکارها — چه کسی، روی کدام کسب‌وکار، چه زمانی."
        actions={<PlatformRefreshButton onClick={query.refetch} refreshing={query.refreshing} />}
      />

      <PlatformFilterBar onReset={reset} isFiltered={isFiltered} resultCount={meta?.total}>
        <PlatformSearch
          value={values.search}
          onChange={(v) => set({ search: v, page: "1" })}
          placeholder="جستجو در مدیر، کسب‌وکار، اقدام یا شناسه…"
        />
        <Select
          value={values.actionFamily || "__all__"}
          onValueChange={(v) => set({ actionFamily: v === "__all__" ? "" : v, page: "1" })}
        >
          <SelectTrigger className="w-auto min-w-[10rem]">
            <SelectValue placeholder="همه اقدام‌ها" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">همه اقدام‌ها</SelectItem>
            {AUDIT_ACTION_FAMILIES.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Jalali pickers: a native <input type="date"> opens a Gregorian calendar.
            The value stays ISO (YYYY-MM-DD) in the URL and on the wire. */}
        <JalaliDatePicker
          value={values.from}
          onChange={(iso) => set({ from: iso, page: "1" })}
          ariaLabel="از تاریخ"
          placeholder="از تاریخ"
          popoverClass="border-border bg-popover text-foreground"
        />
        <JalaliDatePicker
          value={values.to}
          onChange={(iso) => set({ to: iso, page: "1" })}
          ariaLabel="تا تاریخ"
          placeholder="تا تاریخ"
          popoverClass="border-border bg-popover text-foreground"
        />
      </PlatformFilterBar>

      <PlatformDataTable
        columns={columns}
        rows={entries}
        rowKey={(e) => e.id}
        loading={query.loading}
        error={query.errorText}
        errorStatus={query.errorStatus}
        onRetry={query.refetch}
        isFiltered={isFiltered}
        onResetFilters={reset}
        onRowClick={(e) => setSelected(e)}
        emptyTitle="هنوز رویدادی ثبت نشده است."
        emptyDescription="با اولین اقدام مدیریتی، اینجا پر می‌شود."
      />

      {meta ? (
        <PlatformPagination
          page={page}
          pageSize={PAGE_SIZE}
          total={meta.total}
          onPageChange={(p) => set({ page: String(p) })}
        />
      ) : null}

      <AuditDetailDrawer entry={selected} onClose={() => setSelected(null)} />
    </PlatformPageContainer>
  );
}

function AuditDetailDrawer({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  const meta = entry ? auditMetaFor(entry.action) : null;
  return (
    <PlatformDetailDrawer
      open={Boolean(entry)}
      onOpenChange={(v) => !v && onClose()}
      title={meta?.label ?? "رویداد"}
      description={entry ? fmtDateTime(entry.createdAt) : undefined}
    >
      {entry ? (
        <>
          <PlatformDetailSection title="جزئیات">
            <PlatformDetailRow label="اقدام">
              <span dir="ltr" className="font-mono text-xs">
                {entry.action}
              </span>
            </PlatformDetailRow>
            <PlatformDetailRow label="مدیر">{entry.adminName ?? "سیستم"}</PlatformDetailRow>
            <PlatformDetailRow label="کسب‌وکار">
              {entry.businessName ? (
                <Link
                  href={`/platform/businesses/${entry.businessId}`}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {entry.businessName}
                  <ExternalLinkIcon className="size-3.5" />
                </Link>
              ) : (
                "—"
              )}
            </PlatformDetailRow>
            {entry.entity ? (
              <PlatformDetailRow label="موجودیت">
                <span dir="ltr" className="font-mono text-xs">
                  {entry.entity}
                </span>
              </PlatformDetailRow>
            ) : null}
            {entry.entityId ? (
              <PlatformDetailRow label="شناسه">
                <span dir="ltr" className="font-mono text-xs break-all">
                  {entry.entityId}
                </span>
              </PlatformDetailRow>
            ) : null}
          </PlatformDetailSection>

          {entry.payload && Object.keys(entry.payload as object).length > 0 ? (
            <PlatformDetailSection title="داده‌ها">
              <pre
                dir="ltr"
                className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs leading-6"
              >
                {JSON.stringify(entry.payload, null, 2)}
              </pre>
            </PlatformDetailSection>
          ) : null}
        </>
      ) : null}
    </PlatformDetailDrawer>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={null}>
      <AuditInner />
    </Suspense>
  );
}
