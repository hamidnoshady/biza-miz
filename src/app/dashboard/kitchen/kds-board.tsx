"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2Icon, CircleIcon, FlameIcon } from "lucide-react";
import { toast } from "sonner";
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
  ORDER_ITEM_STATUS_LABELS,
  ticketAgeMinutes,
} from "@/lib/order-item-status";
import {
  DEFAULT_KITCHEN_ALERT_THRESHOLDS,
  DEFAULT_KITCHEN_SOUND_PREFERENCES,
  diffKitchenAgingStages,
  diffKitchenAlerts,
  kitchenAgingStage,
  kitchenSoundEnabledFor,
  parseKitchenAlertThresholds,
  parseKitchenSoundPreferences,
  type KitchenAlertBaseline,
  type KitchenAlertThresholds,
  type KitchenAgingStage,
  type KitchenSoundEventKey,
  type KitchenSoundPreferences,
} from "@/lib/kitchen-alerts";
import {
  kitchenPrintFailureText,
  subscribeKitchenPrintFailures,
} from "@/lib/kitchen-alert-events";
import { type KitchenQueueStatus } from "@/lib/kitchen-priority";
import { apiOrQueue, useOfflineQueue } from "../offline-queue";
import { useRealtime, type RealtimeLifecycle } from "../use-realtime";
import { KnowledgeHelpButton } from "../knowledge-help";
import { api, errorMessage } from "../ui";
import { cardClass, PageShell } from "../page-chrome";
import { cn } from "@/lib/utils";
import { KitchenWorkflowSettings } from "./kitchen-workflow-settings";
import { KitchenAlertSettings } from "./kitchen-alert-settings";

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

interface StaleTicket {
  order_id: string;
  order_number: number;
  order_status: "open" | "held" | "completed";
  item_count: number;
  archived_at?: string;
  reason?: string;
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
  statusCounts: Record<TicketStatus, number>;
}
type TicketFilter = "all" | TicketStatus;
type OrderTypeFilter = "all" | TicketItem["order_type"];
type TicketAgeFilter = "all" | "aging" | "within";

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

const THRESHOLD_CACHE_KEY = "kds.alert-thresholds";

/**
 * A cold boot with no network still needs the branch's last-known thresholds.
 * This is only a cache: the authoritative GET overwrites it as soon as the
 * server answers, and a corrupt entry falls back to the platform default.
 */
