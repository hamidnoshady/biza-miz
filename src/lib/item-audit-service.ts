/**
 * Phase 21 Wave 7 — item lifecycle events, for the audit trail on
 * high-value goods.
 *
 * A weighed gold piece or a serialized watch is worth more than most of
 * what this system tracks, and "who changed its cost basis, and when" is a
 * real question an auditor asks. Sales and repairs already leave a record
 * (they post through the domain-event engine); intake and edits did not,
 * because they have no ledger effect.
 *
 * They do not need one. The engine already handles an event with no
 * registered posting rule by recording it and posting nothing — a
 * deliberate design point since Wave 1 ("not every domain event has a
 * ledger effect") — so these lifecycle events use exactly the same log,
 * and `itemAuditTrail` (industry-reports-service.ts) reads posted and
 * unposted events back as one timeline.
 *
 * Called from route handlers rather than from the services themselves,
 * because it is the request that knows *who* acted and which business they
 * acted for; the item services take neither.
 */
import type { PoolClient } from "pg";
import { getPool } from "./db";
import { recordDomainEvent } from "./posting-engine";

export const ITEM_AUDIT_EVENTS = [
  "item.created",
  "item.cost_basis_changed",
  "item.stone_added",
  "item.stone_removed",
  "item.consigned",
  "item.stock_received",
  "item.price_changed",
  "item.batch_received",
  "item.profile_changed",
  "item.merchandising_bulk_update",
  "item.markdown_applied",
  // GH #1567 F2 — a reviewed opening-stock document received this item.
  "item.opening_stock_posted",
] as const;
export type ItemAuditEvent = (typeof ITEM_AUDIT_EVENTS)[number];

export interface RecordItemEventInput {
  businessId: string;
  locationId: string;
  itemId: string;
  eventType: ItemAuditEvent;
  payload?: Record<string, unknown>;
  createdBy?: string | null;
}

/**
 * Appends one lifecycle event for an item. Best-effort by design: an audit
 * note must never be the reason a legitimate intake or edit fails, so a
 * failure here is swallowed rather than propagated to the caller's
 * response. (Sales and repairs are the opposite — their events carry
 * postings, so they run inside the caller's transaction and fail with it.)
 */
export async function recordItemEvent(input: RecordItemEventInput, client?: PoolClient): Promise<void> {
  // An optional caller-supplied client lets a bulk edit record its audit
  // trail inside the same transaction as the edit, so they roll back together.
  if (client) {
    try {
      await recordDomainEvent(client, {
        businessId: input.businessId,
        locationId: input.locationId,
        eventType: input.eventType,
        payload: { itemId: input.itemId, ...(input.payload ?? {}) },
        sourceType: "item_audit",
        sourceId: input.itemId,
        createdBy: input.createdBy ?? null,
      });
    } catch {
      // Deliberately swallowed — see the doc comment above.
    }
    return;
  }

  const ownClient = await getPool().connect();
  try {
    await recordDomainEvent(ownClient, {
      businessId: input.businessId,
      locationId: input.locationId,
      eventType: input.eventType,
      payload: { itemId: input.itemId, ...(input.payload ?? {}) },
      sourceType: "item_audit",
      sourceId: input.itemId,
      createdBy: input.createdBy ?? null,
    });
  } catch {
    // Deliberately swallowed — see the doc comment above.
  } finally {
    ownClient.release();
  }
}
