/**
 * Kitchen alert policy — pure helpers shared by the KDS, its settings API and
 * the scanned notification producer.
 *
 * Two different things live here on purpose, and they must stay separate:
 *
 *  - **Preparation-age thresholds** are a branch decision. They are persisted
 *    in `settings` under `kitchen.alerts` and read by every KDS in that branch,
 *    so two screens on the same pass cannot disagree about when a ticket is
 *    "approaching" or "late".
 *  - **Sound preferences** are a device decision. They live in this browser's
 *    storage and never travel to another device. Sound is opt-in; the visual
 *    alert path is always available.
 *
 * Nothing here invents a preparation duration. The only default is the
 * platform's existing `DEFAULT_TICKET_AGING_MINUTES`; an approaching threshold
 * has no default at all until the branch configures one.
 */
import { DEFAULT_TICKET_AGING_MINUTES, ticketAgeMinutes } from "./order-item-status";

export const KITCHEN_ALERT_MIN_MINUTES = 1;
export const KITCHEN_ALERT_MAX_MINUTES = 1440;

export interface KitchenAlertThresholds {
  /** `null` = no approaching-stage alert; only the late threshold is used. */
  approachingMinutes: number | null;
  /** The branch's late/overdue threshold; always configured because the KDS has always had one. */
  overdueMinutes: number;
}

export const DEFAULT_KITCHEN_ALERT_THRESHOLDS: KitchenAlertThresholds = {
  approachingMinutes: null,
  overdueMinutes: DEFAULT_TICKET_AGING_MINUTES,
};

function isMinuteValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= KITCHEN_ALERT_MIN_MINUTES &&
    value <= KITCHEN_ALERT_MAX_MINUTES
  );
}

/**
 * Parse a persisted/API threshold object. Deliberately strict: a corrupt or
 * out-of-range setting falls back to the platform default rather than being
 * silently clamped, so a typo cannot quietly change the pass's alert times.
 */
export function parseKitchenAlertThresholds(input: unknown): KitchenAlertThresholds | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (!isMinuteValue(record.overdueMinutes)) return null;
  const approaching = record.approachingMinutes;
  if (approaching !== null && approaching !== undefined && !isMinuteValue(approaching)) return null;
  const approachingMinutes = approaching == null ? null : approaching;
  if (approachingMinutes !== null && approachingMinutes >= record.overdueMinutes) return null;
  return { approachingMinutes, overdueMinutes: record.overdueMinutes };
}

/** Branch override wins; business default next; platform default last. */
export function resolveKitchenAlertThresholds(
  businessDefault: KitchenAlertThresholds | null,
  branchOverride: KitchenAlertThresholds | null,
): KitchenAlertThresholds {
  return branchOverride ?? businessDefault ?? DEFAULT_KITCHEN_ALERT_THRESHOLDS;
}

export type KitchenAgingStage = "within" | "approaching" | "overdue";

const AGING_STAGE_RANK: Record<KitchenAgingStage, number> = {
  within: 0,
  approaching: 1,
  overdue: 2,
};

/**
 * The visible/alerting stage of a ticket at `ageMinutes`. The age itself must
 * come from a persisted timestamp (`sent_to_kitchen_at`); this function only
 * classifies it against the branch's own configured thresholds.
 */
export function kitchenAgingStage(
  ageMinutes: number,
  thresholds: KitchenAlertThresholds,
): KitchenAgingStage {
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) return "within";
  if (ageMinutes >= thresholds.overdueMinutes) return "overdue";
  if (thresholds.approachingMinutes !== null && ageMinutes >= thresholds.approachingMinutes) {
    return "approaching";
  }
  return "within";
}

export function kitchenAgingStageRank(stage: KitchenAgingStage): number {
  return AGING_STAGE_RANK[stage];
}

export function kitchenTicketAgingStage(
  sentAtMs: number,
  nowMs: number,
  thresholds: KitchenAlertThresholds,
): KitchenAgingStage {
  return kitchenAgingStage(ticketAgeMinutes(sentAtMs, nowMs), thresholds);
}

// ---------------------------------------------------------------------------
// New-ticket / new-items detection
// ---------------------------------------------------------------------------

export interface KitchenAlertItemIdentity {
  id: string;
  order_id: string;
}

export interface KitchenAlertBaseline {
  orderIds: Set<string>;
  itemIds: Set<string>;
}

export type KitchenTicketAlertKind = "new_ticket" | "items_added";

export interface KitchenTicketAlert {
  kind: KitchenTicketAlertKind;
  orderId: string;
  itemIds: string[];
}

/**
 * Compare the authoritative queue snapshot with everything this KDS has
 * already acknowledged. The first snapshot is a baseline (`previous === null`)
 * so a page load or refresh never replays every open ticket as "new". On a
 * reconnect the previous baseline survives, so only genuinely new orders/lines
 * alert.
 *
 * Both sets only grow for the session: an order that leaves the queue and
 * comes back (or a stale response that briefly omits a line) must not alert a
 * second time. Kitchen tickets are short-lived, so the memory cost is bounded
 * by one shift.
 */
