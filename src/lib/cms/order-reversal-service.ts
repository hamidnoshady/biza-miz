/**
 * Phase G2 — CMS store `order.refunded` / `order.cancelled` → closed-order void amendment.
 * Only runs after the paid import row has `imported_order_id`.
 *
 * Retail (issue #770): a CMS order imported for a non-F&B business is a
 * *retail* order whose revenue/COGS were posted by the import adapter under
 * `source_type = 'cms_store_order'`. Reversing it through `amendClosedOrder`
 * — the F&B closed-order engine (recipe consumption, menu-item modifiers,
 * online-platform commission) — was wrong by construction. Retail orders now
 * go through `reverseRetailImportedOrder`, which reverses the entries the
 * channel actually posted and restores the exact batches each line consumed.
 * F&B orders keep the amendment engine unchanged.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "../db";
import { amendClosedOrder } from "../order-amendment-service";
import { getBusinessIndustry } from "../industry-guard";
import { isRetailCatalogueIndustry } from "../industries";
import { reverseRetailImportedOrder } from "../retail-order-reversal-service";
import { validateAmendment } from "../order-amendments";
import { broadcast } from "../realtime";
import { releaseSessionIfIdle } from "../table-session-service";
import type { WebsiteConnectionRow } from "../website/connection-service";
import type { CmsOrderEventNotice } from "./order-ingest-service";
import type { CmsOrder } from "./types";

export const CMS_REVERSAL_EVENTS = ["order.refunded", "order.cancelled"] as const;
export type CmsReversalEvent = (typeof CMS_REVERSAL_EVENTS)[number];

export function isCmsReversalEvent(event: string): event is CmsReversalEvent {
  return (CMS_REVERSAL_EVENTS as readonly string[]).includes(event);
}

export function cmsReversalStatusMatches(event: CmsReversalEvent, order: CmsOrder): boolean {
  if (event === "order.refunded") return order.status === "refunded";
  return order.status === "cancelled";
}

function reversalReason(event: CmsReversalEvent, order: CmsOrder): string {
  const ref = order.reference?.trim() || order.id;
  if (event === "order.refunded") return `بازپرداخت سفارش فروشگاه سایت #${ref}`;
  return `لغو سفارش فروشگاه سایت #${ref}`;
}

interface PaidImportRow extends Record<string, unknown> {
  id: string;
  imported_order_id: string;
  reversal_amendment_id: string | null;
}

async function loadPaidImportRow(
  cmsConnectionId: string,
  cmsOrderId: string,
): Promise<PaidImportRow | null> {
  const { rows } = await query<PaidImportRow>(
    `SELECT id, imported_order_id, reversal_amendment_id
       FROM cms_store_order_inbox
      WHERE cms_connection_id = $1 AND cms_order_id = $2
        AND event_topic = 'order.paid' AND status = 'processed' AND imported_order_id IS NOT NULL
      LIMIT 1`,
    [cmsConnectionId, cmsOrderId],
  );
  return rows[0] ?? null;
}

export async function reverseImportedCmsStoreOrder(
  connection: WebsiteConnectionRow,
  notice: CmsOrderEventNotice,
  reversalInboxId: string,
): Promise<{ amendmentId: string; orderId: string; alreadyReversed: boolean }> {
  if (!isCmsReversalEvent(notice.event)) throw new Error("unsupported_event");

  const paid = await loadPaidImportRow(connection.id, notice.order.id);
  if (!paid) throw new Error("not_imported");

  if (paid.reversal_amendment_id) {
    await query(
      `UPDATE cms_store_order_inbox
          SET status = 'processed', processed_at = now(), error = NULL
        WHERE id = $1`,
      [reversalInboxId],
    );
    return {
      orderId: paid.imported_order_id,
      amendmentId: paid.reversal_amendment_id,
      alreadyReversed: true,
    };
  }

  const { rows: orderRows } = await query<{ location_id: string; type: string }>(
    `SELECT location_id, type::text AS type FROM orders WHERE id = $1`,
    [paid.imported_order_id],
  );
  const locationId = orderRows[0]?.location_id;
  if (!locationId) throw new Error("imported_order_missing");
  const orderType = orderRows[0]?.type ?? "order";
  const industry = await getBusinessIndustry(connection.business_id);
  // A retail order is recognised by its type, and — for orders imported
  // before this was set correctly — by its shape: lines pointing at `items`
  // (the retail catalogue) and none at `menu_items` (F&B recipes).
  const { rows: lineKinds } = await query<{ item_lines: string; menu_lines: string }>(
    `SELECT count(*) FILTER (WHERE item_id IS NOT NULL)::text AS item_lines,
            count(*) FILTER (WHERE menu_item_id IS NOT NULL)::text AS menu_lines
       FROM order_items WHERE order_id = $1`,
    [paid.imported_order_id],
  );
  const retailShaped = Number(lineKinds[0]?.item_lines ?? 0) > 0 && Number(lineKinds[0]?.menu_lines ?? 0) === 0;
  // Issue #799 Wave 11 — the family question, not "not F&B": a trade with no
  // sellable catalogue has no retail order to reverse (its orders are refused
  // at ingest), so this stays a retail-shape test rather than a catch-all.
  const isRetail =
    isRetailCatalogueIndustry(industry) && (orderType === "retail" || retailShaped);

  const reason = reversalReason(notice.event, notice.order);
  const validated = validateAmendment({
    kind: "void",
    reason,
    paymentMethod: "online",
  });
  if (!validated.ok) throw new Error(validated.error);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `cms-order-reversal:${connection.id}:${notice.order.id}`,
    ]);

    const fresh = await loadPaidImportRowForUpdate(client, connection.id, notice.order.id);
    if (!fresh) {
      await client.query("ROLLBACK");
      throw new Error("not_imported");
    }
    if (fresh.reversal_amendment_id) {
      await client.query(
        `UPDATE cms_store_order_inbox
            SET status = 'processed', processed_at = now(), error = NULL
          WHERE id = $1`,
        [reversalInboxId],
      );
      await client.query("COMMIT");
      return {
        orderId: fresh.imported_order_id,
        amendmentId: fresh.reversal_amendment_id,
        alreadyReversed: true,
      };
    }

    const result = isRetail
      ? await reverseRetailImportedOrder(client, {
          businessId: connection.business_id,
          locationId,
          orderId: fresh.imported_order_id,
          actorId: null,
          reason,
          sourceTypes: ["cms_store_order"],
          restorationSourceType: "cms_store_order_reversal",
          // One reversal per CMS order: the batch engine's restoration index
          // makes a replayed webhook restore nothing twice.
          restorationSourceId: `cms-order-reversal:${connection.id}:${notice.order.id}`,
        })
      : await amendClosedOrder(client, {
          businessId: connection.business_id,
          locationId,
          orderId: fresh.imported_order_id,
          actorId: null,
          input: validated.value,
          skipCmsOrderStateSync: true,
        });

    // The retail reversal returns `amendmentId`; the F&B amendment engine
    // returns `id`. They are the same `order_amendments` row either way.
    const amendmentId = "amendmentId" in result ? result.amendmentId : result.id;
    await client.query(
      `UPDATE cms_store_order_inbox
          SET reversal_amendment_id = $2, processed_at = now()
        WHERE id = $1`,
      [fresh.id, amendmentId],
    );
    await client.query(
      `UPDATE cms_store_order_inbox
          SET status = 'processed', processed_at = now(), error = NULL
        WHERE id = $1`,
      [reversalInboxId],
    );

    await client.query("COMMIT");
    return { orderId: fresh.imported_order_id, amendmentId, alreadyReversed: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function loadPaidImportRowForUpdate(
  client: PoolClient,
  cmsConnectionId: string,
  cmsOrderId: string,
): Promise<PaidImportRow | null> {
  const { rows } = await client.query<PaidImportRow>(
    `SELECT id, imported_order_id, reversal_amendment_id
       FROM cms_store_order_inbox
      WHERE cms_connection_id = $1 AND cms_order_id = $2
        AND event_topic = 'order.paid' AND status = 'processed' AND imported_order_id IS NOT NULL
      LIMIT 1
      FOR UPDATE`,
    [cmsConnectionId, cmsOrderId],
  );
  return rows[0] ?? null;
}

/**
 * ESH-148 — handle `order.cancelled` / `order.refunded` for a website café
 * order. Suppresses echoes caused when POS's own void/refund state patch back
 * to `eshobe-cms` triggers `emitOrderReversal`, and safely reverses open or
 * settled café orders when the reversal genuinely originated on the CMS.
 */
