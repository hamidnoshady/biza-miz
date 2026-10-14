/**
 * Phase G — CMS store `order.paid` → inbox row → one accounting import.
 * Mirrors WooCommerce webhook ingest for paid delivery sales; stock/COGS waits
 * on product mapping.
 */
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool, query, withoutTenantScope, withTenant } from "../db";
import { WELL_KNOWN_CODES } from "../coa-template";
import { RETAIL_ACCOUNT_CODES } from "../retail-account-codes";
import { accountIdsByCode, postExactCogsEntry, postExactJournalEntry } from "../ledger-service";
import { deductForOrder } from "../inventory-service";
import { getPrimaryLocation } from "../setup-state";
import { reconcileExternalIdentity } from "../crm-external-identity";
import { getBusinessIndustry } from "../industry-guard";
import {
  INDUSTRY_NOT_STOREFRONT,
  hasSellableCatalogue,
  isRetailCatalogueIndustry,
  type Industry,
} from "../industries";
import type { RialText } from "../inventory-exact";
import type { WebsiteConnectionRow } from "../website/connection-service";
import { cmsMinorToRial } from "./order-money";
import { sellOnlineRetailLine } from "../retail-online-sale-service";
import { parseRemoteInstant } from "../online-sale-policy";
import { recordOnlineOrderDocument, resolveOnlineChronology } from "../online-order-document-service";
import {
  cmsReversalStatusMatches,
  isCmsReversalEvent,
  reverseImportedCmsStoreOrder,
} from "./order-reversal-service";
import type { CmsOrder } from "./types";

