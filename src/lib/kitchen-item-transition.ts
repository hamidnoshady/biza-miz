import { query, withTenantTransaction } from "./db";
import { enqueueCafeKitchenState } from "./cms/cafe-order-state-delivery";
import { recordOrderState } from "./order-state-sync";
import { canKitchenBump, canMarkServed, type OrderItemStatus } from "./order-item-status";
import type { OrderStateActor } from "./order-state-sync";

export type KitchenItemTransitionResult =
  | { kind: "updated"; orderId: string }
  | { kind: "missing" }
  | { kind: "duplicate"; currentStatus: OrderItemStatus }
  | { kind: "conflict"; currentStatus: OrderItemStatus };

export type KitchenBatchTargetStatus = "preparing" | "ready";

/**
 * Per-line outcome. `already_applied` is the idempotent retry answer: the line
 * was already at the requested status, so a replay changes nothing.
 * `ineligible` covers served, voided, pending and anything else the kitchen
 * must never advance; `conflict` covers an active line that moved somewhere
 * else (a different worker advanced or restarted it).
 */
export type KitchenBatchItemOutcome =
  | "applied"
  | "already_applied"
  | "conflict"
  | "ineligible"
  | "missing";

export interface KitchenBatchItemResult {
  itemId: string;
  outcome: KitchenBatchItemOutcome;
  /** The status observed (or re-read after a lost CAS); null when unknown. */
  currentStatus: OrderItemStatus | null;
  nameSnapshot: string | null;
  quantity: number | null;
}

export interface KitchenBatchSummary {
  total: number;
  applied: number;
  alreadyApplied: number;
  conflict: number;
  ineligible: number;
  missing: number;
}

export interface KitchenTicketBatchResult {
  kind: "processed" | "missing_order" | "forbidden";
  orderId: string;
  requestedStatus: KitchenBatchTargetStatus;
  items: KitchenBatchItemResult[];
  summary: KitchenBatchSummary;
  /** Only lines this transaction actually advanced, for post-commit broadcast. */
  appliedItemIds: string[];
}

function emptyBatchResult(
  input: { orderId: string; to: KitchenBatchTargetStatus; itemIds?: string[] },
  kind: "missing_order" | "forbidden",
): KitchenTicketBatchResult {
  const items =
    kind === "missing_order"
      ? (input.itemIds ?? []).map((itemId) => ({
          itemId,
          outcome: "missing" as const,
          currentStatus: null,
          nameSnapshot: null,
          quantity: null,
        }))
      : [];
  return {
    kind,
    orderId: input.orderId,
    requestedStatus: input.to,
    items,
    summary: summarizeBatch(items),
    appliedItemIds: [],
  };
}

function summarizeBatch(items: KitchenBatchItemResult[]): KitchenBatchSummary {
  const summary: KitchenBatchSummary = {
    total: items.length,
    applied: 0,
    alreadyApplied: 0,
    conflict: 0,
    ineligible: 0,
    missing: 0,
  };
  for (const item of items) {
    if (item.outcome === "applied") summary.applied += 1;
    else if (item.outcome === "already_applied") summary.alreadyApplied += 1;
    else if (item.outcome === "conflict") summary.conflict += 1;
    else if (item.outcome === "ineligible") summary.ineligible += 1;
    else summary.missing += 1;
  }
  return summary;
}

/**
 * Ticket-wide kitchen bump: `Start all` (sent → preparing) or `Mark ready`
 * (preparing → ready) under ONE authorization decision and one tenant
 * transaction.
 *
 * Safety properties:
 *  - The parent order and every ticket line are locked `FOR UPDATE` before any
 *    decision, so a concurrent single-line bump, void, payment or another
 *    terminal serializes behind this transaction.
 *  - Only the exact source status is a candidate; every write re-checks that
 *    status (compare-and-set). Retries see the target status and report
 *    `already_applied` instead of advancing twice.
 *  - Served, voided and pending lines are reported as `ineligible` and are
 *    never written, whatever the requested status.
 *  - The caller must hold the same `kitchen.view` capability the single-line
 *    route uses; without it the whole batch is authorized as forbidden before
 *    any row is read.
 *
 * `itemIds` is the optional operator selection (a station/line subset). When
 * omitted the whole ticket is in scope. Requested IDs that are not on this
 * order/location are reported `missing` without revealing another ticket.
 */