export async function handleCmsCafeOrderReversal(
  connection: WebsiteConnectionRow,
  notice: CmsOrderEventNotice,
  reversalInboxId: string,
): Promise<{ amendmentId: string | null; orderId: string; alreadyReversed: boolean }> {
  if (!isCmsReversalEvent(notice.event)) throw new Error("unsupported_event");

  const reason = reversalReason(notice.event, notice.order);
  const client = await getPool().connect();
  let broadcastLocationId: string | null = null;
  let broadcastOrderId: string | null = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `cms-order-reversal:${connection.id}:${notice.order.id}`,
    ]);

    const { rows: posRows } = await client.query<{
      id: string;
      location_id: string;
      status: string;
      total: string;
      table_session_id: string | null;
    }>(
      `SELECT id, location_id, status::text AS status, total::text AS total, table_session_id
         FROM orders
        WHERE cms_connection_id = $1 AND cms_order_id = $2
        LIMIT 1
        FOR UPDATE`,
      [connection.id, notice.order.id],
    );
    const posOrder = posRows[0];
    if (!posOrder) {
      await client.query("ROLLBACK");
      throw new Error("not_imported");
    }

    // Echo suppression: POS already voided the order, fully refunded it via
    // customer_returns, or already recorded a terminal payment reversal in its
    // outbound outbox.
    const { rows: outboxEchoRows } = await client.query<{ id: string }>(
      `SELECT id
         FROM cms_order_state_outbox
        WHERE cms_connection_id = $1
          AND cms_order_id = $2
          AND axis = 'payment'
          AND state IN ('cancelled', 'refunded')
          AND status <> 'superseded'
        LIMIT 1`,
      [connection.id, notice.order.id],
    );

    const { rows: returnRows } = await client.query<{ refunded: string }>(
      `SELECT COALESCE(sum(refund_amount_rial), 0)::text AS refunded
         FROM customer_returns
        WHERE business_id = $1 AND order_id = $2`,
      [connection.business_id, posOrder.id],
    );
    const alreadyFullyRefunded =
      notice.event === "order.refunded" &&
      BigInt(posOrder.total) > 0n &&
      BigInt(returnRows[0]?.refunded ?? "0") >= BigInt(posOrder.total);

    if (outboxEchoRows[0] || posOrder.status === "voided" || alreadyFullyRefunded) {
      await client.query(
        `UPDATE cms_store_order_inbox
            SET status = 'processed', imported_order_id = COALESCE(imported_order_id, $2),
                processed_at = now(), error = NULL
          WHERE id = $1`,
        [reversalInboxId, posOrder.id],
      );
      await client.query("COMMIT");
      return { orderId: posOrder.id, amendmentId: null, alreadyReversed: true };
    }

    if (posOrder.status === "open" || posOrder.status === "held") {
      await client.query(
        `UPDATE orders
            SET status = 'voided',
                voided_reason = $2,
                closed_at = now()
          WHERE id = $1`,
        [posOrder.id, reason],
      );
      await client.query(
        `UPDATE cms_order_state_outbox
            SET status = 'superseded',
                last_error = 'superseded_by_cms_reversal',
                lease_token = NULL,
                leased_until = NULL,
                updated_at = now()
          WHERE cms_connection_id = $1
            AND cms_order_id = $2
            AND status IN ('pending', 'failed', 'dead')`,
        [connection.id, notice.order.id],
      );
      if (posOrder.table_session_id) {
        await releaseSessionIfIdle(client, posOrder.location_id, posOrder.table_session_id, null);
      }
      await client.query(
        `UPDATE cms_store_order_inbox
            SET status = 'processed', imported_order_id = $2, processed_at = now(), error = NULL
          WHERE id = $1`,
        [reversalInboxId, posOrder.id],
      );
      await client.query("COMMIT");
      broadcast(posOrder.location_id, { type: "order.updated", orderId: posOrder.id });
      return { orderId: posOrder.id, amendmentId: null, alreadyReversed: false };
    }

    const validated = validateAmendment({
      kind: "void",
      reason,
      paymentMethod: "online",
    });
    if (!validated.ok) {
      await client.query("ROLLBACK");
      throw new Error(validated.error);
    }

    const paid = await loadPaidImportRowForUpdate(client, connection.id, notice.order.id);
    if (paid?.reversal_amendment_id) {
      await client.query(
        `UPDATE cms_store_order_inbox
            SET status = 'processed', imported_order_id = $2, processed_at = now(), error = NULL
          WHERE id = $1`,
        [reversalInboxId, posOrder.id],
      );
      await client.query("COMMIT");
      return {
        orderId: posOrder.id,
        amendmentId: paid.reversal_amendment_id,
        alreadyReversed: true,
      };
    }

    const result = await amendClosedOrder(client, {
      businessId: connection.business_id,
      locationId: posOrder.location_id,
      orderId: posOrder.id,
      actorId: null,
      input: validated.value,
      skipCmsOrderStateSync: true,
    });
    if (paid) {
      await client.query(
        `UPDATE cms_store_order_inbox
            SET reversal_amendment_id = $2, processed_at = now()
          WHERE id = $1`,
        [paid.id, result.id],
      );
    }
    await client.query(
      `UPDATE cms_store_order_inbox
          SET status = 'processed', imported_order_id = $2, processed_at = now(), error = NULL
        WHERE id = $1`,
      [reversalInboxId, posOrder.id],
    );
    broadcastLocationId = posOrder.location_id;
    broadcastOrderId = posOrder.id;
    await client.query("COMMIT");
    if (broadcastLocationId && broadcastOrderId) {
      broadcast(broadcastLocationId, { type: "order.updated", orderId: broadcastOrderId });
    }
    return { orderId: posOrder.id, amendmentId: result.id, alreadyReversed: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
