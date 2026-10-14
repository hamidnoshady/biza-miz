"use client";

/**
 * The super-admin support desk (migration 0130) — every business's tickets in
 * one console, rebuilt on the shared kit with real server-side pagination and
 * filtering (task sections 6 + 26). The list carries no attachments or full
 * conversations; the drawer loads a ticket's thread on demand and hosts the
 * operator's write actions. Filters and the current page live in the URL so a
 * scoped queue survives a refresh and can be shared with a colleague.
 */
import { Suspense, useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  Clock3Icon,
  InboxIcon,
  UserRoundIcon,
} from "lucide-react";
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  ticketStatusLabel,
} from "@/lib/support-tickets";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PlatformPageHeader,
  PlatformPageContainer,
  PlatformStat,
  PlatformDataTable,
  PlatformFilterBar,
  PlatformSearch,
  PlatformRefreshButton,
  PlatformPagination,
  type Column,
} from "@/components/platform";
import { usePlatformQuery } from "../_lib/use-platform-data";
import { useUrlFilters, useDebouncedValue } from "../_lib/use-url-filters";
import { fmtRelative, fmtDateTime } from "@/lib/platform-format";
import { toPersianDigits } from "@/lib/digits";
import {
  SupportTicketDrawer,
  statusBadge,
  priorityBadge,
} from "./ticket-drawer";

interface SupportTicket {
  id: string;
  businessId: string;
  businessName: string;
  locationName: string | null;
  userName: string | null;
  subject: string;
  category: string;
  priority: string;
  status: string;
  assignedAdminName: string | null;
  messageCount: number;
  lastMessagePreview: string | null;
  updatedAt: string;
}

interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  waitingCustomer: number;
  resolved: number;
  closed: number;
  urgentOpen: number;
  unassignedOpen: number;
}

interface ListResponse {
  tickets: SupportTicket[];
  stats: TicketStats;
  assignableAdmins: { id: string; fullName: string }[];
  meta?: { total: number; page: number; pageSize: number };
}

const PAGE_SIZE = 40;

const DEFAULTS = {
  search: "",
  status: "",
  priority: "",
  category: "",
  mine: "",
  queue: "",
  unassigned: "",
  page: "1",
};

