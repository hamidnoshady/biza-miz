/**
 * Phase G — CMS store `order.paid` → inbox row → one accounting import.
 * Mirrors WooCommerce webhook ingest for paid delivery sales; stock/COGS waits
 * on product mapping.
 */
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool, query, withoutTenantScope, withTenant } from "../db";
import { WELL_KNOWN_CODES } from "../coa-template";
import { accountIdsByCode, postExactCogsEntry, postExactJournalEntry } from "../ledger-service";
import { deductForOrder } from "../inventory-service";
import { getPrimaryLocation } from "../setup-state";
import { reconcileExternalIdentity } from "../crm-external-identity";
import { getBusinessIndustry } from "../industry-guard";
import type { Industry } from "../industries";
import type { RialText } from "../inventory-exact";
import type { WebsiteConnectionRow } from "../website/connection-service";
import { cmsMinorToRial } from "./order-money";
import {
  cmsReversalStatusMatches,
  isCmsReversalEvent,
  reverseImportedCmsStoreOrder,
} from "./order-reversal-service";
import type { CmsOrder } from "./types";

const zero = "0" as RialText;

const RETAIL_ACCOUNT_CODES: Record<Exclude<Industry, "food_service">, { revenue: string; cogs: string; inventory: string }> = {
  jewelry: {
    revenue: WELL_KNOWN_CODES.goldSalesRevenue,
    cogs: WELL_KNOWN_CODES.goldCogs,
    inventory: WELL_KNOWN_CODES.goldInventory,
  },
  watch: {
    revenue: WELL_KNOWN_CODES.watchSalesRevenue,
    cogs: WELL_KNOWN_CODES.watchCogs,
    inventory: WELL_KNOWN_CODES.watchInventory,
  },
  accessories: {
    revenue: WELL_KNOWN_CODES.accessorySalesRevenue,
    cogs: WELL_KNOWN_CODES.accessoryCogs,
    inventory: WELL_KNOWN_CODES.accessoryInventory,
  },
  cosmetics: {
    revenue: WELL_KNOWN_CODES.cosmeticSalesRevenue,
    cogs: WELL_KNOWN_CODES.cosmeticCogs,
    inventory: WELL_KNOWN_CODES.cosmeticInventory,
  },
  wholesale: {
    revenue: WELL_KNOWN_CODES.wholesaleSalesRevenue,
    cogs: WELL_KNOWN_CODES.wholesaleCogs,
    inventory: WELL_KNOWN_CODES.wholesaleInventory,
  },
  tools_fittings: {
    revenue: WELL_KNOWN_CODES.toolsSalesRevenue,
    cogs: WELL_KNOWN_CODES.toolsCogs,
    inventory: WELL_KNOWN_CODES.toolsInventory,
  },
  haberdashery: {
    revenue: WELL_KNOWN_CODES.haberdasherySalesRevenue,
    cogs: WELL_KNOWN_CODES.haberdasheryCogs,
    inventory: WELL_KNOWN_CODES.haberdasheryInventory,
  },
};

function cmsProductId(order: CmsOrder): string | null {
  if (typeof order.product === "string") return order.product;
  if (order.product && typeof order.product === "object" && "id" in order.product) {
    return String(order.product.id);
  }
  return null;
}

