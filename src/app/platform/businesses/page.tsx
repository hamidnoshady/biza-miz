"use client";

/**
 * The business directory — the console's most-used operations surface.
 *
 * Server-backed search / filter / sort / pagination (task sections 6 + 7): the
 * page reflects its filters into the URL and asks the API for exactly one page,
 * rather than fetching every business and slicing in the browser. Provisioning
 * lives in its own wizard dialog, not inline in the list body.
 */
import { Suspense, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PlusIcon, ExternalLinkIcon, MoreHorizontalIcon } from "lucide-react";
import { INDUSTRY_LABELS, INDUSTRIES, type Industry } from "@/lib/industries";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PlatformPageHeader,
  PlatformPageContainer,
  PlatformStat,
  PlatformDataTable,
  PlatformFilterBar,
  PlatformSearch,
  PlatformRefreshButton,
  PlatformPagination,
  BusinessStatusBadge,
  PlatformStatusBadge,
  PermissionGate,
  type Column,
  type SortDirection,
} from "@/components/platform";
import { usePlatformQuery } from "../_lib/use-platform-data";
import { useUrlFilters, useDebouncedValue } from "../_lib/use-url-filters";
import { fmtDate, fmtRelative, formatPersianNumber } from "@/lib/platform-format";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { ProvisionDialog } from "./components/provision-dialog";
import { PlanBadge, inputClass } from "../ui";

interface Business {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  status: string;
  plan: string;
  industry: Industry;
  locationCount: number;
  memberCount: number;
  orderCount: number;
  lastActivityAt: string | null;
  createdAt: string;
}

/**
 * `statusCounts` are server-side aggregates over the current filter context
 * (search / plan / industry / activity / created range), so they answer "how
 * many are suspended in what I am looking at?" rather than restating the page.
 */
interface StatusCounts {
  total: number;
  active: number;
  suspended: number;
  archived: number;
}

interface ListResponse {
  businesses: Business[];
  rootDomain?: string;
  /** Distinct plan keys in use — the plan filter's options. */
  plans?: string[];
  meta?: { total: number; page: number; pageSize: number; statusCounts?: StatusCounts };
}

const PAGE_SIZE = 20;

function isPlaceholderSubdomain(subdomain: string): boolean {
  return /^biz-[0-9a-f]{8}$/i.test(subdomain);
}

const DEFAULTS = {
  search: "",
  status: "",
  plan: "",
  industry: "",
  activity: "",
  // ISO dates, but chosen through the Shamsi calendar (JalaliDatePicker) — a
  // native date input would open a Gregorian one.
  from: "",
  to: "",
  sort: "newest",
  page: "1",
};