function readCachedThresholds(): KitchenAlertThresholds | null {
  try {
    const raw = window.localStorage.getItem(THRESHOLD_CACHE_KEY);
    if (!raw) return null;
    return parseKitchenAlertThresholds(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeCachedThresholds(thresholds: KitchenAlertThresholds): void {
  try {
    window.localStorage.setItem(THRESHOLD_CACHE_KEY, JSON.stringify(thresholds));
  } catch {
    // Private browsing/storage denial must not prevent use of the KDS.
  }
}

function agingStageLabel(stage: KitchenAgingStage): string {
  if (stage === "overdue") return "از آستانه گذشته";
  if (stage === "approaching") return "نزدیک آستانه";
  return "در محدوده";
}

const ALERT_TONE_FREQUENCY: Record<KitchenSoundEventKey, number> = {
  newTicket: 880,
  addedItems: 988,
  aging: 660,
  connection: 440,
  printFailure: 330,
};

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
  thresholds,
}: {
  ticket: Ticket;
  now: number;
  selected: boolean;
  onSelect: () => void;
  thresholds: KitchenAlertThresholds;
}) {
  const status = ticket.status;
  const stage = kitchenAgingStage(
    ticketAgeMinutes(ticket.earliestSentAt, now),
    thresholds,
  );
  const late = stage === "overdue";

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
            className={`font-medium ${late ? "text-destructive" : stage === "approaching" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
          >
            {formatElapsed(ticket.earliestSentAt, now)}
          </span>
          <span
            className={`rounded-xl border px-2 py-0.5 text-xs font-semibold ${
              stage === "overdue"
                ? "border-destructive/30 bg-destructive/5 text-destructive"
                : stage === "approaching"
                  ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300"
                  : "border-border bg-muted text-muted-foreground"
            }`}
          >
            {agingStageLabel(stage)}
          </span>
          <span className="text-muted-foreground">
            {toPersianDigits(ticket.items.length)} قلم
          </span>
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="تعداد اقلام به تفکیک وضعیت">
            {(["sent", "preparing", "ready"] as const).map((itemStatus) =>
              ticket.statusCounts[itemStatus] > 0 ? (
                <span key={itemStatus}>
                  {toPersianDigits(ticket.statusCounts[itemStatus])} {STATUS_META[itemStatus].label}
                </span>
              ) : null,
            )}
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
  batchingStatus,
  onBump,
  onBatch,
  thresholds,
}: {
  ticket: Ticket;
  now: number;
  modifiersByItem: Map<string, string[]>;
  bumpingItemId: string | null;
  batchingStatus: "preparing" | "ready" | null;
  onBump: (itemId: string, status: "preparing" | "ready") => void;
  onBatch: (status: "preparing" | "ready") => void;
  thresholds: KitchenAlertThresholds;
}) {
  const status = ticket.status;
  const stage = kitchenAgingStage(
    ticketAgeMinutes(ticket.earliestSentAt, now),
    thresholds,
  );
  const late = stage === "overdue";

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
            <span className="mt-1 block text-xs font-medium text-muted-foreground">
              {agingStageLabel(stage)} · آستانهٔ تأخیر {toPersianDigits(thresholds.overdueMinutes)} دقیقه
            </span>
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
        {ticket.items.some((item) => item.status === "sent") ? (
          <Button
            type="button"
            variant="outline"
            disabled={batchingStatus !== null || bumpingItemId !== null}
            onClick={() => onBatch("preparing")}
            className="mt-3 min-h-[52px] w-full"
          >
            {batchingStatus === "preparing" ? "در حال شروع اقلام جدید…" : "شروع آماده‌سازی همهٔ اقلام جدید"}
          </Button>
        ) : null}
        {ticket.items.some((item) => item.status === "preparing") ? (
          <Button
            type="button"
            variant="outline"
            disabled={batchingStatus !== null || bumpingItemId !== null}
            onClick={() => onBatch("ready")}
            className="mt-2 min-h-[52px] w-full"
          >
            {batchingStatus === "ready" ? "در حال آماده‌کردن همه…" : "علامت‌گذاری همهٔ اقلام در حال آماده‌سازی به‌عنوان آماده"}
          </Button>
        ) : null}
        <ul className="mt-3 divide-y divide-border">
          {ticket.items.map((item) => {
            const next = NEXT_STATUS[item.status];
            const modifiers = modifiersByItem.get(item.id) ?? [];
            const waitingForUpdate = bumpingItemId === item.id ||
              (batchingStatus === "preparing" && item.status === "sent") ||
              (batchingStatus === "ready" && item.status === "preparing");

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

export function KdsBoard({ canReviewStale = false }: { canReviewStale?: boolean }) {
  const [showStaleReview, setShowStaleReview] = useState(false);
  const [showWorkflowSettings, setShowWorkflowSettings] = useState(false);
  const [showKitchenHistory, setShowKitchenHistory] = useState(false);
  const [reviewRevision, setReviewRevision] = useState(0);
  const [selectedStaleIds, setSelectedStaleIds] = useState<string[]>([]);
  const [archivingStale, setArchivingStale] = useState(false);
  const [staleTickets, setStaleTickets] = useState<StaleTicket[] | null>(null);
  const [staleError, setStaleError] = useState<string | null>(null);

  useEffect(() => {
    if (!canReviewStale || !showStaleReview) return;
    let cancelled = false;

    void api<{ tickets?: StaleTicket[]; error?: string }>(showKitchenHistory ? "/api/kitchen/tickets/stale?view=history" : "/api/kitchen/tickets/stale")
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok && Array.isArray(data.tickets)) {
          setStaleTickets(data.tickets);
        } else {
          setStaleError(errorMessage(data.error));
        }
      })
      .catch(() => {
        if (!cancelled) setStaleError("دریافت سفارش‌های قدیمی انجام نشد.");
      });

    return () => {
      cancelled = true;
    };
  }, [canReviewStale, reviewRevision, showKitchenHistory, showStaleReview]);
  const [items, setItems] = useState<TicketItem[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<TicketFilter>("all");
  const [orderTypeFilter, setOrderTypeFilter] = useState<OrderTypeFilter>("all");
  const [ageFilter, setAgeFilter] = useState<TicketAgeFilter>("all");
  const [readyForPickupOnly, setReadyForPickupOnly] = useState(false);
  const [showAlertSettings, setShowAlertSettings] = useState(false);
  // The cache is a cold-boot fallback; the authoritative branch GET replaces
  // it below and the scan/notification producers read the same stored value.
  const [thresholds, setThresholds] = useState<KitchenAlertThresholds>(
    () => readCachedThresholds() ?? DEFAULT_KITCHEN_ALERT_THRESHOLDS,
  );
  const [canEditThresholds, setCanEditThresholds] = useState(false);
  const [thresholdsWarning, setThresholdsWarning] = useState<string | null>(null);
  const [soundPreferences, setSoundPreferences] = useState<KitchenSoundPreferences>(
    () => ({
      ...DEFAULT_KITCHEN_SOUND_PREFERENCES,
      events: { ...DEFAULT_KITCHEN_SOUND_PREFERENCES.events },
    }),
  );
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [printFailureNotice, setPrintFailureNotice] = useState<string | null>(null);
  const [batchingStatus, setBatchingStatus] = useState<"preparing" | "ready" | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState<boolean | null>(null);
  const [snapshotStale, setSnapshotStale] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationMessage, setMutationMessage] = useState<string | null>(null);
  const [bumpingItemId, setBumpingItemId] = useState<string | null>(null);
  const { isOnline, pendingCount } = useOfflineQueue();
  const loadSequence = useRef(0);
  const loadInFlight = useRef<Promise<void> | null>(null);
  const loadRef = useRef<((options?: { showRefresh?: boolean }) => Promise<void>) | null>(null);
  const queuedLoad = useRef(false);
  const alertBaseline = useRef<KitchenAlertBaseline | null>(null);
  const agingBaseline = useRef<Map<string, KitchenAgingStage> | null>(null);
  const agingThresholdSignature = useRef("");
  const connectionState = useRef<{ connected: boolean | null }>({ connected: null });
  const staleAlertShown = useRef(false);
  const audioContext = useRef<AudioContext | null>(null);
  // The realtime lifecycle callback is registered before the audio callbacks
  // are declared; a ref lets it play the latest opt-in tone without putting a
  // not-yet-initialised binding in a hook dependency array.
  const playAlertToneRef = useRef<(event: KitchenSoundEventKey) => void>(() => {});

  const load = useCallback(
    ({ showRefresh = false }: { showRefresh?: boolean } = {}): Promise<void> => {
      if (loadInFlight.current) {
        // Coalesce bursts, but always schedule one trailing authoritative read
        // so an event arriving during a fetch is not lost behind its snapshot.
        queuedLoad.current = true;
        if (showRefresh) setIsRefreshing(true);
        return loadInFlight.current;
      }

      const sequence = ++loadSequence.current;
      if (showRefresh) setIsRefreshing(true);
      const request = (async () => {
        try {
          const result = await api<KitchenTicketsResponse>("/api/kitchen/tickets");
          if (!result.ok) {
            setLoadError(errorMessage((result.data as ApiError).error));
            setSnapshotStale(true);
            return;
          }

          if (sequence !== loadSequence.current) return;
          setItems(result.data.items ?? []);
          setModifiers(result.data.modifiers ?? []);
          setLoadError(null);
          setLastUpdatedAt(Date.now());
          if (!queuedLoad.current) setSnapshotStale(false);
        } catch {
          if (sequence === loadSequence.current) {
            setLoadError("دریافت صف آشپزخانه ممکن نشد. دوباره تلاش کنید.");
            setSnapshotStale(true);
          }
        } finally {
          if (sequence === loadSequence.current) {
            setIsLoading(false);
            if (showRefresh && !queuedLoad.current) setIsRefreshing(false);
          }
        }
      })();
      loadInFlight.current = request;
      void request.then(() => {
        if (loadInFlight.current !== request) return;
        loadInFlight.current = null;
        if (queuedLoad.current) {
          queuedLoad.current = false;
          void loadRef.current?.({ showRefresh: true });
        }
      });
      return request;
    },
    [],
  );
  loadRef.current = load;

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(
    useCallback(
      (event) => {
        if (["order.created", "order.updated", "order.item_status"].includes(event.type)) {
          void load();
        }
      },
      [load],
    ),
    useCallback((status: RealtimeLifecycle) => {
      const previous = connectionState.current;
      connectionState.current = { connected: status.connected };
      setRealtimeConnected(status.connected);
      if (!status.connected && previous.connected === true) {
        toast.warning("اتصال زندهٔ آشپزخانه قطع شد؛ صف تا اتصال مجدد به‌روز نمی‌شود.");
        playAlertToneRef.current("connection");
      } else if (status.connected && previous.connected === false) {
        toast.success("اتصال زنده دوباره برقرار شد.");
        playAlertToneRef.current("connection");
      }
      if (status.recovery) {
        setSnapshotStale(true);
        void load({ showRefresh: true });
      } else if (!status.connected && lastUpdatedAt !== null) {
        setSnapshotStale(true);
      }
    }, [lastUpdatedAt, load]),
  );

  useEffect(() => {
    const recover = () => void load({ showRefresh: true });
    const poll = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("online", recover);
    const pollTimer = window.setInterval(poll, 30_000);
    return () => {
      window.removeEventListener("online", recover);
      window.clearInterval(pollTimer);
    };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      void audioContext.current?.close().catch(() => {});
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void api<{ thresholds?: unknown; canEdit?: boolean; error?: string }>("/api/kitchen/alerts")
      .then(({ ok, data }) => {
        if (cancelled) return;
        const parsed = parseKitchenAlertThresholds(data.thresholds);
        if (ok && parsed) {
          setThresholds(parsed);
          writeCachedThresholds(parsed);
          setCanEditThresholds(data.canEdit === true);
          setThresholdsWarning(null);
          return;
        }
        if (!ok) {
          setThresholdsWarning(
            "آستانه‌های این شعبه از سرور خوانده نشد؛ آخرین مقدار ذخیره‌شده یا پیش‌فرض نمایش داده می‌شود.",
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThresholdsWarning(
            "آستانه‌های این شعبه از سرور خوانده نشد؛ آخرین مقدار ذخیره‌شده یا پیش‌فرض نمایش داده می‌شود.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const legacySound = window.localStorage.getItem("kds.sound-alerts");
      const raw = window.localStorage.getItem("kds.sound-preferences");
      const parsed = parseKitchenSoundPreferences(raw ? JSON.parse(raw) : null);
      // `kds.sound-alerts` predates the per-event matrix; honour an explicit
      // legacy "on" choice rather than silently muting an existing device.
      setSoundPreferences(legacySound === "true" ? { ...parsed, enabled: true } : parsed);
    } catch {
      // Private browsing/storage denial must not prevent use of the KDS.
    } finally {
      setPreferencesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    try {
      window.localStorage.setItem("kds.sound-alerts", String(soundPreferences.enabled));
      window.localStorage.setItem("kds.sound-preferences", JSON.stringify(soundPreferences));
    } catch {
      // Preferences are optional; inaccessible storage falls back to defaults.
    }
  }, [preferencesLoaded, soundPreferences]);

  /**
   * Create/resume the audio context only from a user gesture (or after the
   * operator has already opted in). A denied/suspended context is a visible
   * state, not a silent failure: the visual alerts stay on either way.
   */
  const ensureAudio = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined") return false;
    const AudioCtor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) {
      setSoundBlocked(true);
      setAudioReady(false);
      return false;
    }
    try {
      let context = audioContext.current;
      if (!context || context.state === "closed") {
        context = new AudioCtor();
        audioContext.current = context;
      }
      if (context.state === "suspended") await context.resume();
      if (context.state !== "running") {
        setSoundBlocked(true);
        setAudioReady(false);
        return false;
      }
      setAudioReady(true);
      setSoundBlocked(false);
      return true;
    } catch {
      setSoundBlocked(true);
      setAudioReady(false);
      return false;
    }
  }, []);

  const playTone = useCallback((event: KitchenSoundEventKey): boolean => {
    const context = audioContext.current;
    if (!context || context.state !== "running") return false;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = ALERT_TONE_FREQUENCY[event];
      gain.gain.value = 0.04;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.16);
      return true;
    } catch {
      // Browser audio policy/device failures should never block queue updates.
      return false;
    }
  }, []);

  const playAlertTone = useCallback(
    (event: KitchenSoundEventKey) => {
      if (!kitchenSoundEnabledFor(soundPreferences, event)) return;
      if (!playTone(event)) setSoundBlocked(true);
    },
    [playTone, soundPreferences],
  );
  playAlertToneRef.current = playAlertTone;

  useEffect(() => {
    if (lastUpdatedAt === null) return;
    const diff = diffKitchenAlerts(alertBaseline.current, items);
    alertBaseline.current = diff.next;
    if (diff.alerts.length === 0) return;

    const newTickets = diff.alerts.filter((alert) => alert.kind === "new_ticket");
    const addedItems = diff.alerts.filter((alert) => alert.kind === "items_added");
    if (newTickets.length > 0) {
      toast.info(`${toPersianDigits(newTickets.length)} سفارش تازه به صف آشپزخانه رسید.`);
      playAlertTone("newTicket");
    }
    if (addedItems.length > 0) {
      const lineCount = addedItems.reduce((count, alert) => count + alert.itemIds.length, 0);
      toast.info(`${toPersianDigits(lineCount)} قلم تازه به سفارش‌های موجود اضافه شد.`);
      playAlertTone("addedItems");
    }
  }, [items, lastUpdatedAt, playAlertTone]);

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
      const statusCounts: Record<TicketStatus, number> = {
        sent: 0,
        preparing: 0,
        ready: 0,
      };
      for (const item of ticketItems) statusCounts[item.status] += 1;

      return {
        key,
        ticketItems,
        earliestSentAt,
        status,
        statusCounts,
      };
    });
  }, [items]);

  const tickets = useMemo<Ticket[]>(() => {
    return ticketGroups
      .map(({ key, ticketItems, earliestSentAt, status, statusCounts }) => {
        const first = ticketItems[0];
        const priority = priorityForKitchenTicket(
          { status: status as KitchenQueueStatus, sentAt: earliestSentAt },
          now,
          thresholds.overdueMinutes,
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
          statusCounts,
        };
      })
      .sort((left, right) =>
        compareKitchenTicketPriority(left.priority, right.priority),
      );
  }, [thresholds.overdueMinutes, ticketGroups, now]);

  const thresholdSignature = `${thresholds.approachingMinutes ?? "off"}:${thresholds.overdueMinutes}`;
  useEffect(() => {
    if (agingThresholdSignature.current === thresholdSignature) return;
    // A threshold change reclassifies existing tickets. Re-baseline instead of
    // firing one alert per open ticket as if every one just became late.
    agingThresholdSignature.current = thresholdSignature;
    agingBaseline.current = null;
  }, [thresholdSignature]);

  useEffect(() => {
    if (lastUpdatedAt === null) return;
    const currentStages = new Map<string, KitchenAgingStage>();
    for (const ticket of tickets) {
      currentStages.set(
        ticket.key,
        kitchenAgingStage(ticketAgeMinutes(ticket.earliestSentAt, now), thresholds),
      );
    }
    const diff = diffKitchenAgingStages(agingBaseline.current, currentStages);
    agingBaseline.current = diff.next;
    if (diff.alerts.length === 0) return;
    const overdue = diff.alerts.filter((alert) => alert.stage === "overdue").length;
    toast.info(
      overdue > 0
        ? `${toPersianDigits(overdue)} سفارش از آستانهٔ تأخیر عبور کرد.`
        : `${toPersianDigits(diff.alerts.length)} سفارش به آستانهٔ تأخیر نزدیک شد.`,
    );
    playAlertTone("aging");
  }, [lastUpdatedAt, now, playAlertTone, thresholds, tickets]);
  const metadataFilteredTickets = useMemo(() => tickets.filter((ticket) => {
    if (orderTypeFilter !== "all" && ticket.orderType !== orderTypeFilter) return false;
    const aging = kitchenAgingStage(
      ticketAgeMinutes(ticket.earliestSentAt, now),
      thresholds,
    ) === "overdue";
    if (ageFilter === "aging" && !aging) return false;
    if (ageFilter === "within" && aging) return false;
    if (readyForPickupOnly && !ticket.items.some((item) => item.status === "ready")) return false;
    return true;
  }), [ageFilter, now, orderTypeFilter, readyForPickupOnly, thresholds, tickets]);

  const visibleTickets = useMemo(
    () => filter === "all"
      ? metadataFilteredTickets
      : metadataFilteredTickets.filter((ticket) => ticket.status === filter),
    [filter, metadataFilteredTickets],
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
      { value: "all" as const, label: "همه", count: metadataFilteredTickets.length },
      ...(["sent", "preparing", "ready"] as TicketStatus[]).map((status) => ({
        value: status,
        label: STATUS_META[status].filterLabel,
        count: metadataFilteredTickets.filter((ticket) => ticket.status === status).length,
      })),
    ],
    [metadataFilteredTickets],
  );

  const nextTicket = visibleTickets[0] ?? null;
  const queueStale = snapshotStale ||
    (realtimeConnected === false && lastUpdatedAt !== null) ||
    (isOnline && lastUpdatedAt !== null && now - lastUpdatedAt > 60_000);

  const syncLabel = !isOnline
    ? "اتصال اینترنت قطع است"
    : pendingCount > 0
      ? `${toPersianDigits(pendingCount)} تغییر در انتظار همگام‌سازی`
      : isRefreshing
        ? "در حال دریافت تصویر تازهٔ صف"
        : realtimeConnected === false
          ? "اتصال زنده قطع است؛ تلاش برای اتصال مجدد"
          : queueStale
            ? "صف آشپزخانه قدیمی است؛ اتصال یا همگام‌سازی را بررسی کنید"
            : lastUpdatedAt
              ? `زنده · به‌روزرسانی ${formatUpdatedAt(lastUpdatedAt)}`
              : "در حال دریافت صف";

  const connectionTone = !isOnline
    ? "bg-destructive"
    : pendingCount > 0 || realtimeConnected === false || queueStale
      ? "bg-amber-500 dark:bg-amber-400"
      : "bg-emerald-500 dark:bg-emerald-500";

  const dataStaleWhileLive =
    isOnline &&
    realtimeConnected !== false &&
    lastUpdatedAt !== null &&
    now - lastUpdatedAt > 60_000;

  useEffect(() => {
    if (dataStaleWhileLive && !staleAlertShown.current) {
      toast.warning("دادهٔ صف آشپزخانه قدیمی است؛ برای دریافت تصویر تازه به‌روزرسانی کنید.");
      playAlertTone("connection");
    }
    staleAlertShown.current = dataStaleWhileLive;
  }, [dataStaleWhileLive, playAlertTone]);

  useEffect(
    () =>
      subscribeKitchenPrintFailures((detail) => {
        // The workspace-level print worker owns the shared print notification
        // (it already respects `printing.behavior.notifications`). The KDS adds
        // its own opt-in tone and a persistent local line so a screen reader
        // user who missed the toast still has the state.
        playAlertTone("printFailure");
        setPrintFailureNotice(kitchenPrintFailureText(detail));
      }),
    [playAlertTone],
  );

  async function saveThresholds(next: KitchenAlertThresholds): Promise<{ ok: boolean; error?: string }> {
    const result = await api<{ thresholds?: unknown; error?: string }>("/api/kitchen/alerts", {
      method: "PUT",
      body: JSON.stringify({ thresholds: next }),
    });
    if (!result.ok) return { ok: false, error: errorMessage(result.data.error) };
    const parsed = parseKitchenAlertThresholds(result.data.thresholds);
    if (!parsed) return { ok: false, error: "پاسخ تنظیمات آستانه معتبر نیست." };
    setThresholds(parsed);
    writeCachedThresholds(parsed);
    setThresholdsWarning(null);
    return { ok: true };
  }

  async function toggleSound() {
    if (soundPreferences.enabled && audioReady) {
      setSoundPreferences((current) => ({ ...current, enabled: false }));
      void audioContext.current?.close().catch(() => {});
      audioContext.current = null;
      setAudioReady(false);
      setSoundBlocked(false);
      return;
    }
    // Enabled-from-storage but not yet unlocked in this page: the button says
    // «فعال‌سازی», so this click must resume the context rather than mute.
    const ready = await ensureAudio();
    if (!ready) {
      setSoundPreferences((current) => ({ ...current, enabled: false }));
      toast.warning(
        "پخش صدا در این مرورگر مسدود است؛ هشدارهای بصری همچنان نمایش داده می‌شوند.",
      );
      return;
    }
    setSoundPreferences((current) => ({ ...current, enabled: true }));
    playTone("newTicket");
  }

  function toggleSoundEvent(event: KitchenSoundEventKey) {
    setSoundPreferences((current) => ({
      ...current,
      events: { ...current.events, [event]: !current.events[event] },
    }));
  }

  async function testSound() {
    if (!(await ensureAudio())) {
      toast.warning(
        "پخش صدا در این مرورگر مسدود است؛ هشدارهای بصری همچنان نمایش داده می‌شوند.",
      );
      return;
    }
    playTone("newTicket");
  }

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

  async function batchBump(ticket: Ticket, status: "preparing" | "ready") {
    const expected = status === "preparing" ? "sent" : "preparing";
    const eligible = ticket.items.filter((item) => item.status === expected);
    if (eligible.length === 0) return;
    setBatchingStatus(status);
    setMutationMessage(null);
    let applied = 0;
    let queued = 0;
    let failed = 0;
    try {
      for (const item of eligible) {
        try {
          const result = await apiOrQueue<ApiError>(
            `/api/kitchen/items/${item.id}`,
            { method: "PATCH", body: { status } },
            {
              type: "order_item.status",
              payload: { itemId: item.id, status },
              description: "به‌روزرسانی گروهی وضعیت آشپزخانه",
            },
          );
          if (!result.ok) failed += 1;
          else if (result.queued) queued += 1;
          else applied += 1;
        } catch {
          failed += 1;
        }
      }
      const parts = [
        applied ? `${toPersianDigits(applied)} اعمال شد` : "",
        queued ? `${toPersianDigits(queued)} در صف همگام‌سازی` : "",
        failed ? `${toPersianDigits(failed)} انجام نشد؛ وضعیت هر قلم را بررسی کنید` : "",
      ].filter(Boolean);
      setMutationMessage(parts.join("، "));
      if (applied > 0) await load();
    } finally {
      setBatchingStatus(null);
    }
  }

  async function archiveStaleTickets() {
    if (!window.confirm("سفارش‌های انتخاب‌شده از صف آشپزخانه بایگانی شوند؟ وضعیت سفارش و پرداخت تغییر نمی‌کند.")) return;

    setArchivingStale(true);
    setStaleError(null);
    try {
      const result = await api<{ archivedCount?: number; error?: string }>("/api/kitchen/tickets/stale", {
        method: "POST",
        body: JSON.stringify({ orderIds: selectedStaleIds }),
      });
      if (!result.ok) {
        setStaleError(errorMessage(result.data.error));
        return;
      }
      setSelectedStaleIds([]);
      setStaleTickets(null);
      setReviewRevision((revision) => revision + 1);
      toast.success(`${toPersianDigits(String(result.data.archivedCount ?? 0))} سفارش بایگانی شد.`);
      void load({ showRefresh: true });
    } catch {
      setStaleError("بایگانی سفارش‌ها انجام نشد.");
    } finally {
      setArchivingStale(false);
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
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <KnowledgeHelpButton section="kitchen" />
            <Button
              type="button"
              variant="outline"
              aria-expanded={showAlertSettings}
              onClick={() => setShowAlertSettings((open) => !open)}
              className="min-h-[48px] shrink-0"
            >
              اعلان‌ها و صدا
            </Button>
            {canReviewStale ? (
              <Button type="button" variant="outline" aria-expanded={showWorkflowSettings}
                onClick={() => setShowWorkflowSettings((open) => !open)}>
                تنظیمات آشپزخانه
              </Button>
            ) : null}
            {canReviewStale ? (
              <Button
                type="button"
                variant="outline"
                aria-expanded={showStaleReview}
                disabled={archivingStale}
                onClick={() => {
                  setStaleTickets(null);
                  setStaleError(null);
                  setSelectedStaleIds([]);
                  setShowStaleReview(!showStaleReview);
                }}
              >
                بررسی سفارش‌های قدیمی
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              aria-pressed={soundPreferences.enabled}
              onClick={() => void toggleSound()}
              className="min-h-[48px] shrink-0"
            >
              {soundPreferences.enabled
                ? audioReady ? "هشدار صوتی روشن" : "فعال‌سازی صدای هشدار"
                : "هشدار صوتی خاموش"}
            </Button>
            <p
              className="flex min-h-11 min-w-0 items-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <span
                className={`size-2.5 shrink-0 rounded-full ${connectionTone}`}
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

      {soundBlocked ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200"
        >
          <span>
            پخش صدا در این مرورگر مسدود شده است؛ هشدارهای بصری همچنان نمایش داده
            می‌شوند.
          </span>
          <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => void toggleSound()}>
            تلاش دوباره برای صدا
          </Button>
        </div>
      ) : null}

      {printFailureNotice ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm font-medium text-red-800 dark:text-red-200"
        >
          <span>{printFailureNotice}</span>
          <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => setPrintFailureNotice(null)}>
            بستن
          </Button>
        </div>
      ) : null}

      {showAlertSettings ? (
        <KitchenAlertSettings
          canEditThresholds={canEditThresholds}
          thresholds={thresholds}
          thresholdsWarning={thresholdsWarning}
          soundPreferences={soundPreferences}
          soundBlocked={soundBlocked}
          audioReady={audioReady}
          onToggleSound={() => void toggleSound()}
          onToggleSoundEvent={toggleSoundEvent}
          onTestSound={() => void testSound()}
          onSaveThresholds={saveThresholds}
        />
      ) : null}

      {canReviewStale && showWorkflowSettings ? <KitchenWorkflowSettings /> : null}

      {canReviewStale && showStaleReview ? (
        <section className={`${cardClass} space-y-2 p-4`}>
          <h2 className="font-semibold">
            {showKitchenHistory ? "تاریخچه آشپزخانه" : "سفارش‌های مانده در صف آشپزخانه از ۶۰ روز پیش"}
          </h2>
          <Button type="button" variant="outline" disabled={archivingStale} onClick={() => {
            setStaleTickets(null);
            setStaleError(null);
            setSelectedStaleIds([]);
            setShowKitchenHistory(!showKitchenHistory);
          }}>
            {showKitchenHistory ? "بررسی سفارش‌های قدیمی" : "تاریخچه آشپزخانه"}
          </Button>
          {!showKitchenHistory && staleTickets?.length ? (
            <Button type="button" variant="outline" disabled={archivingStale || selectedStaleIds.length === 0}
              onClick={() => void archiveStaleTickets()}>
              بایگانی انتخاب‌شده‌ها
            </Button>
          ) : null}
          {staleError ? <p role="alert">{staleError}</p> : null}
          {!staleError && staleTickets === null ? (
            <p role="status">در حال دریافت سفارش‌ها…</p>
          ) : null}
          {staleTickets?.length === 0 ? <p>{showKitchenHistory ? "تاریخچه این شعبه خالی است." : "سفارش قدیمی در صف این شعبه وجود ندارد."}</p> : null}
          {staleTickets?.length ? (
            <>
              <p>{toPersianDigits(String(staleTickets.length))} سفارش در این فهرست</p>
              <ul className="max-h-80 space-y-1 overflow-auto">
                {staleTickets.map((ticket) => (
                  <li key={ticket.archived_at ? `${ticket.order_id}:${ticket.archived_at}` : ticket.order_id} className="text-sm">
                    {!showKitchenHistory ? (
                      <input type="checkbox" className="me-2" disabled={archivingStale}
                        aria-label={`انتخاب سفارش ${toPersianDigits(String(ticket.order_number))}`}
                        checked={selectedStaleIds.includes(ticket.order_id)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setSelectedStaleIds((ids) => checked
                            ? [...ids, ticket.order_id]
                            : ids.filter((id) => id !== ticket.order_id));
                        }}
                      />
                    ) : null}
                    سفارش {toPersianDigits(String(ticket.order_number))}
                    {" · "}
                    {ticket.order_status === "completed" ? "تکمیل‌شده" : "نیازمند بررسی"}
                    {" · "}
                    {toPersianDigits(String(ticket.item_count))} ردیف
                    {ticket.archived_at ? (
                      <>{" · "}{ticket.reason === "paid" ? "پرداخت کامل"
                        : ticket.reason === "timer" ? "پایان زمان نگهداری"
                          : ticket.reason === "shift" ? "بستن شیفت"
                          : "بایگانی دستی سفارش قدیمی"}{" · "}
                        {formatJalali(new Date(ticket.archived_at), { withMonthName: true })}</>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {queueStale ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200" role="alert">
          {realtimeConnected === false
            ? "اتصال زنده قطع شده؛ تا دریافت تصویر معتبر بعدی ممکن است صف به‌روز نباشد."
            : "صف آشپزخانه تازه نیست؛ وضعیت فعلی ممکن است تغییر کرده باشد."}
          <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => void load({ showRefresh: true })}>
            دریافت دوباره
          </Button>
        </div>
      ) : null}

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

      <section className={`${cardClass} flex flex-wrap items-end gap-3 p-3`} aria-label="فیلترهای صف آشپزخانه">
        <label className="grid min-w-36 gap-1 text-xs font-semibold text-muted-foreground">
          نوع سفارش
          <select value={orderTypeFilter} onChange={(event) => setOrderTypeFilter(event.target.value as OrderTypeFilter)} className="min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm text-foreground">
            <option value="all">همهٔ نوع‌ها</option>
            <option value="dine_in">حضوری</option>
            <option value="takeaway">بیرون‌بر</option>
            <option value="delivery">ارسال</option>
          </select>
        </label>
        <label className="grid min-w-40 gap-1 text-xs font-semibold text-muted-foreground">
          زمان انتظار
          <select value={ageFilter} onChange={(event) => setAgeFilter(event.target.value as TicketAgeFilter)} className="min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm text-foreground">
            <option value="all">همه</option>
            <option value="aging">عبور از آستانهٔ تأخیر</option>
            <option value="within">زیر آستانهٔ تأخیر</option>
          </select>
        </label>
        <div className="grid min-w-44 gap-1 text-xs font-semibold text-muted-foreground">
          آستانهٔ تأخیر این شعبه
          <div className="flex min-h-[44px] flex-wrap items-center gap-2 rounded-lg border border-border bg-muted px-3 text-sm text-foreground">
            <span>{toPersianDigits(thresholds.overdueMinutes)} دقیقه</span>
            {thresholds.approachingMinutes !== null ? (
              <span className="text-xs text-muted-foreground">
                · نزدیک از {toPersianDigits(thresholds.approachingMinutes)}
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="min-h-[44px] px-2 text-xs"
              onClick={() => setShowAlertSettings(true)}
            >
              تنظیم
            </Button>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          aria-pressed={readyForPickupOnly}
          onClick={() => setReadyForPickupOnly((value) => !value)}
          className={cn("min-h-[44px]", readyForPickupOnly && "border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200")}
        >
          آمادهٔ تحویل ({toPersianDigits(tickets.filter((ticket) => ticket.items.some((item) => item.status === "ready")).length)})
        </Button>
      </section>

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
                          thresholds={thresholds}
                        />
                        {selectedTicket?.key === ticket.key ? (
                          <div className="mt-3 md:hidden">
                            <TicketDetails
                              ticket={ticket}
                              now={now}
                              modifiersByItem={modifiersByItem}
                              bumpingItemId={bumpingItemId}
                              batchingStatus={batchingStatus}
                              onBump={bump}
                              onBatch={(status) => void batchBump(ticket, status)}
                              thresholds={thresholds}
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
                  batchingStatus={batchingStatus}
                  onBump={bump}
                  onBatch={(status) => void batchBump(selectedTicket, status)}
                  thresholds={thresholds}
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
