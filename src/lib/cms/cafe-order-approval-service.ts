/**
 * ESH-146 (biza-miz#1304) & ESH-148 (biza-miz#1306) — staff approval of a
 * website café order.
 *
 * Approval is deliberately a separate axis from `orders.status` and from
 * payment: a paid order can still be rejected (and then follows the ordinary
 * refund flow), and a pay-at-counter order is accepted while remaining unpaid.
 *
 *   pending ──accept──▶ accepted   items promoted pending→sent, kitchen dispatch
 *                                  enqueued once, state queued in CMS outbox
 *      └─────reject──▶ rejected    never dispatched, reason recorded,
 *                                  state queued in CMS outbox
 */
import type { PoolClient } from "pg";
import { getPool, query } from "../db";
import { enqueueKitchenDispatch } from "../kitchen-dispatch";
import { recordOrderAudit } from "../order-control-service";
import { recordOrderState } from "../order-state-sync";
import type { Role } from "../auth-edge";
import { enqueueOrderStateInTx } from "./order-state-outbox-service";

export type CafeApprovalDecision = "accepted" | "rejected";

export interface CafeApprovalInput {
  businessId: string;
  locationId: string;
  orderId: string;
  decision: CafeApprovalDecision;
  actor: { userId: string | null; role: Role };
  reason?: string | null;
}

export type CafeApprovalResult =
  | {
      ok: true;
      /** False when the same decision had already been recorded. */
      changed: boolean;
      state: CafeApprovalDecision;
      dispatchedItemIds: string[];
    }
  | { ok: false; error: string; status: number };

interface LockedOrder {
  id: string;
  status: string;
  origin: string;
  cms_connection_id: string | null;
  cms_order_id: string | null;
  website_approval_state: CafeApprovalDecision | "pending" | null;
  website_approval_reason: string | null;
}

/**
 * Accept or reject one website order.
 *
 * The caller has already resolved the branch and checked the permission for
 * this decision (accept: `orders.create`, reject: `orders.void`).
 */
export async function decideCafeOrderApproval(
  input: CafeApprovalInput,
): Promise<CafeApprovalResult> {
  const reason = cleanReason(input.reason);
  if (input.decision === "rejected" && !reason) {
    return { ok: false, error: "reason_required", status: 400 };
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await lockOrder(client, input.locationId, input.orderId);
    if (!locked) {
      await client.query("ROLLBACK");
      return { ok: false, error: "order_not_found", status: 404 };
    }
    if (locked.origin !== "website" || !locked.cms_connection_id || !locked.cms_order_id) {
      await client.query("ROLLBACK");
      return { ok: false, error: "not_website_order", status: 409 };
    }

    // Same decision twice is a retry (a lost response, a double tap), not a
    // conflict: report what already happened and dispatch nothing new.
    if (locked.website_approval_state === input.decision) {
      await client.query("ROLLBACK");
      return { ok: true, changed: false, state: input.decision, dispatchedItemIds: [] };
    }
    if (locked.website_approval_state !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false, error: "already_decided", status: 409 };
    }
    if (locked.status === "voided") {
      await client.query("ROLLBACK");
      return { ok: false, error: "order_voided", status: 409 };
    }

    await client.query(
      `UPDATE orders
          SET website_approval_state = $2,
              website_approval_decided_at = now(),
              website_approval_decided_by = $3,
              website_approval_reason = $4
        WHERE id = $1`,
      [input.orderId, input.decision, input.actor.userId, reason],
    );

    const dispatchedItemIds =
      input.decision === "accepted"
        ? await releaseOrderLinesToKitchen(client, input, locked)
        : [];

    // Record the state transition in `cms_order_state_outbox` inside the same
    // transaction; the leased ESH-148 worker delivers it to `eshobe-cms`.
    await enqueueOrderStateInTx(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      cmsConnectionId: locked.cms_connection_id,
      cmsOrderId: locked.cms_order_id,
      posOrderId: input.orderId,
      state: input.decision,
      reason,
    });

    await recordOrderAudit(client, {
      actor: { businessId: input.businessId, userId: input.actor.userId, role: input.actor.role },
      locationId: input.locationId,
      action: input.decision === "accepted" ? "order.website_accepted" : "order.website_rejected",
      entityType: "order",
      entityId: input.orderId,
      reason,
      metadata: {
        cmsOrderId: locked.cms_order_id,
        dispatchedItemIds,
      },
    });

    // Propagate the approval + promoted kitchen items (`sent`) to any paired
    // Hybrid desktop in the same transaction.
    await recordOrderState(client, {
      locationId: input.locationId,
      orderId: input.orderId,
      actor: { userId: input.actor.userId, role: input.actor.role },
    });

    await client.query("COMMIT");
    return { ok: true, changed: true, state: input.decision, dispatchedItemIds };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function lockOrder(
  client: PoolClient,
  locationId: string,
  orderId: string,
): Promise<LockedOrder | null> {
  const { rows } = await client.query<LockedOrder>(
    `SELECT id, status, origin, cms_connection_id, cms_order_id,
            website_approval_state, website_approval_reason
       FROM orders
      WHERE id = $1 AND location_id = $2
      FOR UPDATE`,
    [orderId, locationId],
  );
  return rows[0] ?? null;
}

