import type { Permission } from "./permissions";

export const SYNC_EVENT_REGISTRY_VERSION = 1 as const;

type LocationRule = "event_location" | "business_transfer";
type EffectClass = "order" | "payment" | "refund" | "journal_reversal" | "inventory" | "transfer" | "shift";

export interface SyncEventDefinition {
  type: string;
  schemaVersion: number;
  handler: string;
  permission: Permission;
  effectClass: EffectClass;
  locationRule: LocationRule;
  dependencyErrors: readonly string[];
  payloadFields: readonly string[];
  legacy?: boolean;
  /**
   * Section 5 offline-queue-extension audit: whether the client's local
   * Dexie queue (src/lib/offline-db.ts) is allowed to flush this event type
   * through POST /api/sync/events. This is a narrower allowlist than "every
   * transactional definition" on purpose — the offline queue is a
   * deliberately small surface (see docs/phases/Phase-5-Offline-Queue-Hardware.md),
   * and a type is only added here alongside real client wiring (a
   * PendingActionType, a resolveQueueRecordRef case, and a UI call site),
   * never merely because the server-side handler happens to already exist.
   * sync-event-registry.test.ts enforces that every flagged type here has
   * the matching client wiring, the same way it already enforces one switch
   * case per transactional definition.
   */
  offlineQueueEligible?: boolean;
}

/**
 * Phase 45 made the cloud the system of record for stock, transfers and the
 * ledger; a Hybrid desktop has no screen for them. The cloud still records
 * those events for a paired branch, so a desktop that tried to replay them
 * waited forever on master data it never receives (a cloud purchase names a
 * supplier the desktop does not have) and showed them as «در انتظار پیش‌نیاز».
 * A desktop acknowledges a pulled event of these classes without applying it.
 */
const CLOUD_OWNED_EFFECT_CLASSES: ReadonlySet<EffectClass> = new Set(["inventory", "transfer", "journal_reversal"]);

/** Whether a desktop (runtime role `site`) acknowledges this pulled cloud event instead of applying it. */
export function siteSkipsPulledEvent(definition: Pick<SyncEventDefinition, "effectClass">): boolean {
  return CLOUD_OWNED_EFFECT_CLASSES.has(definition.effectClass);
}

const ORDER_PERMISSION = "orders.create" as const;
const PAYMENT_PERMISSION = "payments.take" as const;
const REFUND_PERMISSION = "payments.refund" as const;
const INVENTORY_PERMISSION = "inventory.adjust" as const;
/** The permission `/api/shifts/start` already requires to clock in. */
const SHIFT_PERMISSION = "orders.create" as const;

/**
 * Authoritative, machine-readable sync event catalogue.
 *
 * There is no wildcard/version fallback: (type, schemaVersion) must match one
 * row exactly. This object drives route validation, dispatch, diagnostics and
 * catalogue tests, so those surfaces cannot silently drift apart.
 */