export async function transitionKitchenTicketBatch(input: {
  businessId: string;
  locationId: string;
  orderId: string;
  to: KitchenBatchTargetStatus;
  itemIds?: string[];
  mayBumpKitchen: boolean;
  actorUserId: string;
  syncActor?: OrderStateActor;
}): Promise<KitchenTicketBatchResult> {
  if (!input.mayBumpKitchen) {
    return emptyBatchResult(input, "forbidden");
  }

  return withTenantTransaction(
    input.businessId,
    async (client) => {
      const { rows: orders } = await query<{ id: string }>(
        `SELECT o.id
           FROM orders o
          WHERE o.id = $1 AND o.location_id = $2
            AND o.status IN ('open','held','completed')
            AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
          FOR UPDATE`,
        [input.orderId, input.locationId],
      );
      if (!orders[0]) return emptyBatchResult(input, "missing_order");

      // Lock every line of the ticket in a deterministic order. This is the
      // same parent→line lock order the single-line transition uses, so the
      // two paths cannot deadlock each other.
      const { rows: lines } = await query<{
        id: string;
        status: OrderItemStatus;
        name_snapshot: string;
        quantity: number;
      }>(
        `SELECT oi.id, oi.status, oi.name_snapshot, oi.quantity
           FROM order_items oi
          WHERE oi.order_id = $1 AND oi.location_id = $2
          ORDER BY oi.id
          FOR UPDATE`,
        [input.orderId, input.locationId],
      );

      const requestedIds = input.itemIds ? new Set(input.itemIds) : null;
      const lineById = new Map(lines.map((line) => [line.id, line]));
      const results: KitchenBatchItemResult[] = [];
      const candidates: string[] = [];
      const expected = input.to === "preparing" ? "sent" : "preparing";

      for (const line of lines) {
        if (requestedIds && !requestedIds.has(line.id)) continue;
        const base = {
          itemId: line.id,
          nameSnapshot: line.name_snapshot,
          quantity: line.quantity,
          currentStatus: line.status,
        };
        if (line.status === input.to) {
          results.push({ ...base, outcome: "already_applied" });
        } else if (line.status === expected && canKitchenBump(line.status, input.to)) {
          // The write below is still compare-and-set against `expected`; this
          // list is only the intent, not a substitute for the database check.
          results.push({ ...base, outcome: "applied" });
          candidates.push(line.id);
        } else if (
          line.status === "served" ||
          line.status === "voided" ||
          line.status === "pending"
        ) {
          results.push({ ...base, outcome: "ineligible" });
        } else {
          results.push({ ...base, outcome: "conflict" });
        }
      }

      if (requestedIds) {
        for (const itemId of requestedIds) {
          if (!lineById.has(itemId)) {
            results.push({
              itemId,
              outcome: "missing",
              currentStatus: null,
              nameSnapshot: null,
              quantity: null,
            });
          }
        }
      }

      let appliedItemIds: string[] = [];
      if (candidates.length > 0) {
        const { rows: changed } = await query<{ id: string }>(
          `UPDATE order_items oi
              SET status=$3::order_item_status,
                  ready_at=CASE WHEN $3::order_item_status='ready'::order_item_status
                                THEN now() ELSE ready_at END
            WHERE oi.order_id=$1 AND oi.location_id=$2
              AND oi.id = ANY($4::uuid[])
              AND oi.status=$5
              AND EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.id=oi.order_id AND o.location_id=$2
                   AND o.status IN ('open','held','completed')
                   AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
              )
            RETURNING oi.id`,
          [input.orderId, input.locationId, input.to, candidates, expected],
        );
        appliedItemIds = changed.map((row) => row.id);
        const appliedSet = new Set(appliedItemIds);
        for (const item of results) {
          if (item.outcome === "applied" && appliedSet.has(item.itemId)) {
            item.currentStatus = input.to;
          }
        }
        const missed = candidates.filter((itemId) => !appliedSet.has(itemId));
        if (missed.length > 0) {
          // Defensive: the row was locked, so this should be unreachable. If a
          // database-level trigger or a future lock change lets it happen, the
          // caller still receives the canonical current status rather than a
          // false success.
          const { rows: current } = await query<{ id: string; status: OrderItemStatus }>(
            `SELECT id, status FROM order_items
              WHERE order_id=$1 AND location_id=$2 AND id = ANY($3::uuid[])`,
            [input.orderId, input.locationId, missed],
          );
          const statusById = new Map(current.map((row) => [row.id, row.status]));
          for (const item of results) {
            if (item.outcome !== "applied" || appliedSet.has(item.itemId)) continue;
            if (!statusById.has(item.itemId)) {
              item.outcome = "missing";
              item.currentStatus = null;
            } else {
              item.outcome = "conflict";
              item.currentStatus = statusById.get(item.itemId) ?? null;
            }
          }
        }
      }

      if (appliedItemIds.length > 0) {
        await enqueueCafeKitchenState(client, input.orderId);
        if (input.syncActor) {
          await recordOrderState(client, {
            locationId: input.locationId,
            orderId: input.orderId,
            actor: input.syncActor,
          });
        }
      }

      return {
        kind: "processed" as const,
        orderId: input.orderId,
        requestedStatus: input.to,
        items: results,
        summary: summarizeBatch(results),
        appliedItemIds,
      };
    },
    { locationId: input.locationId, userId: input.actorUserId },
  );
}