function BusinessesInner() {
  const router = useRouter();
  const { values, set, reset, isFiltered } = useUrlFilters(DEFAULTS);
  const [showProvision, setShowProvision] = useState(false);

  const debouncedSearch = useDebouncedValue(values.search, 350);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (values.status) params.set("status", values.status);
    if (values.plan) params.set("plan", values.plan);
    if (values.industry) params.set("industry", values.industry);
    if (values.activity) params.set("activity", values.activity);
    if (values.from) params.set("from", values.from);
    if (values.to) params.set("to", values.to);
    if (values.sort) params.set("sort", values.sort);
    params.set("page", values.page || "1");
    params.set("pageSize", String(PAGE_SIZE));
    return `/api/platform/businesses?${params.toString()}`;
  }, [debouncedSearch, values.status, values.plan, values.industry, values.activity, values.from, values.to, values.sort, values.page]);

  const query = usePlatformQuery<ListResponse>(url, [url]);
  const businesses = query.data?.businesses ?? null;
  const meta = query.data?.meta;
  const statusCounts = meta?.statusCounts;
  const planOptions = query.data?.plans ?? [];
  const rootDomain = query.data?.rootDomain ?? "";
  const page = Number(values.page) || 1;

  const sortDir: SortDirection = values.sort === "oldest" ? "asc" : "desc";
  const sortKey =
    values.sort === "newest" || values.sort === "oldest"
      ? "createdAt"
      : values.sort === "orders"
        ? "orderCount"
        : values.sort === "members"
          ? "memberCount"
          : values.sort === "activity"
            ? "lastActivityAt"
            : values.sort === "name"
              ? "name"
              : "createdAt";

  function handleSort(key: string, dir: SortDirection) {
    const mapped =
      key === "createdAt"
        ? dir === "asc"
          ? "oldest"
          : "newest"
        : key === "orderCount"
          ? "orders"
          : key === "memberCount"
            ? "members"
            : key === "lastActivityAt"
              ? "activity"
              : key === "name"
                ? "name"
                : "newest";
    set({ sort: mapped, page: "1" });
  }

  const columns: Column<Business>[] = [
    {
      key: "name",
      header: "نام",
      sortable: true,
      cell: (b) => (
        <div className="min-w-0">
          <Link
            href={`/platform/businesses/${b.id}`}
            className="font-medium text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {b.name}
          </Link>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span dir="ltr">{b.subdomain}</span>
            {isPlaceholderSubdomain(b.subdomain) ? (
              <PlatformStatusBadge tone="warning" label="زیردامنه موقت" />
            ) : null}
          </div>
        </div>
      ),
    },
    { key: "industry", header: "نوع", hideOnMobile: true, cell: (b) => INDUSTRY_LABELS[b.industry] ?? b.industry },
    { key: "status", header: "وضعیت", cell: (b) => <BusinessStatusBadge status={b.status} dot /> },
    { key: "plan", header: "پلن", cell: (b) => <PlanBadge plan={b.plan} /> },
    {
      key: "memberCount",
      header: "اعضا",
      sortable: true,
      align: "end",
      cell: (b) => <span className="tabular-nums">{formatPersianNumber(b.memberCount)}</span>,
    },
    {
      key: "orderCount",
      header: "سفارش",
      sortable: true,
      align: "end",
      cell: (b) => <span className="tabular-nums">{formatPersianNumber(b.orderCount)}</span>,
    },
    {
      key: "lastActivityAt",
      header: "آخرین فعالیت",
      sortable: true,
      hideOnMobile: true,
      cell: (b) => <span className="whitespace-nowrap text-muted-foreground">{fmtRelative(b.lastActivityAt)}</span>,
    },
    {
      key: "createdAt",
      header: "ایجاد",
      sortable: true,
      hideOnMobile: true,
      cell: (b) => <span className="whitespace-nowrap text-muted-foreground">{fmtDate(b.createdAt)}</span>,
    },
  ];

  return (
    <PlatformPageContainer>
      <PlatformPageHeader
        title="کسب‌وکارها"
        description="فهرست، جستجو و مدیریت همهٔ کسب‌وکارهای سکو"
        actions={
          <>
            <PlatformRefreshButton onClick={query.refetch} refreshing={query.refreshing} />
            <PermissionGate require="business.provision">
              <Button onClick={() => setShowProvision(true)}>
                <PlusIcon aria-hidden="true" />
                <span className="hidden sm:inline">ایجاد کسب‌وکار</span>
              </Button>
            </PermissionGate>
          </>
        }
      />

      {statusCounts ? (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <PlatformStat
            label="کل نتایج"
            value={formatPersianNumber(statusCounts.total)}
            hint="با فیلترهای فعلی"
          />
          <PlatformStat
            label="فعال"
            value={formatPersianNumber(statusCounts.active)}
            tone="success"
            href="/platform/businesses?status=active"
          />
          <PlatformStat
            label="معلق"
            value={formatPersianNumber(statusCounts.suspended)}
            tone="warning"
            href="/platform/businesses?status=suspended"
          />
          <PlatformStat
            label="بایگانی"
            value={formatPersianNumber(statusCounts.archived)}
            tone="muted"
            href="/platform/businesses?status=archived"
          />
        </div>
      ) : null}

      <PlatformFilterBar
        onReset={reset}
        isFiltered={isFiltered}
        resultCount={meta?.total}
      >
        <PlatformSearch
          value={values.search}
          onChange={(v) => set({ search: v, page: "1" })}
          placeholder="نام، شناسه یا زیردامنه…"
        />
        <FilterSelect
          value={values.status}
          onChange={(v) => set({ status: v, page: "1" })}
          placeholder="همه وضعیت‌ها"
          options={[
            { value: "active", label: "فعال" },
            { value: "suspended", label: "معلق" },
            { value: "archived", label: "بایگانی" },
          ]}
        />
        <FilterSelect
          value={values.industry}
          onChange={(v) => set({ industry: v, page: "1" })}
          placeholder="همه انواع"
          options={INDUSTRIES.map((i) => ({ value: i, label: INDUSTRY_LABELS[i] }))}
        />
        <FilterSelect
          value={values.plan}
          onChange={(v) => set({ plan: v, page: "1" })}
          placeholder="همه پلن‌ها"
          options={planOptions.map((p) => ({ value: p, label: p }))}
        />
        <FilterSelect
          value={values.activity}
          onChange={(v) => set({ activity: v, page: "1" })}
          placeholder="همه"
          options={[
            { value: "active", label: "دارای سفارش" },
            { value: "idle", label: "بدون سفارش" },
          ]}
        />
        <div className="flex items-center gap-2">
          <span className="text-xs whitespace-nowrap text-muted-foreground">ایجاد از</span>
          <div className="w-36">
            <JalaliDatePicker
              value={values.from}
              onChange={(iso) => set({ from: iso, page: "1" })}
              className={inputClass}
              ariaLabel="تاریخ ایجاد از"
            />
          </div>
          <span className="text-xs whitespace-nowrap text-muted-foreground">تا</span>
          <div className="w-36">
            <JalaliDatePicker
              value={values.to}
              onChange={(iso) => set({ to: iso, page: "1" })}
              className={inputClass}
              ariaLabel="تاریخ ایجاد تا"
            />
          </div>
        </div>
      </PlatformFilterBar>

      <PlatformDataTable
        columns={columns}
        rows={businesses}
        rowKey={(b) => b.id}
        loading={query.loading}
        error={query.errorText}
        errorStatus={query.errorStatus}
        onRetry={query.refetch}
        isFiltered={isFiltered}
        onResetFilters={reset}
        onRowClick={(b) => router.push(`/platform/businesses/${b.id}`)}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        emptyTitle="هنوز کسب‌وکاری ثبت نشده است."
        rowActions={(b) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="عملیات">
                <MoreHorizontalIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/platform/businesses/${b.id}`}>باز کردن میز کار</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/platform/businesses/${b.id}/billing?tab=subscription`}>صورت‌حساب و اشتراک</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/platform/businesses/${b.id}/billing?tab=wallet`}>کیف پول و پرداخت</Link>
              </DropdownMenuItem>
              {rootDomain ? (
                <DropdownMenuItem asChild>
                  <a href={`https://${b.subdomain}.${rootDomain}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5">
                    <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                    مشاهدهٔ سایت
                  </a>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      />

      {meta ? (
        <PlatformPagination
          page={page}
          pageSize={PAGE_SIZE}
          total={meta.total}
          onPageChange={(p) => set({ page: String(p) })}
        />
      ) : null}

      <PermissionGate require="business.provision">
        <ProvisionDialog
          open={showProvision}
          onOpenChange={setShowProvision}
          rootDomain={rootDomain}
          onCreated={() => {
            setShowProvision(false);
            query.refetch();
          }}
        />
      </PermissionGate>
    </PlatformPageContainer>
  );
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: { value: string; label: string }[];
}) {
  const ALL = "__all__";
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger className="w-auto min-w-[9rem]">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function BusinessesPage() {
  return (
    <Suspense fallback={null}>
      <BusinessesInner />
    </Suspense>
  );
}