export const SYNC_EVENT_REGISTRY = [
  { type: "order.create", schemaVersion: 1, handler: "legacy.order.create", permission: ORDER_PERMISSION, effectClass: "order", locationRule: "event_location", dependencyErrors: [], payloadFields: ["orderId", "type", "tableId", "customerId", "guestCount", "note", "discount", "items", "delivery"], legacy: true },
  { type: "order.add_items", schemaVersion: 1, handler: "legacy.order.add_items", permission: ORDER_PERMISSION, effectClass: "order", locationRule: "event_location", dependencyErrors: ["order_not_found"], payloadFields: ["orderId", "items"], legacy: true },
  { type: "order_item.status", schemaVersion: 1, handler: "legacy.order_item.status", permission: ORDER_PERMISSION, effectClass: "order", locationRule: "event_location", dependencyErrors: ["item_not_found"], payloadFields: ["itemId", "status"], legacy: true },
  // Migration 0190: the whole open order after every change (lines, add-ons,
  // discount, table, customer, kitchen status, void). See order-state-sync.ts.
  { type: "order.state.synced", schemaVersion: 1, handler: "order.state.synced", permission: ORDER_PERMISSION, effectClass: "order", locationRule: "event_location", dependencyErrors: ["customer_not_found", "menu_item_not_found"], payloadFields: ["orderId", "stateHlc", "order", "items"] },
  // Migration 0190: a closed-order amendment, replayed through the same
  // service with the new lines' ids so a later amendment finds them.
  { type: "order.amendment.posted", schemaVersion: 1, handler: "order.amendment.posted", permission: "orders.amend_closed", effectClass: "order", locationRule: "event_location", dependencyErrors: ["order_not_found", "order_not_completed"], payloadFields: ["orderId", "input", "newItemIds"] },

  { type: "order.payment.completed", schemaVersion: 1, handler: "order.payment.completed", permission: PAYMENT_PERMISSION, effectClass: "payment", locationRule: "event_location", dependencyErrors: ["order_not_found", "order_not_open", "customer_not_found"], payloadFields: ["orderId", "method", "reference", "customerId", "tipAmount", "businessDate"] },
  { type: "order.payment.completed", schemaVersion: 2, handler: "order.payment.completed.v2", permission: PAYMENT_PERMISSION, effectClass: "payment", locationRule: "event_location", dependencyErrors: ["order_not_found", "order_not_open", "customer_not_found", "customer_required"], payloadFields: ["orderId", "tenders", "customerId", "tipAmount", "businessDate", "entryDate"] },
  { type: "order.customer_return.created", schemaVersion: 1, handler: "order.customer_return.created", permission: REFUND_PERMISSION, effectClass: "refund", locationRule: "event_location", dependencyErrors: ["completed_order_not_found", "order_item_not_found", "historical_cogs_unavailable"], payloadFields: ["orderId", "refundMethod", "refundAmount", "reason", "lines"] },
  { type: "accounting.manual_journal.reversed", schemaVersion: 1, handler: "accounting.manual_journal.reversed", permission: "ledger.approve", effectClass: "journal_reversal", locationRule: "event_location", dependencyErrors: ["entry_not_found"], payloadFields: ["entryId", "memo", "entryDate"] },

  { type: "inventory.purchase.created", schemaVersion: 1, handler: "inventory.purchase.created", permission: INVENTORY_PERMISSION, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["supplier_not_found", "item_not_found"], payloadFields: ["purchaseId", "supplierId", "note", "purchaseDate", "items"] },
  { type: "inventory.purchase.received", schemaVersion: 1, handler: "inventory.purchase.received", permission: INVENTORY_PERMISSION, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["purchase_not_found", "supplier_not_found"], payloadFields: ["purchaseId", "settlementMethod", "supplierId"] },
  { type: "inventory.supplier_return.created", schemaVersion: 1, handler: "inventory.supplier_return.created", permission: INVENTORY_PERMISSION, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["received_purchase_not_found", "supplier_return_purchase_item_not_found"], payloadFields: ["purchaseId", "settlementMethod", "reason", "lines"] },

  { type: "inventory.transfer.created", schemaVersion: 1, handler: "inventory.transfer.created", permission: INVENTORY_PERMISSION, effectClass: "transfer", locationRule: "business_transfer", dependencyErrors: ["transfer_inventory_item_not_found", "transfer_location_not_found"], payloadFields: ["transferId", "destinationLocationId", "note", "lines"] },
  { type: "inventory.transfer.shipped", schemaVersion: 1, handler: "inventory.transfer.shipped", permission: INVENTORY_PERMISSION, effectClass: "transfer", locationRule: "business_transfer", dependencyErrors: ["transfer_not_found"], payloadFields: ["transferId"] },
  { type: "inventory.transfer.received", schemaVersion: 1, handler: "inventory.transfer.received", permission: INVENTORY_PERMISSION, effectClass: "transfer", locationRule: "business_transfer", dependencyErrors: ["transfer_not_found", "invalid_transfer_status"], payloadFields: ["transferId"] },
  { type: "inventory.transfer.cancelled", schemaVersion: 1, handler: "inventory.transfer.cancelled", permission: INVENTORY_PERMISSION, effectClass: "transfer", locationRule: "business_transfer", dependencyErrors: ["transfer_not_found"], payloadFields: ["transferId"] },

  // offlineQueueEligible (Section 5 audit): the only non-order client queue
  // action so far, wired through src/app/dashboard/inventory/waste-section.tsx.
  // The waste handler was already fully transactional/idempotent (Phase 32) —
  // this only opens the existing server behaviour to the client's offline
  // queue, it does not add new server logic.
  { type: "inventory.waste.recorded", schemaVersion: 1, handler: "inventory.waste.recorded", permission: INVENTORY_PERMISSION, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["item_not_found"], payloadFields: ["inventoryItemId", "quantity", "reason", "note"], offlineQueueEligible: true },
  { type: "inventory.stock_count.recorded", schemaVersion: 1, handler: "inventory.stock_count.recorded", permission: INVENTORY_PERMISSION, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["item_not_found"], payloadFields: ["countId", "note", "lines"] },
  { type: "inventory.stock_count.reversed", schemaVersion: 1, handler: "inventory.stock_count.reversed", permission: INVENTORY_PERMISSION, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["count_not_found"], payloadFields: ["countId", "note"] },
  { type: "retail.stock_count.recorded", schemaVersion: 1, handler: "retail.stock_count.recorded", permission: INVENTORY_PERMISSION, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["item_not_found"], payloadFields: ["countId", "note", "lines"] },
  { type: "retail.stock_count.reversed", schemaVersion: 1, handler: "retail.stock_count.reversed", permission: INVENTORY_PERMISSION, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["count_not_found"], payloadFields: ["countId", "note"] },
  { type: "inventory.production.recorded", schemaVersion: 1, handler: "inventory.production.recorded", permission: INVENTORY_PERMISSION, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["formula_not_found", "formula_inactive"], payloadFields: ["runId", "formulaId", "batches", "outputQuantity", "conversionCostRial", "note"] },
  { type: "inventory.production.reversed", schemaVersion: 1, handler: "inventory.production.reversed", permission: INVENTORY_PERMISSION, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["run_not_found"], payloadFields: ["runId", "note"] },
  // Phase 45: a shift opened or cashed up at the till reaches the cloud's
  // shift reports; the row travels whole and replays idempotently by id.
  { type: "shift.opened", schemaVersion: 1, handler: "shift.opened", permission: SHIFT_PERMISSION, effectClass: "shift", locationRule: "event_location", dependencyErrors: ["employee_not_found"], payloadFields: ["shiftId", "employeeId", "businessDate", "openingFloat", "closingFloat", "startedAt", "endedAt", "closedBy"] },
  { type: "shift.closed", schemaVersion: 1, handler: "shift.closed", permission: SHIFT_PERMISSION, effectClass: "shift", locationRule: "event_location", dependencyErrors: ["employee_not_found"], payloadFields: ["shiftId", "employeeId", "businessDate", "openingFloat", "closingFloat", "startedAt", "endedAt", "closedBy"] },
] as const satisfies readonly SyncEventDefinition[];

