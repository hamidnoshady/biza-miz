/**
 * Phase G — CMS store `order.paid` → inbox row → one accounting import.
 * Mirrors WooCommerce webhook ingest for paid delivery sales; stock/COGS waits
 * on product mapping.
 */
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool, query, withoutTenantScope, withTenant } from "../db";
import { WELL_KNOWN_CODES } from "../coa-template";
import { accountIdsByCode, postExactJournalEntry } from "../ledger-service";
import { getPrimaryLocation } from "../setup-state";
import { reconcileExternalIdentity } from "../crm-external-identity";
import type { RialText } from "../inventory-exact";
import type { WebsiteConnectionRow } from "../website/connection-service";
import { cmsMinorToRial } from "./order-money";
import type { CmsOrder } from "./types";

const zero = "0" as RialText;

export interface CmsOrderEventNotice {
  siteId: string;
  deliveryId: string;
  event: string;
  order: CmsOrder;
}

const CONNECTION_COLUMNS = `id, business_id, adapter_key, site_id, site_domain, base_url, key_name, api_key_ciphertext,
  site_currency, status, last_checked_at, last_error, push_prices, push_stock, product_scope,
  sync_location_id, created_at, updated_at`;

export async function resolveCmsConnectionBySiteId(siteId: string): Promise<WebsiteConnectionRow | null> {
  return withoutTenantScope("cms-order-webhook-site-map", async () => {
    const { rows } = await query<WebsiteConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM eshobe_cms_connections WHERE site_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [siteId],
    );
    return rows[0] ?? null;
  });
}