async function resolveWebsiteProductMap(
  client: PoolClient,
  businessId: string,
  remoteProductId: string | null,
): Promise<{ localKind: "item" | "menu_item"; localId: string } | null> {
  if (!remoteProductId) return null;
  const { rows } = await client.query<{ local_kind: "item" | "menu_item"; local_id: string }>(
    `SELECT local_kind, local_id FROM website_product_map
      WHERE business_id = $1 AND remote_id = $2 AND sync_enabled = true
      LIMIT 1`,
    [businessId, remoteProductId],
  );
  const row = rows[0];
  if (!row) return null;
  return { localKind: row.local_kind, localId: row.local_id };
}

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
      if (notice.event === "order.paid") {
        if (notice.order.status !== "paid") {
          await markInboxFailed(claimed.inboxId, "not_paid");
          return NextResponse.json({ error: "not_paid" }, { status: 422 });
        }
        const orderId = await importPaidCmsOrder(connection, notice.order);
        await markInboxProcessed(claimed.inboxId, orderId);
        return NextResponse.json({ status: "processed", orderId });
      }

      if (isCmsReversalEvent(notice.event)) {
        if (!cmsReversalStatusMatches(notice.event, notice.order)) {
          await markInboxFailed(claimed.inboxId, "status_mismatch");
          return NextResponse.json({ error: "status_mismatch" }, { status: 422 });
        }
        const reversal = await reverseImportedCmsStoreOrder(connection, notice, claimed.inboxId);
        return NextResponse.json({
          status: "processed",
          orderId: reversal.orderId,
          amendmentId: reversal.amendmentId,
          alreadyReversed: reversal.alreadyReversed,
        });
      }

      await markInboxFailed(claimed.inboxId, "unsupported_event");
      return NextResponse.json({ error: "unsupported_event" }, { status: 422 });
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
  if (notice.event === "order.paid") {
    const { rows: imported } = await query<{ id: string }>(
      `SELECT id FROM cms_store_order_inbox
        WHERE cms_connection_id = $1 AND cms_order_id = $2 AND event_topic = 'order.paid' AND status = 'processed'
        LIMIT 1`,
      [connection.id, notice.order.id],
    );
    if (imported[0]) return { kind: "replay" };
  }

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
        WHERE cms_connection_id = $1 AND cms_order_id = $2 AND event_topic = 'order.paid'
          AND status = 'processed' AND imported_order_id IS NOT NULL
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
    const quantity = Math.max(1, order.quantity);
    const mapped = await resolveWebsiteProductMap(client, businessId, cmsProductId(order));
    const industry = await getBusinessIndustry(businessId);

    let inventoryEventId: string | null = null;
    let cogsRial = "0";

    if (mapped?.localKind === "menu_item") {
      await client.query(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'served')`,
        [locationId, orderId, mapped.localId, title, unit.toString(), quantity],
      );
    } else if (mapped?.localKind === "item") {
      await client.query(
        `INSERT INTO order_items (location_id, order_id, item_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'served')`,
        [locationId, orderId, mapped.localId, title, unit.toString(), quantity],
      );
    } else {
      await client.query(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, NULL, $3, $4, $5, 'served')`,
        [locationId, orderId, title, unit.toString(), quantity],
      );
    }

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

    if (mapped?.localKind === "menu_item") {
      const { rows: eventRows } = await client.query<{ id: string }>(
        `INSERT INTO inventory_events
           (business_id, location_id, event_type, source_type, source_id, created_by, idempotency_key, costing_version)
         VALUES ($1, $2, 'sale_consumption', 'order', $3, NULL, $4, 2)
         RETURNING id`,
        [businessId, locationId, orderId, `cms-order:${orderId}`],
      );
      inventoryEventId = eventRows[0].id;
      const { totalCost } = await deductForOrder(client, businessId, locationId, orderId, null, inventoryEventId);
      cogsRial = totalCost;
      await postExactCogsEntry(client, {
        businessId,
        locationId,
        orderId,
        createdBy: null,
        totalCost,
        inventoryEventId,
      });
    } else if (mapped?.localKind === "item" && industry && industry !== "food_service") {
      const codes = RETAIL_ACCOUNT_CODES[industry];
      const { rows: stockRows } = await client.query<{ unit_cost: string | null }>(
        `SELECT unit_cost::text FROM item_stock WHERE item_id = $1 AND unit_cost IS NOT NULL`,
        [mapped.localId],
      );
      const unitCost = stockRows[0]?.unit_cost ? BigInt(stockRows[0].unit_cost) : 0n;
      if (unitCost > 0n) {
        cogsRial = (unitCost * BigInt(quantity)).toString();
        await client.query(
          `UPDATE item_stock SET quantity = GREATEST(0, quantity - $2), last_sold_at = now(), updated_at = now()
            WHERE item_id = $1`,
          [mapped.localId, quantity],
        );
        const cogsAccounts = await accountIdsByCode(client, businessId, [codes.cogs, codes.inventory]);
        await postExactJournalEntry(client, {
          businessId,
          locationId,
          memo: "بهای تمام‌شده فروش فروشگاه سایت",
          sourceType: "cms_store_order",
          sourceId: orderId,
          createdBy: null,
          postingKind: "cogs",
          lines: [
            { accountId: cogsAccounts.get(codes.cogs)!, debit: cogsRial as RialText, credit: zero },
            { accountId: cogsAccounts.get(codes.inventory)!, debit: zero, credit: cogsRial as RialText },
          ],
        });
      }
    }

    await postRevenueEntry(
      client,
      businessId,
      locationId,
      orderId,
      order.reference,
      total,
      net,
      tax,
      industry,
      inventoryEventId,
    );

    if (inventoryEventId) {
      await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [inventoryEventId]);
    }

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
  industry: Industry | null,
  inventoryEventId: string | null,
): Promise<void> {
  const retailRevenue =
    industry && industry !== "food_service" ? RETAIL_ACCOUNT_CODES[industry].revenue : WELL_KNOWN_CODES.deliveryRevenue;
  const accounts = await accountIdsByCode(client, businessId, [
    WELL_KNOWN_CODES.bankClearing,
    retailRevenue,
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
    inventoryEventId,
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.bankClearing)!, debit: total.toString() as RialText, credit: zero },
      { accountId: accounts.get(retailRevenue)!, debit: zero, credit: net.toString() as RialText },
      ...(tax > 0n
        ? [{ accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: tax.toString() as RialText }]
        : []),
    ],
  });
}