function SupportInner() {
  const { values, set, reset, isFiltered } = useUrlFilters(DEFAULTS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(values.search, 350);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (values.status) params.set("status", values.status);
    if (values.priority) params.set("priority", values.priority);
    if (values.category) params.set("category", values.category);
    if (values.mine === "1") params.set("assignedToMe", "true");
    if (values.queue === "open") params.set("queue", "open");
    if (values.unassigned === "true") params.set("unassigned", "true");
    params.set("page", values.page || "1");
    params.set("pageSize", String(PAGE_SIZE));
    return `/api/platform/support/tickets?${params.toString()}`;
  }, [
    debouncedSearch,
    values.status,
    values.priority,
    values.category,
    values.mine,
    values.queue,
    values.unassigned,
    values.page,
  ]);

  const query = usePlatformQuery<ListResponse>(url, [url]);
  const tickets = query.data?.tickets ?? null;
  const stats = query.data?.stats;
  const assignableAdmins = query.data?.assignableAdmins ?? [];
  const meta = query.data?.meta;
  const page = Number(values.page) || 1;

  const columns: Column<SupportTicket>[] = [
    {
      key: "subject",
      header: "موضوع",
      cell: (t) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{t.subject}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="truncate">{t.businessName}</span>
            <span>•</span>
            <span className="truncate">{t.userName ?? "کاربر حذف‌شده"}</span>
            <span>• {toPersianDigits(t.messageCount)} پیام</span>
          </p>
        </div>
      ),
    },
    { key: "priority", header: "اولویت", cell: (t) => priorityBadge(t.priority) },
    { key: "status", header: "وضعیت", cell: (t) => statusBadge(t.status) },
    {
      key: "assigned",
      header: "پاسخ‌دهنده",
      hideOnMobile: true,
      cell: (t) => t.assignedAdminName ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: "updatedAt",
      header: "آخرین فعالیت",
      align: "end",
      cell: (t) => (
        <span className="whitespace-nowrap text-muted-foreground" title={fmtDateTime(t.updatedAt)}>
          {fmtRelative(t.updatedAt)}
        </span>
      ),
    },
  ];

  return (
    <PlatformPageContainer width="wide">
      <PlatformPageHeader
        title="تیکت‌های پشتیبانی"
        description="درخواست‌های پشتیبانی همهٔ کسب‌وکارها؛ پاسخ‌دهی، اولویت‌بندی و ارجاع به همکاران."
        actions={<PlatformRefreshButton onClick={query.refetch} refreshing={query.refreshing} />}
      />

      {stats ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <PlatformStat
            label="در انتظار پاسخ"
            value={toPersianDigits(stats.open + stats.inProgress)}
            tone={stats.open + stats.inProgress ? "warning" : "neutral"}
            icon={<Clock3Icon className="size-4" />}
          />
          <PlatformStat
            label="در انتظار کاربر"
            value={toPersianDigits(stats.waitingCustomer)}
            icon={<UserRoundIcon className="size-4" />}
          />
          <PlatformStat
            label="فوریِ باز"
            value={toPersianDigits(stats.urgentOpen)}
            tone={stats.urgentOpen ? "danger" : "neutral"}
            icon={<AlertTriangleIcon className="size-4" />}
          />
          <PlatformStat
            label="بدون پاسخ‌دهنده"
            value={toPersianDigits(stats.unassignedOpen)}
            tone={stats.unassignedOpen ? "warning" : "success"}
            icon={<InboxIcon className="size-4" />}
          />
        </div>
      ) : null}

      <PlatformFilterBar onReset={reset} isFiltered={isFiltered} resultCount={meta?.total}>
        <PlatformSearch
          value={values.search}
          onChange={(v) => set({ search: v, page: "1" })}
          placeholder="جست‌وجو در کسب‌وکار، کاربر، موضوع و پیام‌ها…"
        />
        <Select
          value={values.status || "__all__"}
          onValueChange={(v) => set({ status: v === "__all__" ? "" : v, page: "1" })}
        >
          <SelectTrigger className="w-auto min-w-[8.5rem]">
            <SelectValue placeholder="همهٔ وضعیت‌ها" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">همهٔ وضعیت‌ها</SelectItem>
            {TICKET_STATUSES.map((v) => (
              <SelectItem key={v} value={v}>
                {ticketStatusLabel(v, "operator")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={values.priority || "__all__"}
          onValueChange={(v) => set({ priority: v === "__all__" ? "" : v, page: "1" })}
        >
          <SelectTrigger className="w-auto min-w-[8rem]">
            <SelectValue placeholder="همهٔ اولویت‌ها" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">همهٔ اولویت‌ها</SelectItem>
            {TICKET_PRIORITIES.map((v) => (
              <SelectItem key={v} value={v}>
                {TICKET_PRIORITY_LABELS[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={values.category || "__all__"}
          onValueChange={(v) => set({ category: v === "__all__" ? "" : v, page: "1" })}
        >
          <SelectTrigger className="w-auto min-w-[8.5rem]">
            <SelectValue placeholder="همهٔ دسته‌ها" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">همهٔ دسته‌ها</SelectItem>
            {TICKET_CATEGORIES.map((v) => (
              <SelectItem key={v} value={v}>
                {TICKET_CATEGORY_LABELS[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch
            id="mine"
            checked={values.mine === "1"}
            onCheckedChange={(c) => set({ mine: c ? "1" : "", page: "1" })}
          />
          <Label htmlFor="mine" className="cursor-pointer text-xs text-muted-foreground">
            فقطِ من
          </Label>
        </div>
      </PlatformFilterBar>

      <PlatformDataTable
        columns={columns}
        rows={tickets}
        rowKey={(t) => t.id}
        loading={query.loading}
        error={query.errorText}
        errorStatus={query.errorStatus}
        onRetry={query.refetch}
        isFiltered={isFiltered}
        onResetFilters={reset}
        onRowClick={(t) => setSelectedId(t.id)}
        emptyTitle="تیکتی ثبت نشده است."
        emptyDescription="درخواست‌های کاربران از بخش «پشتیبانی» برنامهٔ کسب‌وکارها اینجا می‌آیند."
      />

      {meta ? (
        <PlatformPagination
          page={page}
          pageSize={PAGE_SIZE}
          total={meta.total}
          onPageChange={(p) => set({ page: String(p) })}
        />
      ) : null}

      <SupportTicketDrawer
        ticketId={selectedId}
        assignableAdmins={assignableAdmins}
        onClose={() => setSelectedId(null)}
        onChanged={query.refetch}
      />
    </PlatformPageContainer>
  );
}

export default function PlatformSupportPage() {
  return (
    <Suspense fallback={null}>
      <SupportInner />
    </Suspense>
  );
}