export async function handleCmsStoreOrderWebhook(notice: CmsOrderEventNotice): Promise<NextResponse> {
  const connection = await resolveCmsConnectionBySiteId(notice.siteId);
  if (!connection) {
    return NextResponse.json({ error: "site_not_connected" }, { status: 404 });
  }

  return withTenant(connection.business_id, async () => {
    const claimed = await claimInboxRow(connection, notice);
    if (claimed.kind === "duplicate") {
      return NextResponse.json({ status: "duplicate" });
    }
    if (claimed.kind === "replay") {
      return NextResponse.json({ status: "processed" });
    }

    try {
      if (notice.event !== "order.paid" || notice.order.status !== "paid") {
        await markInboxFailed(claimed.inboxId, "not_paid");
        return NextResponse.json({ error: "not_paid" }, { status: 422 });
      }
      const orderId = await importPaidCmsOrder(connection, notice.order);
      await markInboxProcessed(claimed.inboxId, orderId);
      return NextResponse.json({ status: "processed", orderId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "import_failed";
      await markInboxFailed(claimed.inboxId, message);
      return NextResponse.json({ error: message }, { status: 422 });
    }
  });
}

type ClaimResult =
  | { kind: "new"; inboxId: string }
  | { kind: "duplicate" }
  | { kind: "replay" };

async function claimInboxRow(connection: WebsiteConnectionRow, notice: CmsOrderEventNotice): Promise<ClaimResult> {
  const { rows: imported } = await query<{ id: string }>(
    `SELECT id FROM cms_store_order_inbox
      WHERE cms_connection_id = $1 AND cms_order_id = $2 AND status = 'processed'
      LIMIT 1`,
    [connection.id, notice.order.id],
  );
  if (imported[0]) return { kind: "replay" };

  const { rows } = await query<{ id: string }>(
    `INSERT INTO cms_store_order_inbox
       (business_id, cms_connection_id, event_topic, cms_order_id, delivery_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (cms_connection_id, delivery_id) DO NOTHING
     RETURNING id`,
    [
      connection.business_id,
      connection.id,
      notice.event,
      notice.order.id,
      notice.deliveryId,
      JSON.stringify({ order: notice.order }),
    ],
  );
  if (rows[0]) return { kind: "new", inboxId: rows[0].id };

  const { rows: existing } = await query<{ status: string }>(
    `SELECT status FROM cms_store_order_inbox
      WHERE cms_connection_id = $1 AND delivery_id = $2`,
    [connection.id, notice.deliveryId],
  );
  if (existing[0]?.status === "processed") return { kind: "replay" };
  return { kind: "duplicate" };
}

async function markInboxProcessed(inboxId: string, importedOrderId: string): Promise<void> {
  await query(
    `UPDATE cms_store_order_inbox
        SET status = 'processed', imported_order_id = $2, processed_at = now(), error = NULL
      WHERE id = $1`,
    [inboxId, importedOrderId],
  );
}

async function markInboxFailed(inboxId: string, error: string): Promise<void> {
  await query(
    `UPDATE cms_store_order_inbox SET status = 'failed', error = $2, processed_at = now() WHERE id = $1`,
    [inboxId, error.slice(0, 500)],
  );
}

async function importPaidCmsOrder(connection: WebsiteConnectionRow, order: CmsOrder): Promise<string> {
  const businessId = connection.business_id;
  const remoteId = order.id;
  const total = cmsMinorToRial(order.total, order.currency);
  const unit = cmsMinorToRial(order.unitPrice, order.currency);
  const tax = 0n;
  const net = total - tax;

  const locationId = connection.sync_location_id ?? (await getPrimaryLocation(businessId))?.id;
  if (!locationId) throw new Error("no_location");

  const buyer = order.buyer;
  const reconcile = await reconcileExternalIdentity(
    {
      businessId,
      connectionId: connection.id,
      provider: "eshobe_cms",
      remoteId: buyer.phone?.trim() || remoteId,
      name: buyer.name,
      email: buyer.email ?? null,
      phone: buyer.phone,
      payload: { orderId: remoteId, reference: order.reference },
    },
    { allowCreate: false },
  );
  const customerId = reconcile.partyId;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cms-order:${connection.id}:${remoteId}`]);

    const { rows: prior } = await client.query<{ imported_order_id: string | null }>(
      `SELECT imported_order_id FROM cms_store_order_inbox
        WHERE cms_connection_id = $1 AND cms_order_id = $2 AND status = 'processed' AND imported_order_id IS NOT NULL
        LIMIT 1`,
      [connection.id, remoteId],
    );
    if (prior[0]?.imported_order_id) {
      await client.query("ROLLBACK");
      return prior[0].imported_order_id;
    }

    const { rows: counter } = await client.query<{ next_number: string }>(
      `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
       ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
       RETURNING next_number - 1 AS next_number`,
      [locationId],
    );
    const orderNumber = Number(counter[0].next_number);
    const note = buyer.note ? `${buyer.name} — ${buyer.note}` : `مشتری: ${buyer.name}`;

    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, service_charge, tax, total, note, customer_id)
       VALUES ($1, $2, 'delivery', 'open', $3, 0, 0, $4, $5, $6, $7)
       RETURNING id`,
      [locationId, orderNumber, net.toString(), tax.toString(), total.toString(), note, customerId],
    );
    const orderId = orderRows[0].id;

    const title =
      typeof order.product === "object" && order.product && "title" in order.product
        ? String(order.product.title)
        : order.productTitle ?? "محصول فروشگاه";

    await client.query(
      `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
       VALUES ($1, $2, NULL, $3, $4, $5, 'served')`,
      [locationId, orderId, title, unit.toString(), Math.max(1, order.quantity)],
    );

    if (total > 0n) {
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference)
         VALUES ($1, $2, 'online', $3, $4)`,
        [locationId, orderId, total.toString(), order.reference],
      );
    }

    const { rowCount: closed } = await client.query(
      `UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1 AND status = 'open' RETURNING id`,
      [orderId],
    );
    if (closed !== 1) throw new Error("order_close_failed");

    await postRevenueEntry(client, businessId, locationId, orderId, order.reference, total, net, tax);

    await client.query("COMMIT");
    return orderId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function postRevenueEntry(
  client: PoolClient,
  businessId: string,
  locationId: string,
  orderId: string,
  reference: string,
  total: bigint,
  net: bigint,
  tax: bigint,
): Promise<void> {
  const accounts = await accountIdsByCode(client, businessId, [
    WELL_KNOWN_CODES.bankClearing,
    WELL_KNOWN_CODES.deliveryRevenue,
    ...(tax > 0n ? [WELL_KNOWN_CODES.vatPayable] : []),
  ]);
  await postExactJournalEntry(client, {
    businessId,
    locationId,
    memo: `فروش فروشگاه سایت #${reference}`,
    sourceType: "cms_store_order",
    sourceId: orderId,
    createdBy: null,
    postingKind: "revenue",
    inventoryEventId: null,
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.bankClearing)!, debit: total.toString() as RialText, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.deliveryRevenue)!, debit: zero, credit: net.toString() as RialText },
      ...(tax > 0n
        ? [{ accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: tax.toString() as RialText }]
        : []),
    ],
  });
}