export function diffKitchenAlerts(
  previous: KitchenAlertBaseline | null,
  items: readonly KitchenAlertItemIdentity[],
): { alerts: KitchenTicketAlert[]; next: KitchenAlertBaseline } {
  if (previous === null) {
    return {
      alerts: [],
      next: {
        orderIds: new Set(items.map((item) => item.order_id)),
        itemIds: new Set(items.map((item) => item.id)),
      },
    };
  }

  const newOrderItems = new Map<string, string[]>();
  const addedItems = new Map<string, string[]>();
  for (const item of items) {
    if (previous.itemIds.has(item.id)) continue;
    const target = previous.orderIds.has(item.order_id) ? addedItems : newOrderItems;
    target.set(item.order_id, [...(target.get(item.order_id) ?? []), item.id]);
  }

  const alerts: KitchenTicketAlert[] = [
    ...[...newOrderItems.entries()].map(([orderId, itemIds]) => ({
      kind: "new_ticket" as const,
      orderId,
      itemIds,
    })),
    ...[...addedItems.entries()].map(([orderId, itemIds]) => ({
      kind: "items_added" as const,
      orderId,
      itemIds,
    })),
  ];

  return {
    alerts,
    next: {
      orderIds: new Set([...previous.orderIds, ...items.map((item) => item.order_id)]),
      itemIds: new Set([...previous.itemIds, ...items.map((item) => item.id)]),
    },
  };
}

// ---------------------------------------------------------------------------
// Aging alert de-duplication
// ---------------------------------------------------------------------------

export interface KitchenAgingAlert {
  ticketKey: string;
  stage: Exclude<KitchenAgingStage, "within">;
}

/**
 * A ticket alerts only when it moves *up* a configured stage. Moving down
 * (an item was bumped, a threshold changed) updates the baseline silently, and
 * the first snapshot is a baseline. That is what makes reconnect/refresh and
 * repeated scans idempotent.
 */
export function diffKitchenAgingStages(
  previous: ReadonlyMap<string, KitchenAgingStage> | null,
  current: ReadonlyMap<string, KitchenAgingStage>,
): { alerts: KitchenAgingAlert[]; next: Map<string, KitchenAgingStage> } {
  if (previous === null) {
    return { alerts: [], next: new Map(current) };
  }
  const alerts: KitchenAgingAlert[] = [];
  for (const [ticketKey, stage] of current) {
    if (stage === "within") continue;
    const previousStage = previous.get(ticketKey) ?? "within";
    if (kitchenAgingStageRank(stage) > kitchenAgingStageRank(previousStage)) {
      alerts.push({ ticketKey, stage });
    }
  }
  return {
    alerts,
    next: new Map([...previous, ...current]),
  };
}

// ---------------------------------------------------------------------------
// Device-local sound preferences
// ---------------------------------------------------------------------------

export const KITCHEN_SOUND_EVENT_KEYS = [
  "newTicket",
  "addedItems",
  "aging",
  "connection",
  "printFailure",
] as const;
export type KitchenSoundEventKey = (typeof KITCHEN_SOUND_EVENT_KEYS)[number];

export type KitchenSoundEventPreferences = Record<KitchenSoundEventKey, boolean>;

export interface KitchenSoundPreferences {
  /** Master switch. Off by default: sound is opt-in, never autoplayed. */
  enabled: boolean;
  events: KitchenSoundEventPreferences;
}

export const DEFAULT_KITCHEN_SOUND_PREFERENCES: KitchenSoundPreferences = {
  enabled: false,
  events: {
    newTicket: true,
    addedItems: true,
    aging: true,
    connection: true,
    printFailure: true,
  },
};

export function parseKitchenSoundPreferences(input: unknown): KitchenSoundPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_KITCHEN_SOUND_PREFERENCES, events: { ...DEFAULT_KITCHEN_SOUND_PREFERENCES.events } };
  }
  const record = input as Record<string, unknown>;
  const rawEvents =
    record.events && typeof record.events === "object" && !Array.isArray(record.events)
      ? (record.events as Record<string, unknown>)
      : {};
  const events = { ...DEFAULT_KITCHEN_SOUND_PREFERENCES.events };
  for (const key of KITCHEN_SOUND_EVENT_KEYS) {
    if (typeof rawEvents[key] === "boolean") events[key] = rawEvents[key];
  }
  return { enabled: record.enabled === true, events };
}

export function kitchenSoundEnabledFor(
  preferences: KitchenSoundPreferences,
  event: KitchenSoundEventKey,
): boolean {
  return preferences.enabled && preferences.events[event];
}

/** Human-readable labels for the device-local sound matrix. */
export const KITCHEN_SOUND_EVENT_LABELS: Record<KitchenSoundEventKey, string> = {
  newTicket: "سفارش تازه",
  addedItems: "اقلام تازه به سفارش موجود",
  aging: "نزدیک‌شدن یا گذشتن از آستانهٔ آماده‌سازی",
  connection: "قطع و وصل اتصال زنده",
  printFailure: "خطای ارسال به چاپگر آشپزخانه",
};

/**
 * One tone per event, in hertz — the board and the settings screen's test
 * button must play the same tone for the same event, so the map is shared
 * rather than defined next to whichever screen happened to need it first.
 */
export const KITCHEN_ALERT_TONE_FREQUENCY: Record<KitchenSoundEventKey, number> = {
  newTicket: 880,
  addedItems: 988,
  aging: 660,
  connection: 440,
  printFailure: 330,
};