const zero = "0" as RialText;


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
  // Issue #799 Wave 11 — a family question, not a negation. A website is a
  // shopfront only for a trade that sells goods: an order from a construction
  // or service business's site has no catalogue to resolve its lines against,
  // and both branches below (F&B menu, retail items) would write a sale the
  // business never made. Keep the refusal in front of the whole import, so no
  // store order reaches the ledger or the item model for that trade; the named
  // error becomes `markInboxFailed`, which is what the operator sees.
  const industry = await getBusinessIndustry(businessId);
  if (!hasSellableCatalogue(industry)) throw new Error(INDUSTRY_NOT_STOREFRONT);
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

    const title =
      typeof order.product === "object" && order.product && "title" in order.product
        ? String(order.product.title)
        : order.productTitle ?? "محصول فروشگاه";
    const quantity = Math.max(1, order.quantity);
    // Resolve the mapping BEFORE writing the order header: a store product
    // mapped to a retail catalogue `item` makes this a *retail* order, not a
    // delivery order. Getting that wrong was why a CMS reversal later ran
    // through the F&B closed-order engine: the order it was handed had no
    // retail shape to recognise (issue #770).
    const mapped = await resolveWebsiteProductMap(client, businessId, cmsProductId(order));
    const industry = await getBusinessIndustry(businessId);
    const orderType = mapped?.localKind === "item" ? "retail" : "delivery";

    // The sale's own instant (paid, else placed), not the import's — so a
    // replayed or late delivery lands on the day the customer paid. See
    // online-order-document-service.ts.
    const remoteCreatedAt = parseRemoteInstant(order.createdAt, { assumeUtc: false });
    const chronology = await resolveOnlineChronology(client, locationId, {
      createdAt: remoteCreatedAt,
      paidAt: order.status === "paid" ? parseRemoteInstant(order.updatedAt, { assumeUtc: false }) : null,
      completedAt: null,
    });

    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, service_charge, tax, total, note, customer_id, opened_at)
       VALUES ($1, $2, $3, 'open', $4, 0, 0, $5, $6, $7, $8, $9)
       RETURNING id`,
      [locationId, orderNumber, orderType, net.toString(), tax.toString(), total.toString(), note, customerId, chronology.openedAt],
    );
    const orderId = orderRows[0].id;

    let inventoryEventId: string | null = null;
    let cogsRial = "0";
    // The `order_items` row a retail line wrote, so the canonical sale
    // service can persist the exact batch allocation against it.
    let retailOrderItemId: string | null = null;

    if (mapped?.localKind === "menu_item") {
      await client.query(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'served')`,
        [locationId, orderId, mapped.localId, title, unit.toString(), quantity],
      );
    } else if (mapped?.localKind === "item") {
      const { rows: lineRows } = await client.query<{ id: string }>(
        `INSERT INTO order_items (location_id, order_id, item_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'served')
         RETURNING id`,
        [locationId, orderId, mapped.localId, title, unit.toString(), quantity],
      );
      retailOrderItemId = lineRows[0].id;
    } else {
      await client.query(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, NULL, $3, $4, $5, 'served')`,
        [locationId, orderId, title, unit.toString(), quantity],
      );
    }

    if (total > 0n) {
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference, received_at)
         VALUES ($1, $2, 'online', $3, $4, $5)`,
        [locationId, orderId, total.toString(), order.reference, chronology.occurredAt],
      );
    }

    const { rowCount: closed } = await client.query(
      `UPDATE orders SET status = 'completed', closed_at = $2 WHERE id = $1 AND status = 'open' RETURNING id`,
      [orderId, chronology.occurredAt],
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
      const { totalCost } = await deductForOrder(
        client, businessId, locationId, orderId, null, inventoryEventId, chronology.occurredAt,
      );
      cogsRial = totalCost;
      await postExactCogsEntry(client, {
        businessId,
        locationId,
        orderId,
        createdBy: null,
        totalCost,
        inventoryEventId,
        entryDate: chronology.entryDate,
      });
    } else if (mapped?.localKind === "item" && isRetailCatalogueIndustry(industry)) {
      const codes = RETAIL_ACCOUNT_CODES[industry];
      // The canonical online retail sale: FEFO + expired-batch exclusion +
      // exact batch COGS and a persisted allocation for a `tracking='batch'`
      // item; the fungible `item_stock` rule otherwise. The adapter must not
      // decide any of this itself — it used to, and that is exactly how a
      // cosmetics paid order could bypass the batch engine.
      const sold = retailOrderItemId
        ? await sellOnlineRetailLine(client, {
            locationId,
            orderId,
            orderItemId: retailOrderItemId,
            itemId: mapped.localId,
            quantity: String(quantity),
            netRial: (unit * BigInt(quantity)).toString(),
            sourceType: "cms_store_order",
            sourceId: orderId,
            occurredAt: chronology.occurredAt,
            // The CMS never pushes stock back (the site is a shop window), so
            // there is no remote snapshot to compare against.
            remoteOccurredAt: null,
          })
        : null;
      cogsRial = sold ? sold.cogsRial : "0";
      if (BigInt(cogsRial) > 0n) {
        const cogsAccounts = await accountIdsByCode(client, businessId, [codes.cogs, codes.inventory]);
        await postExactJournalEntry(client, {
          businessId,
          locationId,
          memo: "بهای تمام‌شده فروش فروشگاه سایت",
          sourceType: "cms_store_order",
          sourceId: orderId,
          createdBy: null,
          entryDate: chronology.entryDate,
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
      chronology.entryDate,
    );

    if (mapped?.localKind === "item" || orderType === "retail") {
      await recordOnlineOrderDocument(client, {
        orderId,
        locationId,
        sourceType: "cms_store_order",
        remoteId,
        remoteNumber: order.reference,
        currency: order.currency,
        chronology,
        components: {
          linesSubtotalRial: unit * BigInt(quantity),
          // The CMS order is one product line with no discount/shipping/fee
          // fields: they are reported as absent, not as zero.
          discountRial: null,
          shippingRial: null,
          feesRial: null,
          taxRial: tax,
          totalRial: total,
        },
      });
    }

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
  entryDate: string,
): Promise<void> {
  const retailRevenue =
    isRetailCatalogueIndustry(industry)
      ? RETAIL_ACCOUNT_CODES[industry]?.revenue ?? WELL_KNOWN_CODES.deliveryRevenue
      : WELL_KNOWN_CODES.deliveryRevenue;
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
    entryDate,
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
