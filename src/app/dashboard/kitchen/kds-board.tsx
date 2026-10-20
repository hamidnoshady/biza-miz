"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2Icon, CircleIcon, FlameIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import {
  compareKitchenTicketPriority,
  priorityForKitchenTicket,
  type KitchenTicketPriority,
} from "@/lib/kitchen-priority";
import { formatJalali } from "@/lib/jalali";
import {
  DEFAULT_TICKET_AGING_MINUTES,
  ORDER_ITEM_STATUS_LABELS,
  ticketAgeMinutes,
} from "@/lib/order-item-status";
import { type KitchenQueueStatus } from "@/lib/kitchen-priority";
import { apiOrQueue, useOfflineQueue } from "../offline-queue";
import { useRealtime } from "../use-realtime";
import { KnowledgeHelpButton } from "../knowledge-help";
import { api, errorMessage } from "../ui";
import { cardClass, PageShell } from "../page-chrome";
import { cn } from "@/lib/utils";

interface TicketItem {
  id: string;
  order_id: string;
  name_snapshot: string;
  quantity: number;
  status: "sent" | "preparing" | "ready";
  note: string | null;
  order_note?: string | null;
  sent_to_kitchen_at: string;
  order_type: "dine_in" | "takeaway" | "delivery";
  order_number: number;
  table_session_id: string | null;
  table_id: string | null;
  table_name: string | null;
  priority: KitchenTicketPriority;
}

interface Modifier {
  order_item_id: string;
  name_snapshot: string;
  /** How many times this add-on applies to one unit of the line (migration 0169). */
  quantity?: number;
}

interface KitchenTicketsResponse {
  items?: TicketItem[];
  modifiers?: Modifier[];
}

interface ApiError {
  error?: string;
}

type TicketStatus = TicketItem["status"];

interface Ticket {
  key: string;
  earliestSentAt: number;
  items: TicketItem[];
  orderNumber: number;
  orderType: TicketItem["order_type"];
  tableName: string | null;
  priority: KitchenTicketPriority;
  status: TicketStatus;
}
type TicketFilter = "all" | TicketStatus;

const NEXT_STATUS: Record<TicketStatus, "preparing" | "ready" | null> = {
  sent: "preparing",
  preparing: "ready",
  ready: null,
};

const BUMP_LABEL: Record<TicketStatus, string> = {
  sent: "شروع آماده‌سازی",
  preparing: "آماده برای تحویل",
  ready: "",
};

const STATUS_META: Record<
  TicketStatus,
  { label: string; filterLabel: string; toneClass: string; dotClass: string }
> = {
  sent: {
    label: "جدید",
    filterLabel: "جدید",
    toneClass: "border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300",
    dotClass: "bg-amber-500 dark:bg-amber-400",
  },
  preparing: {
    label: "در حال آماده‌سازی",
    filterLabel: "در حال آماده‌سازی",
    toneClass: "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300",
    dotClass: "bg-amber-600 dark:bg-amber-400",
  },
  ready: {
    label: "آماده",
    filterLabel: "آماده",
    toneClass: "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    dotClass: "bg-emerald-500 dark:bg-emerald-500",
  },
};

function sourceLabel(ticket: Ticket): string {
  if (ticket.orderType === "dine_in") return ticket.tableName ?? "سفارش حضوری";
  return ticket.orderType === "takeaway" ? "بیرون‌بر" : "ارسال";
}

function formatElapsed(sentAt: number, now: number): string {
  const minutes = ticketAgeMinutes(sentAt, now);
  if (!Number.isFinite(minutes)) return "زمان نامشخص";
  if (minutes < 1) return "کمتر از یک دقیقه";
  return `${toPersianDigits(Math.floor(minutes))} دقیقه`;
}