/**
 * Promote held `'pending'` lines to `'sent'` with `sent_to_kitchen_at` and
 * enqueue kitchen dispatch once for the exact line set.
 */
async function releaseOrderLinesToKitchen(
  client: PoolClient,
  input: CafeApprovalInput,
  order: LockedOrder,
): Promise<string[]> {
  await client.query(
    `UPDATE order_items
        SET status = 'sent',
            sent_to_kitchen_at = COALESCE(sent_to_kitchen_at, now())
      WHERE order_id = $1 AND status = 'pending'`,
    [order.id],
  );

  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM order_items WHERE order_id = $1 AND status <> 'voided' ORDER BY created_at, id`,
    [order.id],
  );
  const itemIds = rows.map((row) => row.id);
  if (itemIds.length === 0) return [];
  await enqueueKitchenDispatch(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    orderId: order.id,
    itemIds,
  });
  return itemIds;
}

function cleanReason(raw: string | null | undefined): string | null {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (!reason) return null;
  return reason.slice(0, 300);
}

export interface AwaitingApprovalOrder {
  [key: string]: unknown;
  id: string;
  orderNumber: string;
  type: string;
  tableName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  total: string;
  note: string | null;
  openedAt: string;
  cmsOrderId: string | null;
  itemCount: number;
  /** True once a payment exists — rejecting such an order needs a refund. */
  hasPayment: boolean;
}

/**
 * The «در انتظار تأیید» queue: website orders of this branch that staff have
 * neither accepted nor rejected yet (and have not been voided). Oldest first.
 */
export async function listOrdersAwaitingApproval(
  locationId: string,
): Promise<AwaitingApprovalOrder[]> {
  return query<AwaitingApprovalOrder>(
    `SELECT o.id,
            o.order_number::text AS "orderNumber",
            o.type,
            dt.name AS "tableName",
            c.name AS "customerName",
            c.phone AS "customerPhone",
            o.total::text AS total,
            o.note,
            o.opened_at AS "openedAt",
            o.cms_order_id AS "cmsOrderId",
            (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id AND oi.status <> 'voided') AS "itemCount",
            EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.amount > 0) AS "hasPayment"
       FROM orders o
       LEFT JOIN dining_tables dt ON dt.id = o.table_id
       LEFT JOIN parties c ON c.id = o.customer_id
      WHERE o.location_id = $1
        AND o.website_approval_state = 'pending'
        AND o.status <> 'voided'
      ORDER BY o.opened_at, o.id`,
    [locationId],
  ).then((result) => result.rows);
}