export type SyncEventType = (typeof SYNC_EVENT_REGISTRY)[number]["type"];

const byKey = new Map<string, SyncEventDefinition>(
  SYNC_EVENT_REGISTRY.map((entry) => [`${entry.type}@${entry.schemaVersion}`, entry]),
);

export function syncEventDefinition(type: unknown, schemaVersion: unknown): SyncEventDefinition | null {
  if (typeof type !== "string" || !Number.isSafeInteger(schemaVersion) || Number(schemaVersion) < 1) return null;
  return byKey.get(`${type}@${schemaVersion}`) ?? null;
}

/**
 * Whether the client offline queue (POST /api/sync/events, src/lib/offline-db.ts)
 * may flush this (type, schemaVersion) pair. True for the three legacy order
 * actions (the queue's original scope) and for any definition explicitly
 * opted in via `offlineQueueEligible` (Section 5 audit extension).
 */
export function isOfflineQueueEligible(type: unknown, schemaVersion: unknown): boolean {
  const definition = syncEventDefinition(type, schemaVersion);
  if (!definition) return false;
  return Boolean(definition.legacy) || Boolean(definition.offlineQueueEligible);
}

export function publicSyncEventRegistry() {
  return {
    registryVersion: SYNC_EVENT_REGISTRY_VERSION,
    events: SYNC_EVENT_REGISTRY.map((entry: SyncEventDefinition) => ({
      type: entry.type,
      schemaVersion: entry.schemaVersion,
      permission: entry.permission,
      effectClass: entry.effectClass,
      locationRule: entry.locationRule,
      payloadFields: [...entry.payloadFields],
      transactionalDomainEffect: !entry.legacy,
    })),
  };
}