function formatUpdatedAt(timestamp: number): string {
  return toPersianDigits(
    new Intl.DateTimeFormat("fa-IR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(timestamp),
  );
}

const PRIORITY_META: Record<
  KitchenTicketPriority["tier"],
  { label: string; className: string }
> = {
  overdue: {
    label: "فوری",
    className: "border-destructive/30 bg-destructive/5 text-destructive",
  },
  waiting: {
    label: "بعدی",
    className: "border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300",
  },
  preparing: {
    label: "در جریان",
    className: "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300",
  },
  ready: {
    label: "آمادهٔ تحویل",
    className: "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
};

function PriorityBadge({ priority }: { priority: KitchenTicketPriority }) {
  const meta = PRIORITY_META[priority.tier];
  return (
    <span
      className={`rounded-xl border px-2 py-1 text-xs font-semibold ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

function StatusBadge({ status }: { status: TicketStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge
      variant="outline"
      className={`h-7 gap-1.5 border px-2.5 ${meta.toneClass}`}
      aria-label={ORDER_ITEM_STATUS_LABELS[status]}
    >
      <span
        className={`size-2 rounded-full ${meta.dotClass}`}
        aria-hidden="true"
      />
      {status === "ready" ? (
        <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
      ) : status === "preparing" ? (
        <FlameIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <CircleIcon className="size-3.5" aria-hidden="true" />
      )}
      <span>{meta.label}</span>
    </Badge>
  );
}

function QueueSkeleton() {
  return (
    <div
      className="grid gap-4 xl:grid-cols-2"
      aria-label="در حال دریافت صف آشپزخانه"
      aria-busy="true"
    >
      {[0, 1].map((column) => (
        <section
          key={column}
          className={`${cardClass} p-4`}
        >
          <div className="ops-skeleton h-5 w-28 rounded" />
          <div className="mt-4 space-y-3">
            {[0, 1].map((card) => (
              <div
                key={card}
                className="rounded-xl border border-border p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="ops-skeleton h-5 w-24 rounded" />
                  <div className="ops-skeleton h-6 w-20 rounded-full" />
                </div>
                <div className="ops-skeleton mt-4 h-4 w-3/4 rounded" />
                <div className="ops-skeleton mt-2 h-4 w-1/2 rounded" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <section className="rounded-xl border border-dashed border-border/80 bg-muted px-5 py-12 text-center">
      <p className="font-semibold text-foreground/80">
        {filtered
          ? "سفارشی در این وضعیت نیست."
          : "فعلاً سفارشی برای آشپزخانه نیست."}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {filtered
          ? "فیلتر وضعیت را تغییر دهید یا با رسیدن سفارش تازه، صف اینجا به‌روزرسانی می‌شود."
          : "سفارش‌های بازِ ارسال‌شده به آشپزخانه در این بخش نمایش داده می‌شوند."}
      </p>
    </section>
  );
}

function TicketCard({
  ticket,
  now,
  selected,
  onSelect,
}: {
  ticket: Ticket;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = ticket.status;
  const late =
    ticketAgeMinutes(ticket.earliestSentAt, now) >=
    DEFAULT_TICKET_AGING_MINUTES;

  return (
    <article
      // cn()/twMerge, not a template string: cardClass already carries
      // `border-border/80`, and the selected/late border must win by *source*
      // order rather than by whichever colour Tailwind happened to emit last.
      className={cn(
        "overflow-hidden transition-colors motion-reduce:transition-none",
        cardClass,
        selected
          ? "border-amber-500 dark:border-amber-500/60 ring-2 ring-amber-500/20 dark:ring-amber-400/45"
          : late
            ? "border-destructive/30"
            : "border-border/80",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="min-h-[128px] w-full p-4 text-right outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 dark:focus-visible:ring-amber-400/45"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-bold text-foreground">
              سفارش {toPersianDigits(ticket.orderNumber)}
            </p>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {sourceLabel(ticket)}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <PriorityBadge priority={ticket.priority} />
            <StatusBadge status={status} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span
            className={`font-medium ${late ? "text-destructive" : "text-muted-foreground"}`}
          >
            {formatElapsed(ticket.earliestSentAt, now)}
          </span>
          <span className="text-muted-foreground">
            {toPersianDigits(ticket.items.length)} قلم
          </span>
        </div>
      </button>
    </article>
  );
}

function TicketDetails({
  ticket,
  now,
  modifiersByItem,
  bumpingItemId,
  onBump,
}: {
  ticket: Ticket;
  now: number;
  modifiersByItem: Map<string, string[]>;
  bumpingItemId: string | null;
  onBump: (itemId: string, status: "preparing" | "ready") => void;
}) {
  const status = ticket.status;
  const late =
    ticketAgeMinutes(ticket.earliestSentAt, now) >=
    DEFAULT_TICKET_AGING_MINUTES;

  return (
    <section
      className={`${cardClass} p-4`}
      aria-label={`جزئیات سفارش ${toPersianDigits(ticket.orderNumber)}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">جزئیات سفارش</p>
          <h2 className="mt-1 text-xl font-bold text-foreground">
            سفارش {toPersianDigits(ticket.orderNumber)}
          </h2>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <PriorityBadge priority={ticket.priority} />
          <StatusBadge status={status} />
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 border-y border-border py-4 text-sm md:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">منبع سفارش</dt>
          <dd className="mt-1 font-semibold text-foreground/80">
            {sourceLabel(ticket)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">زمان گذشته</dt>
          <dd
            className={`mt-1 font-semibold ${late ? "text-destructive" : "text-foreground/80"}`}
          >
            {formatElapsed(ticket.earliestSentAt, now)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">اولویت صف</dt>
          <dd className="mt-1">
            <PriorityBadge priority={ticket.priority} />
          </dd>
        </div>
      </dl>

      <div className="mt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-bold text-foreground">اقلام سفارش</h3>
          <span className="text-sm text-muted-foreground">
            {toPersianDigits(ticket.items.length)} قلم
          </span>
        </div>
        {ticket.items[0]?.order_note ? (
          <div className="mt-3 whitespace-pre-wrap break-words rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-base font-semibold text-amber-950 dark:bg-amber-500/15 dark:text-amber-200" dir="auto">
            دستور سفارش: {ticket.items[0].order_note}
          </div>
        ) : null}
        <ul className="mt-3 divide-y divide-border">
          {ticket.items.map((item) => {
            const next = NEXT_STATUS[item.status];
            const modifiers = modifiersByItem.get(item.id) ?? [];
            const waitingForUpdate = bumpingItemId === item.id;

            return (
              <li key={item.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-semibold text-foreground/80">
                      <span className="ml-1 inline-flex min-w-7 justify-center rounded-xl bg-muted px-1.5 py-0.5 text-sm text-muted-foreground">
                        {toPersianDigits(item.quantity)}×
                      </span>
                      {item.name_snapshot}
                    </p>
                    {modifiers.length > 0 ? (
                      <p className="mt-1 break-words text-sm text-muted-foreground">
                        {modifiers.join("، ")}
                      </p>
                    ) : null}
                    {item.note ? (
                      <p className="mt-2 break-words rounded-lg bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                        {item.note}
                      </p>
                    ) : null}
                  </div>
                  <StatusBadge status={item.status} />
                </div>

                {next ? (
                  <div className="mt-3">
                    {waitingForUpdate ? (
                      <p
                        className="flex min-h-[52px] items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-500/15 px-4 text-sm font-semibold text-amber-800 dark:text-amber-300"
                        role="status"
                      >
                        در حال ثبت تغییر…
                      </p>
                    ) : (
                      <Button
                        type="button"
                        size="lg"
                        onClick={() => onBump(item.id, next)}
                        className="min-h-[52px] w-full bg-amber-500 dark:bg-amber-400 font-semibold text-amber-950 hover:bg-amber-500 dark:hover:bg-amber-400 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
                      >
                        {BUMP_LABEL[item.status]}
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function DetailPlaceholder() {
  return (
    <aside className="rounded-xl border border-dashed border-border/80 bg-muted p-6 text-center md:sticky md:top-4">
      <p className="font-semibold text-foreground/80">یک سفارش را انتخاب کنید</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        جزئیات اقلام، یادداشت‌ها و اقدام مجاز آشپزخانه در اینجا نمایش داده
        می‌شود.
      </p>
    </aside>
  );
}

export function KdsBoard() {
  const [items, setItems] = useState<TicketItem[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<TicketFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationMessage, setMutationMessage] = useState<string | null>(null);
  const [bumpingItemId, setBumpingItemId] = useState<string | null>(null);
  const { isOnline, pendingCount } = useOfflineQueue();
  const loadSequence = useRef(0);

  const load = useCallback(
    async ({ showRefresh = false }: { showRefresh?: boolean } = {}) => {
      const sequence = ++loadSequence.current;
      if (showRefresh) setIsRefreshing(true);

      try {
        const result = await api<KitchenTicketsResponse>(
          "/api/kitchen/tickets",
        );
        if (!result.ok) {
          setLoadError(errorMessage((result.data as ApiError).error));
          return;
        }

        if (sequence !== loadSequence.current) return;
        setItems(result.data.items ?? []);
        setModifiers(result.data.modifiers ?? []);
        setLoadError(null);
        setLastUpdatedAt(Date.now());
      } catch {
        if (sequence === loadSequence.current) setLoadError("دریافت صف آشپزخانه ممکن نشد. دوباره تلاش کنید.");
      } finally {
        if (sequence === loadSequence.current) {
          setIsLoading(false);
          if (showRefresh) setIsRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(
    useCallback(
      (event) => {
        if (
          ["order.created", "order.updated", "order.item_status"].includes(
            event.type,
          )
        )
          void load();
      },
      [load],
    ),
  );

  useEffect(() => {
    const recover = () => { if (document.visibilityState === "visible") void load({ showRefresh: true }); };
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recover);
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => { window.removeEventListener("online", recover); document.removeEventListener("visibilitychange", recover); window.clearInterval(poll); };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const modifiersByItem = useMemo(() => {
    const byItem = new Map<string, string[]>();
    for (const modifier of modifiers) {
      const current = byItem.get(modifier.order_item_id) ?? [];
      const count = Math.max(1, modifier.quantity ?? 1);
      // The kitchen reads «×۳» as three shots in the cup, not one — the
      // label carries the repeat so preparation and inventory agree.
      current.push(
        count > 1
          ? `${modifier.name_snapshot} ×${toPersianDigits(count)}`
          : modifier.name_snapshot,
      );
      byItem.set(modifier.order_item_id, current);
    }
    return byItem;
  }, [modifiers]);

  // Performance Optimization: Separate expensive static data operations (grouping, date parsing)
  // from interval-driven time updates. `ticketGroups` only recalculates when `items` changes,
  // avoiding O(N) grouping and string-to-date parsing on every 15s `now` tick.
  const ticketGroups = useMemo(() => {
    const groups = new Map<string, TicketItem[]>();
    for (const item of items) {
      const key = item.order_id;
      const current = groups.get(key) ?? [];
      current.push(item);
      groups.set(key, current);
    }

    return [...groups.entries()].map(([key, ticketItems]) => {
      const earliestSentAt = Math.min(
        ...ticketItems.map((item) =>
          new Date(item.sent_to_kitchen_at).getTime(),
        ),
      );
      // A ready line is a handoff that must stay discoverable even when a
      // later round has newly-sent items on the same order.
      const status = ticketItems.some((item) => item.status === "ready")
        ? "ready"
        : ticketItems.some((item) => item.status === "sent")
          ? "sent"
          : "preparing";

      return {
        key,
        ticketItems,
        earliestSentAt,
        status,
      };
    });
  }, [items]);

  const tickets = useMemo<Ticket[]>(() => {
    return ticketGroups
      .map(({ key, ticketItems, earliestSentAt, status }) => {
        const first = ticketItems[0];
        const priority = priorityForKitchenTicket(
          { status: status as KitchenQueueStatus, sentAt: earliestSentAt },
          now,
        );
        return {
          key,
          earliestSentAt: priority.sentAtMs,
          items: ticketItems,
          orderNumber: first.order_number,
          orderType: first.order_type,
          tableName: first.table_name,
          priority,
          status: status as TicketStatus,
        };
      })
      .sort((left, right) =>
        compareKitchenTicketPriority(left.priority, right.priority),
      );
  }, [ticketGroups, now]);

  const visibleTickets = useMemo(
    () =>
      filter === "all"
        ? tickets
        : tickets.filter((ticket) => ticket.status === filter),
    [filter, tickets],
  );

  const ticketSections = useMemo(() => {
    const statuses: TicketStatus[] =
      filter === "all" ? ["sent", "preparing", "ready"] : [filter];
    return statuses
      .map((status) => ({
        status,
        tickets: visibleTickets.filter((ticket) => ticket.status === status),
      }))
      .filter((section) => section.tickets.length > 0);
  }, [filter, visibleTickets]);

  const selectedTicket = useMemo(
    () => visibleTickets.find((ticket) => ticket.key === selectedKey) ?? null,
    [selectedKey, visibleTickets],
  );

  useEffect(() => {
    if (
      selectedKey &&
      !visibleTickets.some((ticket) => ticket.key === selectedKey)
    )
      setSelectedKey(null);
  }, [selectedKey, visibleTickets]);

  const filters = useMemo(
    () => [
      { value: "all" as const, label: "همه", count: tickets.length },
      ...(["sent", "preparing", "ready"] as TicketStatus[]).map((status) => ({
        value: status,
        label: STATUS_META[status].filterLabel,
        count: tickets.filter((ticket) => ticket.status === status).length,
      })),
    ],
    [tickets],
  );

  const nextTicket = visibleTickets[0] ?? null;

  const syncLabel = !isOnline
    ? "اتصال قطع است"
    : pendingCount > 0
      ? `${toPersianDigits(pendingCount)} تغییر در انتظار همگام‌سازی`
      : isRefreshing
        ? "در حال به‌روزرسانی"
        : lastUpdatedAt
          ? `به‌روزرسانی ${formatUpdatedAt(lastUpdatedAt)}`
          : "در حال دریافت صف";

  async function bump(itemId: string, status: "preparing" | "ready") {
    setBumpingItemId(itemId);
    setMutationMessage(null);

    try {
      const result = await apiOrQueue<ApiError>(
        `/api/kitchen/items/${itemId}`,
        { method: "PATCH", body: { status } },
        {
          type: "order_item.status",
          payload: { itemId, status },
          description: "بروزرسانی وضعیت آشپزخانه",
        },
      );

      if (!result.ok) {
        setMutationMessage(errorMessage(result.data.error));
        return;
      }

      if (result.queued) {
        setMutationMessage("تغییر برای همگام‌سازی ثبت شد.");
        return;
      }

      setMutationMessage("وضعیت سفارش به‌روزرسانی شد.");
      await load();
    } catch {
      setMutationMessage("ثبت تغییر ممکن نشد. دوباره تلاش کنید.");
    } finally {
      setBumpingItemId(null);
    }
  }

  return (
    <PageShell className="space-y-4">
      <header className={`${cardClass} p-4`}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-2xl font-bold text-foreground">آشپزخانه</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {toPersianDigits(
                formatJalali(new Date(now), { withMonthName: true }),
              )}
            </p>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3">
            <KnowledgeHelpButton section="kitchen" />
            <p
              className="flex min-h-11 min-w-0 items-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <span
                className={`size-2.5 shrink-0 rounded-full ${isOnline && pendingCount === 0 ? "bg-emerald-500 dark:bg-emerald-500" : "bg-amber-500 dark:bg-amber-400"}`}
                aria-hidden="true"
              />
              <span className="truncate">{syncLabel}</span>
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void load({ showRefresh: true })}
              className="min-h-[52px] shrink-0 border-border/80 bg-muted px-4 text-foreground/80 hover:bg-amber-50 dark:hover:bg-amber-500/15"
            >
              {isRefreshing ? "در حال به‌روزرسانی" : "به‌روزرسانی"}
            </Button>
          </div>
        </div>
      </header>

      {loadError ? (
        <div
          className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-red-800 dark:text-red-200 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <p className="text-sm font-medium">{loadError}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void load({ showRefresh: true })}
            className="min-h-[48px] shrink-0 border-destructive/30 bg-card text-red-800 dark:text-red-200 hover:bg-red-50 dark:hover:bg-red-500/15"
          >
            تلاش دوباره
          </Button>
        </div>
      ) : null}

      {mutationMessage ? (
        <p
          className="rounded-lg bg-amber-50 dark:bg-amber-500/15 px-4 py-3 text-sm font-medium text-amber-800 dark:text-amber-300"
          role="status"
          aria-live="polite"
        >
          {mutationMessage}
        </p>
      ) : null}

      {nextTicket ? (
        <button
          type="button"
          onClick={() => setSelectedKey(nextTicket.key)}
          className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-4 py-3 text-right transition-colors hover:bg-amber-50 dark:hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:focus-visible:ring-amber-400/45"
          aria-label={`انتخاب سفارش اولویت‌دار ${toPersianDigits(nextTicket.orderNumber)}`}
        >
          <span className="text-sm font-bold text-amber-900 dark:text-amber-200">
            نوبت بعدی: سفارش {toPersianDigits(nextTicket.orderNumber)}
          </span>
          <span className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
            <PriorityBadge priority={nextTicket.priority} />
            <span>{formatElapsed(nextTicket.earliestSentAt, now)}</span>
          </span>
        </button>
      ) : null}

      <nav
        className="-mx-2 overflow-x-auto px-2 pb-1"
        aria-label="فیلتر وضعیت سفارش‌های آشپزخانه"
      >
        <div className="flex w-max min-w-full gap-2">
          {filters.map((item) => {
            const active = filter === item.value;
            return (
              <Button
                key={item.value}
                type="button"
                variant="outline"
                onClick={() => setFilter(item.value)}
                aria-pressed={active}
                className={`min-h-[52px] gap-2 rounded-lg px-4 font-semibold ${
                  active
                    ? "border-amber-500 dark:border-amber-500/60 bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20"
                    : "border-border/80 bg-card text-muted-foreground hover:bg-muted"
                }`}
              >
                <span>{item.label}</span>
                <span
                  className={`rounded-xl px-1.5 py-0.5 text-xs ${active ? "bg-amber-200 dark:bg-amber-500/25" : "bg-muted"}`}
                >
                  {toPersianDigits(item.count)}
                </span>
              </Button>
            );
          })}
        </div>
      </nav>

      {isLoading ? (
        <QueueSkeleton />
      ) : tickets.length === 0 ? (
        <EmptyState filtered={false} />
      ) : visibleTickets.length === 0 ? (
        <EmptyState filtered />
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_19rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section
            className="min-w-0 md:col-start-1"
            aria-label="صف سفارش‌های آشپزخانه"
          >
            <div className="grid gap-4 xl:grid-cols-2">
              {ticketSections.map((section) => (
                <section
                  key={section.status}
                  className="rounded-xl border border-border/80 bg-muted p-3 sm:p-4"
                  aria-labelledby={`kitchen-section-${section.status}`}
                >
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`size-2.5 shrink-0 rounded-full ${STATUS_META[section.status].dotClass}`}
                        aria-hidden="true"
                      />
                      <h2
                        id={`kitchen-section-${section.status}`}
                        className="truncate font-bold text-foreground/80"
                      >
                        {STATUS_META[section.status].label}
                      </h2>
                    </div>
                    <span className="shrink-0 rounded-xl bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
                      {toPersianDigits(section.tickets.length)} سفارش
                    </span>
                  </div>
                  <div className="space-y-3">
                    {section.tickets.map((ticket) => (
                      <div key={ticket.key} className="space-y-0">
                        <TicketCard
                          ticket={ticket}
                          now={now}
                          selected={selectedTicket?.key === ticket.key}
                          onSelect={() => setSelectedKey(ticket.key)}
                        />
                        {selectedTicket?.key === ticket.key ? (
                          <div className="mt-3 md:hidden">
                            <TicketDetails
                              ticket={ticket}
                              now={now}
                              modifiersByItem={modifiersByItem}
                              bumpingItemId={bumpingItemId}
                              onBump={bump}
                            />
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </section>

          <aside className="hidden min-w-0 md:col-start-2 md:block">
            {selectedTicket ? (
              <div className="md:sticky md:top-4">
                <TicketDetails
                  ticket={selectedTicket}
                  now={now}
                  modifiersByItem={modifiersByItem}
                  bumpingItemId={bumpingItemId}
                  onBump={bump}
                />
              </div>
            ) : (
              <DetailPlaceholder />
            )}
          </aside>
        </div>
      )}
    </PageShell>
  );
}