/**
 * The canonical CAS used by both online KDS/waiter actions and offline/hybrid
 * replay. The parent order and line are locked in one tenant transaction and
 * the status is compared again at the write boundary.
 */
export async function transitionKitchenItem(input: {
  businessId: string;
  locationId: string;
  itemId: string;
  to: "preparing" | "ready" | "served";
  mayBumpKitchen: boolean;
  mayServe: boolean;
  actorUserId: string;
  /** Online routes persist the full order-state outbox in this same transaction. */
  syncActor?: OrderStateActor;
}): Promise<KitchenItemTransitionResult> {
  return withTenantTransaction(
    input.businessId,
    async (client) => {
      // Lock the parent order FIRST, then the line. The ticket-wide path uses
      // the same order→line order, so a batch and a single bump on the same
      // ticket serialize instead of deadlocking on inverted lock order.
      const { rows: lockedOrders } = await query<{ id: string }>(
        `SELECT o.id
           FROM orders o
          WHERE o.id = (SELECT oi.order_id FROM order_items oi
                         WHERE oi.id=$1 AND oi.location_id=$2)
            AND o.location_id=$2
            AND o.status IN ('open','held','completed')
            AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
          FOR UPDATE`,
        [input.itemId, input.locationId],
      );
      if (!lockedOrders[0]) return { kind: "missing" } as const;

      const { rows } = await query<{
        id: string;
        status: OrderItemStatus;
        order_id: string;
      }>(
        `SELECT oi.id, oi.status, oi.order_id
           FROM order_items oi
          WHERE oi.id=$1 AND oi.location_id=$2
          FOR UPDATE`,
        [input.itemId, input.locationId],
      );
      const item = rows[0];
      if (!item) return { kind: "missing" } as const;
      if (item.status === input.to) {
        return { kind: "duplicate", currentStatus: item.status } as const;
      }

      if (
        !(input.mayBumpKitchen && canKitchenBump(item.status, input.to)) &&
        !(input.mayServe && canMarkServed(item.status, input.to))
      ) {
        return { kind: "conflict", currentStatus: item.status } as const;
      }

      const { rows: changed } = await query<{ id: string }>(
        `UPDATE order_items oi
            SET status=$3::order_item_status,
                ready_at=CASE WHEN $3::order_item_status='ready'::order_item_status
                              THEN now() ELSE ready_at END
          WHERE oi.id=$1 AND oi.location_id=$2 AND oi.status=$4
            AND EXISTS (SELECT 1 FROM orders o WHERE o.id=oi.order_id AND o.location_id=$2
                         AND o.status IN ('open','held','completed')
                         AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted'))
          RETURNING oi.id`,
        [input.itemId, input.locationId, input.to, item.status],
      );
      if (!changed.length) {
        const { rows: current } = await query<{ status: OrderItemStatus }>(
          "SELECT status FROM order_items WHERE id=$1 AND location_id=$2",
          [input.itemId, input.locationId],
        );
        return current[0]
          ? ({ kind: "conflict", currentStatus: current[0].status } as const)
          : ({ kind: "missing" } as const);
      }
      await enqueueCafeKitchenState(client, item.order_id);
      if (input.syncActor) {
        await recordOrderState(client, {
          locationId: input.locationId,
          orderId: item.order_id,
          actor: input.syncActor,
        });
      }
      return { kind: "updated", orderId: item.order_id } as const;
    },
    { locationId: input.locationId, userId: input.actorUserId },
  );
}
