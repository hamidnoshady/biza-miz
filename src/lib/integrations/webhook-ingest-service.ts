/**
 * Phase 23 (issue #118) — Wave 2 (orders) and Wave 5 (refunds): inbound
 * WooCommerce webhooks become local orders/payments and balanced journal
 * entries. DB-touching (not unit-tested directly; the signature verification
 * and money conversion it leans on are covered by their own tests).
 *
 * Idempotency has two layers: the inbox's UNIQUE (connection_id, delivery_id)
 * dedups a replayed delivery, and integration_mappings' UNIQUE
 * (connection_id, entity_type, remote_id) means an `order.updated`/`restored`
 * that arrives after `order.created` is a no-op at the order level too.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getPool, query, withoutTenantScope, withTenant } from "../db";
import { WELL_KNOWN_CODES } from "../coa-template";
import { accountIdsByCode, postExactCogsEntry, postExactJournalEntry } from "../ledger-service";
import { deductForOrder } from "../inventory-service";
import { createCustomerReturn, type ReturnLine } from "../customer-return-service";
import { quantityText, type RialText } from "../inventory-exact";
import { getPrimaryLocation } from "../setup-state";
import {
  CONNECTION_COLUMNS,
  webhookSecretFor,
  type ConnectionRow,
} from "./connections-service";
import {
  WOO_DELIVERY_ID_HEADER,
  WOO_SIGNATURE_HEADER,
  verifyWooWebhookSignature,
} from "./webhook-signature";
import { wooAmountToRial } from "./woo-money";
import { writeIntegrationAudit } from "./audit";
import { getBusinessIndustry } from "../industry-guard";
import { connectionLocationId, resolveOrderCustomerId, upsertCustomerFromWoo, upsertProductFromWoo } from "./sync-service";
import { wooLineCandidateIds, shouldImportWooOrder } from "./woo-catalogue";
import { deleteWpContent, safeWpUrl, upsertWpContent, type WpContentPayload } from "./wp-content-service";
import { confirmWordPressMediaSync } from "../media-service";
import { replaceTerms, type WooTermSnapshot } from "./woo-taxonomy-service";
import type { WooCustomer, WooOrder, WooOrderLineItem, WooProduct, WooRefund } from "./woocommerce-client";
import type { Industry } from "../industries";

const zero = "0" as RialText;

/**
 * The industry-specific revenue/COGS/inventory accounts a retail trade posts
 * an online sale to. Every value is a WELL_KNOWN_CODES entry that the trade's
 * own chart of accounts seeds (see coa-template.ts), so the WooCommerce order
 * lands in the same accounts a counter sale of the same item would.
 */
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

export async function handleWooCommerceWebhook(
  connectionId: string,
  rawBody: string,
  headers: Headers,
): Promise<NextResponse> {
  // Identify the tenant from the connection id in the URL, before any tenant
  // scope exists — the documented woocommerce-webhook-auth bypass.
  const connection = await withoutTenantScope("woocommerce-webhook-auth", async () => {
    const { rows } = await query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE id = $1`,
      [connectionId],
    );
    return rows[0] ?? null;
  });
  if (!connection) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (!verifyWooWebhookSignature(rawBody, headers.get(WOO_SIGNATURE_HEADER), webhookSecretFor(connection))) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const topic = headers.get("x-wc-webhook-topic") ?? "";
  const deliveryId = headers.get(WOO_DELIVERY_ID_HEADER) ?? `manual-${randomUUID()}`;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  return withTenant(connection.business_id, () =>
    processWebhookEvent(connection, { topic, deliveryId, payload }),
  );
}

export interface WebhookEvent {
  topic: string;
  deliveryId: string;
  payload: Record<string, unknown>;
}

/** What one event did, in the form both doors report it. */
export type IngestOutcome =
  | { status: "processed" }
  | { status: "duplicate" }
  | { status: "deferred" }
  | { status: "failed"; error: string };

/**
 * The single ingest path, shared by both ways a store reaches this app: a
 * WooCommerce webhook delivery (authenticated by its HMAC) and a WordPress
 * plugin push (authenticated by its signed envelope). Everything either one
 * produces — the inbox row, the dedup, the order, the payment, the journal
 * entry — comes from here, so the two doors cannot drift into recording a sale
 * two different ways.
 *
 * Idempotency has two layers: the inbox's UNIQUE (connection_id, delivery_id)
 * dedups a replayed delivery, and integration_mappings' UNIQUE
 * (connection_id, entity_type, remote_id) means an `order.updated`/`restored`
 * that arrives after `order.created` is a no-op at the order level too.
 */
export async function applyIngestEvent(connection: ConnectionRow, event: WebhookEvent): Promise<IngestOutcome> {
  const businessId = connection.business_id;
  const remoteId = event.payload?.id != null ? String(event.payload.id) : "";

  const { rows: inserted } = await query<{ id: string }>(
    `INSERT INTO integration_webhook_events
       (business_id, connection_id, event_topic, remote_id, delivery_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (connection_id, delivery_id) DO NOTHING
     RETURNING id`,
    [businessId, connection.id, event.topic, remoteId, event.deliveryId, JSON.stringify(event.payload)],
  );

  let inboxId: string;
  if (inserted.length > 0) {
    inboxId = inserted[0].id;
  } else {
    // This delivery id has been seen. The whole point of the sender's retry
    // (the plugin re-pushing a row after a backoff, the scheduled pull
    // re-reading an unchanged order) is that the first attempt may have
    // *failed* — so a re-delivery whose earlier attempt failed is retried,
    // not discarded. Treating every re-delivery as a duplicate is how a
    // single transient failure (a variation whose parent had not landed yet,
    // a dropped connection mid-apply) permanently lost the event: the plugin
    // saw "duplicate" as success, marked its queue row sent, and the sale or
    // product never arrived anywhere.
    const { rows: existing } = await query<{ id: string; status: string }>(
      `SELECT id, status FROM integration_webhook_events
        WHERE connection_id = $1 AND delivery_id = $2`,
      [connection.id, event.deliveryId],
    );
    if (existing[0]?.status !== "failed") {
      // Processed already (or another delivery is applying it right now) —
      // exactly the duplicate the idempotency key exists to absorb.
      return { status: "duplicate" };
    }
    inboxId = existing[0].id;
    await query(
      `UPDATE integration_webhook_events
          SET status = 'pending', error = NULL, processed_at = NULL
        WHERE id = $1`,
      [inboxId],
    );
  }

  if (connection.status === "paused") {
    await query(
      `UPDATE integration_webhook_events
          SET status = 'deferred', error = NULL, processed_at = NULL
        WHERE id = $1`,
      [inboxId],
    );
    await writeIntegrationAudit({
      businessId,
      connectionId: connection.id,
      action: "inbox.deferred_while_paused",
      entityType: event.topic,
      remoteId,
    });
    return { status: "deferred" };
  }

  return dispatchIngestEvent(connection, inboxId, event);

}

async function dispatchIngestEvent(
  connection: ConnectionRow,
  inboxId: string,
  event: WebhookEvent,
): Promise<IngestOutcome> {
  const businessId = connection.business_id;
  const remoteId = event.payload?.id != null ? String(event.payload.id) : "";
  try {
    if (event.topic.endsWith("order.created") || event.topic.endsWith("order.updated") || event.topic.endsWith("order.restored")) {
      const order = event.payload as unknown as WooOrder;
      // An order the store has not been paid for yet is not a sale. It is
      // acked (processed, not failed) so the sender does not retry it, and
      // the payload stays in the inbox — the event that moves it into a paid
      // state carries a new delivery id and imports it then. Without this
      // gate every abandoned cart, cancelled checkout and failed payment in
      // the lookback window was imported as a completed, paid sale with a
      // revenue journal entry.
      if (connection.sync_orders && shouldImportWooOrder(order.status)) {
        await ingestOrder(connection, order);
      }
    } else if (event.topic.endsWith("refund.created")) {
      await ingestRefund(connection, event.payload as unknown as WooRefund, inboxId);
    } else if (event.topic.endsWith("product.created") || event.topic.endsWith("product.updated")) {
      // In REST mode a product event is only a hint — the app pulls the
      // catalogue itself — but a plugin push is the *only* way the catalogue
      // ever arrives, so it is applied here for both. Applying it twice is
      // harmless: upsertProductFromWoo is keyed on the mapping row.
      if (connection.sync_products) {
        await upsertProductFromWoo(
          connection,
          await connectionLocationId(connection),
          event.payload as unknown as WooProduct,
        );
      }
    } else if (event.topic.endsWith("customer.created") || event.topic.endsWith("customer.updated")) {
      if (connection.sync_customers) {
        await upsertCustomerFromWoo(connection, event.payload as unknown as WooCustomer);
      }
    } else if (event.topic.endsWith("content.updated") || event.topic.endsWith("content.created")) {
      // Phase 40 — WordPress posts/pages/media, pushed by the plugin. The
      // commerce sync toggles don't gate this: content mirroring is the WP
      // Manager app's own job, and a shop that only syncs orders still has
      // pages it would be harmless to see.
      await upsertWpContent(connection, event.payload as never);
      // Phase — WordPress as a view over the central Media Library. The
      // plugin stamps `_pos_operation_id` on an attachment it just created
      // from a `media_create` job (class-pos-sync.php: apply_media_create)
      // and echoes it back on exactly this event (content_payload()); no
      // other attachment event ever carries one. That is the only signal
      // that correlates a push back to the `wordpress_media_mapping` row
      // waiting on it — the job ack (pluginAckJobs) only reports "the job
      // ran without throwing", never the resulting attachment's identity.
      const wpPayload = event.payload as unknown as WpContentPayload;
      if (wpPayload.type === "attachment" && typeof wpPayload.operation_id === "string" && wpPayload.operation_id) {
        const wpUrl = safeWpUrl(wpPayload.source_url) || safeWpUrl(wpPayload.url);
        if (wpUrl && remoteId) {
          await confirmWordPressMediaSync(wpPayload.operation_id, remoteId, wpUrl);
        }
      }
    } else if (event.topic.endsWith("content.deleted")) {
      // Trash is an ordinary update carrying status=trash; only a permanent
      // deletion removes the mirror row. Validate the plugin payload before
      // it reaches the tenant-scoped delete query.
      const contentType = typeof event.payload.type === "string" ? event.payload.type.trim() : "";
      if (!contentType || !/^[1-9]\d*$/.test(remoteId)) throw new Error("invalid_content_delete");
      await deleteWpContent(businessId, connection.id, { id: remoteId, type: contentType });
    } else if (event.topic.endsWith("catalogue.taxonomy_terms")) {
      const taxonomy = typeof event.payload.taxonomy === "string" ? event.payload.taxonomy.trim() : "";
      const terms = Array.isArray(event.payload.terms) ? (event.payload.terms as WooTermSnapshot[]) : [];
      if (!taxonomy) throw new Error("missing_taxonomy");
      await replaceTerms(businessId, connection.id, taxonomy, terms);
    } else if (event.topic.endsWith("catalogue.sync_completed")) {
      await query(
        `UPDATE integration_connections SET last_catalogue_sync_at = now(), updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [businessId, connection.id],
      );
    } else if (event.topic.endsWith("orders.sync_completed")) {
      await query(
        `UPDATE integration_connections SET last_order_sync_at = now(), updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [businessId, connection.id],
      );
    } else if (event.topic.endsWith("customers.sync_completed")) {
      await query(
        `UPDATE integration_connections SET last_customer_sync_at = now(), updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [businessId, connection.id],
      );
    } else if (event.topic.endsWith("content.sync_completed")) {
      // The plugin enqueues this marker *after* every row in a full export.
      // Queue ordering therefore makes this an honest watermark: all content
      // that preceded it has already reached the local mirror.
      await query(
        `UPDATE integration_connections SET last_content_sync_at = now(), updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [businessId, connection.id],
      );
    }
    // Any other topic is acknowledged and left alone — we never want a
    // re-delivery storm for an event we don't handle yet.
    await query(
      `UPDATE integration_webhook_events SET status = 'processed', processed_at = now(), error = NULL WHERE id = $1`,
      [inboxId],
    );
    return { status: "processed" };
  } catch (err) {
    const message = (err as Error).message;
    await query(`UPDATE integration_webhook_events SET status = 'failed', error = $2 WHERE id = $1`, [inboxId, message]);
    return { status: "failed", error: message };
  }
}

export async function reprocessExistingIngestEvent(
  connection: ConnectionRow,
  inboxId: string,
): Promise<IngestOutcome> {
  const { rows } = await query<{
    id: string;
    event_topic: string;
    delivery_id: string;
    payload: Record<string, unknown>;
    status: string;
  }>(
    `SELECT id, event_topic, delivery_id, payload, status
       FROM integration_webhook_events
      WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
    [inboxId, connection.business_id, connection.id],
  );
  const row = rows[0];
  if (!row) return { status: "failed", error: "inbox_not_found" };
  await query(
    `UPDATE integration_webhook_events
        SET status = 'pending', error = NULL, processed_at = NULL
      WHERE id = $1`,
    [row.id],
  );
  if (connection.status === "paused") {
    await query(`UPDATE integration_webhook_events SET status = 'deferred' WHERE id = $1`, [row.id]);
    return { status: "deferred" };
  }
  return dispatchIngestEvent(connection, row.id, {
    topic: row.event_topic,
    deliveryId: row.delivery_id,
    payload: row.payload ?? {},
  });
}

export async function reprocessDeferredIngestEvents(connection: ConnectionRow): Promise<{ processed: number; failed: number }> {
  const { rows } = await query<{ id: string }>(
    `SELECT id
       FROM integration_webhook_events
      WHERE business_id = $1 AND connection_id = $2 AND status = 'deferred'
      ORDER BY created_at ASC
      LIMIT 500`,
    [connection.business_id, connection.id],
  );
  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    const outcome = await reprocessExistingIngestEvent(connection, row.id);
    if (outcome.status === "processed" || outcome.status === "duplicate") processed += 1;
    if (outcome.status === "failed") failed += 1;
  }
  if (processed + failed > 0) {
    await writeIntegrationAudit({
      businessId: connection.business_id,
      connectionId: connection.id,
      action: "inbox.deferred_reprocessed",
      payload: { processed, failed },
    });
  }
  return { processed, failed };
}

async function processWebhookEvent(connection: ConnectionRow, event: WebhookEvent): Promise<NextResponse> {
  const outcome = await applyIngestEvent(connection, event);
  if (outcome.status === "duplicate") return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
  if (outcome.status === "deferred") return NextResponse.json({ ok: true, deferred: true }, { status: 202 });
  if (outcome.status === "failed") return NextResponse.json({ ok: false, error: outcome.error }, { status: 500 });
  return NextResponse.json({ ok: true }, { status: 200 });
}

/** One event as the WordPress plugin sends it. */
export interface PluginEventInput {
  topic?: string;
  /** The plugin's own idempotency key, generated once per event and reused across retries. */
  deliveryId?: string;
  payload?: Record<string, unknown>;
}

/**
 * Apply one plugin-pushed event and report what happened to *that* event.
 *
 * Unlike a webhook, a plugin push is a batch: the caller needs a per-event
 * answer so one malformed order does not force it to re-send ninety-nine good
 * ones. A failure is reported, not thrown, for the same reason — the batch
 * continues, and the plugin re-sends only what failed.
 *
 * Must be called inside the connection's tenant scope; plugin-service.ts's
 * `pluginPushEvents` establishes it once for the whole batch.
 */
export async function ingestPluginEvent(
  connection: ConnectionRow,
  event: PluginEventInput,
): Promise<{ deliveryId: string; status: string; error?: string }> {
  const deliveryId = event.deliveryId?.trim() || `plugin-${randomUUID()}`;
  const topic = event.topic?.trim() ?? "";
  if (!topic) return { deliveryId, status: "failed", error: "missing_topic" };
  if (!event.payload || typeof event.payload !== "object") {
    return { deliveryId, status: "failed", error: "missing_payload" };
  }

  const outcome = await applyIngestEvent(connection, { topic, deliveryId, payload: event.payload });
  return outcome.status === "failed"
    ? { deliveryId, status: "failed", error: outcome.error }
    : { deliveryId, status: outcome.status };
}

/**
 * Ingest an order this app went and *fetched* rather than one the store
 * pushed.
 *
 * The scheduled pull (sync-service.ts's `syncOrders`) and a manual
 * «همگام‌سازی سفارش‌ها» both land here, which is the point: they run the
 * identical `applyIngestEvent` a webhook delivery runs, so an order that
 * arrives by pull and the same order arriving by webhook cannot end up
 * recorded two different ways.
 *
 * The caller supplies the delivery id, and it matters that it is derived
 * from the order's own `date_modified`: an unchanged order re-pulled is a
 * duplicate (free, by the inbox's unique key), while an order that changed
 * since the last pull is re-ingested — and then dropped at the order level by
 * its mapping row, because `order.updated` after `order.created` is a no-op.
 *
 * `sync_orders` is honoured here rather than by the caller: a connection with
 * order sync switched off must not acquire orders through a back door.
 */
export async function ingestRemoteOrder(
  connection: ConnectionRow,
  order: WooOrder,
  deliveryId: string,
): Promise<IngestOutcome> {
  if (!connection.sync_orders) return { status: "duplicate" };
  return applyIngestEvent(connection, {
    topic: "order.created",
    deliveryId,
    payload: order as unknown as Record<string, unknown>,
  });
}

/** The refund twin of `ingestRemoteOrder` — same reasoning, same path. */
export async function ingestRemoteRefund(
  connection: ConnectionRow,
  refund: WooRefund,
  deliveryId: string,
): Promise<IngestOutcome> {
  return applyIngestEvent(connection, {
    topic: "refund.created",
    deliveryId,
    payload: refund as unknown as Record<string, unknown>,
  });
}

/** The branch an integration writes to: the connection's own, else the primary. */
async function resolveLocationId(connection: ConnectionRow): Promise<string> {
  if (connection.location_id) return connection.location_id;
  const primary = await getPrimaryLocation(connection.business_id);
  if (!primary) throw new Error("no_location");
  return primary.id;
}


/**
 * How one order line resolved to a local product.
 *
 * `via` is the part that used not to exist. A variation line whose variation
 * is mapped is a real sale of a real sellable row; one that only resolved to
 * its variable parent is revenue with no stock movement, and the two must not
 * be treated alike. Collapsing them into one nullable id — as every path did
 * before Phase 38 — is how an order for a variation recorded revenue and
 * silently dropped its COGS.
 */
export interface ResolvedOrderLine {
  localId: string | null;
  remoteId: string | null;
  via: "variation" | "product" | "parent_fallback" | "none";
}

/**
 * Resolve every line of an order to a local product, in one query.
 *
 * Candidate ids are `variation_id` before `product_id`: for a variable
 * product they are different rows and only the variation carries a SKU, a
 * price and stock. Reading `product_id` alone — which is what the webhook,
 * the REST pull and the plugin push each did — resolved the line to the
 * parent, and the parent is created as a non-sellable container.
 */
async function resolveOrderLineItems(
  db: import("pg").PoolClient,
  connection: ConnectionRow,
  order: WooOrder,
): Promise<ResolvedOrderLine[]> {
  const lines = order.line_items ?? [];
  const candidates = [...new Set(lines.flatMap(wooLineCandidateIds))];
  const mapped = new Map<string, string>();
  if (candidates.length > 0) {
    const { rows } = await db.query<{ remote_id: string; local_id: string }>(
      `SELECT remote_id, local_id FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product'
          AND remote_id = ANY($3::text[])`,
      [connection.business_id, connection.id, candidates],
    );
    for (const row of rows) mapped.set(row.remote_id, row.local_id);
  }

  return lines.map((line) => {
    const variationId = Number(line.variation_id ?? 0) || 0;
    for (const id of wooLineCandidateIds(line)) {
      const localId = mapped.get(id);
      if (!localId) continue;
      const via: ResolvedOrderLine["via"] =
        variationId > 0 && id === String(variationId)
          ? "variation"
          : variationId > 0
            ? "parent_fallback"
            : "product";
      return { localId, remoteId: id, via };
    }
    // Nothing mapped. The remote id is still worth carrying, so an operator
    // reading the audit can see exactly which store row failed to resolve.
    const remoteId = variationId > 0 ? String(variationId) : line.product_id ? String(line.product_id) : null;
    return { localId: null, remoteId, via: variationId > 0 ? "parent_fallback" : "none" };
  });
}

/**
 * Create the sellable child an unmapped variation line refers to.
 *
 * A store whose catalogue was never fully synced — or whose new variation
 * arrived after the last one — would otherwise attribute every sale of that
 * variation to its parent, which by design holds no stock and posts no COGS.
 * Making the child is what lets the *next* sale of it behave correctly, and
 * it carries the only facts an order line knows: the name the customer saw,
 * the SKU, and the price they paid.
 *
 * Best-effort: if it cannot be made, the caller keeps the parent and the
 * order still imports. Losing a stock movement is not a reason to lose a
 * sale.
 */
async function ensureVariationStub(
  db: import("pg").PoolClient,
  connection: ConnectionRow,
  locationId: string,
  line: WooOrderLineItem,
  parentLocalId: string,
  priceRial: bigint,
): Promise<string | null> {
  const variationId = Number(line.variation_id ?? 0) || 0;
  if (variationId <= 0) return null;
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO items (location_id, parent_item_id, name, sku, kind, tracking)
       VALUES ($1, $2, $3, $4, 'variant_child', 'none') RETURNING id`,
      [locationId, parentLocalId, line.name?.trim() || `Variation #${variationId}`, line.sku?.trim() || null],
    );
    const itemId = rows[0].id;
    await db.query(
      `INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, 0, $2)`,
      [itemId, priceRial > 0n ? Number(priceRial) : null],
    );
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', $3, $4)
       ON CONFLICT (connection_id, entity_type, remote_id)
       DO UPDATE SET local_id = EXCLUDED.local_id, updated_at = now()`,
      [connection.business_id, connection.id, String(variationId), itemId],
    );
    return itemId;
  } catch {
    // A duplicate SKU, a constraint from an extension — none of it is worth
    // failing the order over.
    return null;
  }
}

/** True only for a line that resolved to the row that actually holds stock. */
function relievesStock(line: ResolvedOrderLine): boolean {
  return line.via === "variation" || line.via === "product";
}

async function ingestOrder(connection: ConnectionRow, order: WooOrder): Promise<void> {
  const industry = await getBusinessIndustry(connection.business_id);
  if (industry && industry !== "food_service") {
    await ingestRetailOrder(connection, order, industry);
    return;
  }
  await ingestFnBOrder(connection, order);
}

/**
 * F&B: one WooCommerce order -> a `delivery` order whose lines point at
 * `menu_items`, with recipe-based inventory deduction and COGS. The original
 * Wave 2 path, now reached only by food_service businesses.
 */
async function ingestFnBOrder(connection: ConnectionRow, order: WooOrder): Promise<void> {
  const businessId = connection.business_id;
  const remoteId = String(order.id);

  const total = wooAmountToRial(order.total ?? "0", connection.currency_unit);
  const tax = wooAmountToRial(order.total_tax ?? "0", connection.currency_unit);
  if (tax > total) throw new Error("tax_exceeds_total");
  const net = total - tax;

  const locationId = await resolveLocationId(connection);
  const note = order.billing
    ? `مشتری: ${[order.billing.first_name, order.billing.last_name].filter(Boolean).join(" ")}`
    : null;
  // Who bought it. Linked on the order rather than only named in a note,
  // because that link is what puts an online sale into the CRM's customer
  // timeline, its RFM population and Growth's segments — none of which could
  // see a WooCommerce buyer before Phase 38.
  const customerId = await resolveOrderCustomerId(connection, order);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent deliveries of the same remote order: two different
    // webhook deliveries (order.created + order.updated) can race, and the
    // advisory lock plus the in-transaction mapping re-check makes the second
    // a no-op rather than a duplicate order.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`woo-order:${connection.id}:${remoteId}`]);
    const { rows: mapped } = await client.query(
      `SELECT 1 FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'order' AND remote_id = $3`,
      [businessId, connection.id, remoteId],
    );
    if (mapped.length > 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { rows: counter } = await client.query<{ next_number: string }>(
      `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
       ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
       RETURNING next_number - 1 AS next_number`,
      [locationId],
    );
    const orderNumber = Number(counter[0].next_number);

    // Insert as 'open' first — the order_items financial guard (migration
    // 0014) rejects item inserts against a non-open order. The order is
    // closed to 'completed' below, after items and payment are recorded,
    // mirroring the POS checkout flow.
    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, service_charge, tax, total, note, customer_id)
       VALUES ($1, $2, 'delivery', 'open', $3, 0, 0, $4, $5, $6, $7)
       RETURNING id`,
      [locationId, orderNumber, net.toString(), tax.toString(), total.toString(), note, customerId],
    );
    const orderId = orderRows[0].id;

    // Resolve each line's WooCommerce product to its mapped local menu item
    // (Wave 3's integration_mappings) so recipe-based inventory deducts for
    // online sales exactly like a POS sale. Unmapped lines are still recorded
    // — revenue is never missed — but contribute no stock movement, the POS
    // equivalent of an order item with no recipe.
    //
    // A variation line resolves to the variation, not to its parent: F&B
    // skips variable/grouped containers entirely (see sync-service), so
    // reading `product_id` alone meant a variation never resolved at all.
    const resolution = await resolveOrderLineItems(client, connection, order);
    let unmappedLines = 0;
    for (const [index, line] of (order.line_items ?? []).entries()) {
      const unitPrice = wooAmountToRial(line.price ?? "0", connection.currency_unit);
      const quantity = Math.max(1, Math.round(line.quantity ?? 1));
      const menuItemId = resolution[index]?.localId ?? null;
      if (!menuItemId) unmappedLines += 1;
      await client.query(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'served')`,
        [locationId, orderId, menuItemId, line.name, unitPrice.toString(), quantity],
      );
    }

    if (total > 0n) {
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference)
         VALUES ($1, $2, 'online', $3, $4)`,
        [locationId, orderId, total.toString(), order.number ?? remoteId],
      );
    }

    const { rowCount: closed } = await client.query(
      `UPDATE orders SET status = 'completed', closed_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [orderId],
    );
    if (closed !== 1) {
      throw new Error("order_close_failed");
    }

    // Inventory + COGS for the mapped lines — the identical flow the POS pay
    // route runs: one sale_consumption inventory event, recipe-based
    // deduction through the shared inventory service, and the same COGS
    // journal entry (Debit COGS / Credit Inventory), all in this transaction.
    // Orders with no mapped products post no COGS (their cost basis doesn't
    // exist yet), the same shape as a POS item with no recipe.
    let inventoryEventId: string | null = null;
    let cogsRial = "0";
    // Deduct only when at least one line resolved to a real menu item — the
    // POS rule is "no recipe, no COGS", and an unmapped line has no recipe.
    if (resolution.some((r) => r.via === "variation" || r.via === "product")) {
      const { rows: eventRows } = await client.query<{ id: string }>(
        `INSERT INTO inventory_events
           (business_id, location_id, event_type, source_type, source_id, created_by, idempotency_key, costing_version)
         VALUES ($1, $2, 'sale_consumption', 'order', $3, NULL, $4, 2)
         RETURNING id`,
        [businessId, locationId, orderId, `woo-order:${orderId}`],
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
    }

    const accounts = await accountIdsByCode(client, businessId, [
      WELL_KNOWN_CODES.bankClearing,
      WELL_KNOWN_CODES.deliveryRevenue,
      WELL_KNOWN_CODES.vatPayable,
    ]);
    await postExactJournalEntry(client, {
      businessId,
      locationId,
      memo: `فروش آنلاین ووکامرس #${order.number ?? order.id}`,
      sourceType: "woocommerce_order",
      sourceId: orderId,
      createdBy: null,
      postingKind: "revenue",
      inventoryEventId,
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.bankClearing)!, debit: total.toString() as RialText, credit: zero },
        { accountId: accounts.get(WELL_KNOWN_CODES.deliveryRevenue)!, debit: zero, credit: net.toString() as RialText },
        ...(tax > 0n
          ? [{ accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: tax.toString() as RialText }]
          : []),
      ],
    });
    if (inventoryEventId) {
      await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [inventoryEventId]);
    }

    await client.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'order', $3, $4)
       ON CONFLICT (connection_id, entity_type, remote_id) DO NOTHING`,
      [businessId, connection.id, remoteId, orderId],
    );
    await client.query("COMMIT");

    await writeIntegrationAudit({
      businessId,
      connectionId: connection.id,
      action: "order.imported",
      entityType: "order",
      remoteId,
      localId: orderId,
      payload: {
        orderNumber: order.number ?? remoteId,
        totalRial: total.toString(),
        cogsRial,
        unmappedLines,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retail: one WooCommerce order -> a `retail` order whose lines point at the
 * `items` model (order_items.item_id) rather than F&B's `menu_items`, with the
 * revenue posted to the trade's own sales-revenue account. COGS is posted only
 * for lines whose item already has a weighted-average cost basis — the same
 * "no cost yet, no COGS" rule the counter sale enforces — and the stock
 * quantity is relieved in the same step.
 */
async function ingestRetailOrder(
  connection: ConnectionRow,
  order: WooOrder,
  industry: Exclude<Industry, "food_service">,
): Promise<void> {
  const businessId = connection.business_id;
  const remoteId = String(order.id);
  const codes = RETAIL_ACCOUNT_CODES[industry];

  const total = wooAmountToRial(order.total ?? "0", connection.currency_unit);
  const tax = wooAmountToRial(order.total_tax ?? "0", connection.currency_unit);
  if (tax > total) throw new Error("tax_exceeds_total");
  const net = total - tax;

  const locationId = await resolveLocationId(connection);
  const note = order.billing
    ? `مشتری: ${[order.billing.first_name, order.billing.last_name].filter(Boolean).join(" ")}`
    : null;
  // The CRM bridge — see ingestFnBOrder for why the link, not just the name.
  const customerId = await resolveOrderCustomerId(connection, order);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`woo-order:${connection.id}:${remoteId}`]);
    const { rows: mapped } = await client.query(
      `SELECT 1 FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'order' AND remote_id = $3`,
      [businessId, connection.id, remoteId],
    );
    if (mapped.length > 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { rows: counter } = await client.query<{ next_number: string }>(
      `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
       ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
       RETURNING next_number - 1 AS next_number`,
      [locationId],
    );
    const orderNumber = Number(counter[0].next_number);

    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, service_charge, tax, total, note, customer_id)
       VALUES ($1, $2, 'retail', 'open', $3, 0, 0, $4, $5, $6, $7)
       RETURNING id`,
      [locationId, orderNumber, net.toString(), tax.toString(), total.toString(), note, customerId],
    );
    const orderId = orderRows[0].id;

    // Resolve each line's WooCommerce product to its mapped local item. A
    // variation line resolves to the exact sellable variant_child; a simple
    // product to its item; a variation whose row has never been synced falls
    // back to its parent and is recorded without stock movement, because
    // there is no way to know which child left the shelf.
    const resolution = await resolveOrderLineItems(client, connection, order);

    // Which resolved rows are containers (a variable/grouped parent). A line
    // that landed on one gets a real item id so the sale is attributed to the
    // family, but no stock relief, and a variation stub is made under it so
    // the *next* sale of that variation behaves properly.
    const containerIds = new Set<string>();
    const resolvedIds = [...new Set(resolution.map((r) => r.localId).filter((id): id is string => Boolean(id)))];
    if (resolvedIds.length > 0) {
      const { rows: kinds } = await client.query<{ id: string; kind: string }>(
        `SELECT id, kind FROM items WHERE id = ANY($1::uuid[])`,
        [resolvedIds],
      );
      for (const row of kinds) {
        if (row.kind === "variant_parent") containerIds.add(row.id);
      }
    }

    // The cost basis for every mapped line, fetched once so COGS and stock
    // relief use the exact weighted-average cost the counter sale would.
    const itemIds = resolvedIds;
    const costById = new Map<string, bigint>();
    if (itemIds.length > 0) {
      const { rows: stockRows } = await client.query<{ item_id: string; unit_cost: string | null }>(
        `SELECT item_id, unit_cost::text FROM item_stock WHERE item_id = ANY($1::uuid[]) AND unit_cost IS NOT NULL`,
        [itemIds],
      );
      for (const r of stockRows) costById.set(r.item_id, BigInt(r.unit_cost as string));
    }

    let cogsRial = "0";
    let stubbedVariations = 0;
    for (const [index, line] of (order.line_items ?? []).entries()) {
      const unitPrice = wooAmountToRial(line.price ?? "0", connection.currency_unit);
      const quantity = Math.max(1, Math.round(line.quantity ?? 1));
      const resolved = resolution[index];
      let itemId = resolved?.localId ?? null;

      // A variation line that landed on its parent: make the child, inside
      // this transaction, so the sale is attributed to the sellable row and
      // every later sale of it relieves stock and posts COGS.
      if (itemId && resolved?.via === "parent_fallback" && containerIds.has(itemId)) {
        const stubId = await ensureVariationStub(client, connection, locationId, line, itemId, unitPrice);
        if (stubId) {
          itemId = stubId;
          stubbedVariations += 1;
          // Re-read: the stub's stock row has no cost yet, so this line posts
          // no COGS — correct, and the same rule a counter sale follows.
          resolution[index] = { localId: stubId, remoteId: resolved.remoteId, via: "variation" };
        }
      }

      await client.query(
        `INSERT INTO order_items (location_id, order_id, item_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'served')`,
        [locationId, orderId, itemId, line.name, unitPrice.toString(), quantity],
      );

      // COGS + stock relief only for a mapped item with a known cost basis —
      // the retail analogue of F&B's "no recipe, no COGS" — and only when the
      // line resolved to the row that actually carries stock.
      const unitCost = itemId && relievesStock(resolution[index]) ? costById.get(itemId) : undefined;
      if (unitCost != null && unitCost > 0n) {
        cogsRial = (BigInt(cogsRial) + unitCost * BigInt(quantity)).toString();
        // GREATEST(0, …) so a stock picture already synced post-sale (WooCommerce
        // deducted it) can never drive the quantity negative and abort the order;
        // the next catalogue sync re-establishes the authoritative level.
        await client.query(
          `UPDATE item_stock SET quantity = GREATEST(0, quantity - $2), last_sold_at = now(), updated_at = now()
            WHERE item_id = $1`,
          [itemId, quantity],
        );
      }
    }

    if (total > 0n) {
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference)
         VALUES ($1, $2, 'online', $3, $4)`,
        [locationId, orderId, total.toString(), order.number ?? remoteId],
      );
    }

    const { rowCount: closed } = await client.query(
      `UPDATE orders SET status = 'completed', closed_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [orderId],
    );
    if (closed !== 1) {
      throw new Error("order_close_failed");
    }

    // COGS entry posts to the trade's own COGS/inventory accounts, not F&B's
    // 5100/1300 — the same split a counter sale's posting rule produces.
    if (BigInt(cogsRial) > 0n) {
      const cogsAccounts = await accountIdsByCode(client, businessId, [codes.cogs, codes.inventory]);
      await postExactJournalEntry(client, {
        businessId,
        locationId,
        memo: "بهای تمام‌شده فروش آنلاین",
        sourceType: "woocommerce_order",
        sourceId: orderId,
        createdBy: null,
        postingKind: "cogs",
        lines: [
          { accountId: cogsAccounts.get(codes.cogs)!, debit: cogsRial as RialText, credit: zero },
          { accountId: cogsAccounts.get(codes.inventory)!, debit: zero, credit: cogsRial as RialText },
        ],
      });
    }

    const accounts = await accountIdsByCode(client, businessId, [
      WELL_KNOWN_CODES.bankClearing,
      codes.revenue,
      WELL_KNOWN_CODES.vatPayable,
    ]);
    await postExactJournalEntry(client, {
      businessId,
      locationId,
      memo: `فروش آنلاین ووکامرس #${order.number ?? order.id}`,
      sourceType: "woocommerce_order",
      sourceId: orderId,
      createdBy: null,
      postingKind: "revenue",
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.bankClearing)!, debit: total.toString() as RialText, credit: zero },
        { accountId: accounts.get(codes.revenue)!, debit: zero, credit: net.toString() as RialText },
        ...(tax > 0n
          ? [{ accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: tax.toString() as RialText }]
          : []),
      ],
    });

    await client.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'order', $3, $4)
       ON CONFLICT (connection_id, entity_type, remote_id) DO NOTHING`,
      [businessId, connection.id, remoteId, orderId],
    );
    await client.query("COMMIT");

    await writeIntegrationAudit({
      businessId,
      connectionId: connection.id,
      action: "order.imported",
      entityType: "order",
      remoteId,
      localId: orderId,
      payload: {
        orderNumber: order.number ?? remoteId,
        totalRial: total.toString(),
        cogsRial,
        stubbedVariations,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Maps a WooCommerce refund's line items to local order items via the product
 * mapping, splitting a quantity across repeated rows of the same product and
 * never exceeding what each order item still has returnable. Unmapped products
 * are skipped — an order line that never deducted inventory has nothing to
 * restore.
 *
 * Since Phase 25 retail orders use `order_items.item_id` (FK to `items`) while
 * F&B orders use `menu_item_id`, the WHERE clause matches both columns. The
 * returned objects carry an optional `itemId` so the caller can tell which
 * inventory model to restock: `item_stock` (retail) vs `stock_movements` (F&B).
 */
async function buildRefundReturnLines(
  client: import("pg").PoolClient,
  businessId: string,
  connection: ConnectionRow,
  orderId: string,
  refund: WooRefund,
): Promise<(ReturnLine & { itemId?: string })[]> {
  const lines: (ReturnLine & { itemId?: string })[] = [];
  // A refunded line identifies its variation the same way the order line
  // did — `variation_id` when there is one. Matching on `product_id` alone
  // would look for a return against the variable parent, which holds no
  // stock and was never on the order as a sellable row.
  const remoteProductIds = [
    ...new Set(
      (refund.line_items ?? [])
        .flatMap((line) => [
          Number(line.variation_id ?? 0) || 0 ? String(line.variation_id) : "",
          line.product_id ? String(line.product_id) : "",
        ])
        .filter(Boolean),
    ),
  ];
  if (remoteProductIds.length === 0) return lines;
  const { rows: productMappings } = await client.query<{ remote_id: string; local_id: string }>(
    `SELECT remote_id, local_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product'
        AND remote_id = ANY($3::text[])`,
    [businessId, connection.id, remoteProductIds],
  );
  const localByRemote = new Map(productMappings.map((m) => [m.remote_id, m.local_id]));

  for (const line of refund.line_items ?? []) {
    const variationId = Number(line.variation_id ?? 0) || 0;
    const localId =
      (variationId > 0 ? localByRemote.get(String(variationId)) : undefined) ??
      localByRemote.get(String(line.product_id));
    if (!localId) continue;
    // WooCommerce refund quantities are negative.
    let remaining = Math.max(0, Math.abs(Math.round(line.quantity ?? 0)));
    if (remaining === 0) continue;
    // Match by both menu_item_id (F&B) and item_id (retail) — retail orders
    // from ingestRetailOrder populate item_id, F&B orders populate menu_item_id.
    const { rows: items } = await client.query<{ id: string; quantity: string; returned: string; item_id: string | null }>(
      `SELECT oi.id, oi.quantity::text,
              COALESCE((SELECT sum(l.quantity)::text FROM customer_return_lines l
                         WHERE l.order_item_id = oi.id), '0') AS returned,
              oi.item_id::text
         FROM order_items oi
        WHERE oi.order_id = $1
          AND (oi.menu_item_id = $2 OR oi.item_id = $2)
          AND oi.status <> 'voided'
        ORDER BY oi.created_at, oi.id`,
      [orderId, localId],
    );
    for (const item of items) {
      if (remaining <= 0) break;
      const take = Math.min(Number(item.quantity) - Number(item.returned), remaining);
      if (take > 0) {
        const rl: ReturnLine & { itemId?: string } = { orderItemId: item.id, quantity: quantityText(String(take)), disposition: "restockable" };
        if (item.item_id) rl.itemId = item.item_id;
        lines.push(rl);
        remaining -= take;
      }
    }
  }
  return lines;
}

async function ingestRefund(connection: ConnectionRow, refund: WooRefund, inboxId: string): Promise<void> {
  const businessId = connection.business_id;
  const remoteId = String(refund.id);

  const amount = wooAmountToRial(refund.amount ?? "0", connection.currency_unit);
  const tax = refund.total_tax ? wooAmountToRial(refund.total_tax, connection.currency_unit) : 0n;
  if (tax > amount) throw new Error("tax_exceeds_refund");
  const net = amount - tax;
  const locationId = await resolveLocationId(connection);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Same race-proofing as ingestOrder: two refund deliveries of one refund
    // must not double-post.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`woo-refund:${connection.id}:${remoteId}`]);
    const { rows: mapped } = await client.query(
      `SELECT 1 FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'refund' AND remote_id = $3`,
      [businessId, connection.id, remoteId],
    );
    if (mapped.length > 0) {
      await client.query("ROLLBACK");
      return;
    }

    const industry = await getBusinessIndustry(businessId);
    if (industry && industry !== "food_service") {
      await ingestRetailRefund(client, connection, refund, { businessId, locationId, amount, tax, net, remoteId, inboxId, industry });
    } else {
      await ingestFnBRefund(client, connection, refund, { businessId, locationId, amount, tax, net, remoteId, inboxId });
    }

    await client.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'refund', $3, $4)
       ON CONFLICT (connection_id, entity_type, remote_id) DO NOTHING`,
      [businessId, connection.id, remoteId, inboxId],
    );
    await client.query("COMMIT");

    await writeIntegrationAudit({
      businessId,
      connectionId: connection.id,
      action: "refund.imported",
      entityType: "refund",
      remoteId,
      payload: { amountRial: amount.toString(), parentRemoteId: String(refund.parent_id) },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

interface RefundMeta {
  businessId: string;
  locationId: string;
  amount: bigint;
  tax: bigint;
  net: bigint;
  remoteId: string;
  inboxId: string;
}

/**
 * Retail refund: restock `item_stock` directly and post a trade-specific COGS
 * reversal — the retail analogue of `createCustomerReturn`. Because retail
 * orders don't populate `order_item_inventory_snapshots` (that's F&B's recipe
 * deductor), inventory recovery bypasses the customer-return machinery and
 * updates `item_stock.quantity` directly, using the unit_cost the order
 * import recorded.
 */
async function ingestRetailRefund(
  client: import("pg").PoolClient,
  connection: ConnectionRow,
  refund: WooRefund,
  meta: RefundMeta & { industry: Exclude<Industry, "food_service"> },
): Promise<void> {
  const codes = RETAIL_ACCOUNT_CODES[meta.industry];

  // Find the imported order.
  const { rows: orderRows } = await client.query<{ id: string }>(
    `SELECT local_id::text AS id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'order' AND remote_id = $3`,
    [meta.businessId, connection.id, String(refund.parent_id)],
  );
  const orderId = orderRows[0]?.id ?? null;

  // Resolve product mappings for the refund's line items so we can match
  // them to item_id rows in order_items and find their cost basis.
  const remoteProductIds = (refund.line_items ?? [])
    .map((line) => String(line.product_id))
    .filter((id): id is string => Boolean(id));
  const itemByRemote = new Map<string, string>();
  if (remoteProductIds.length > 0) {
    const { rows: productMappings } = await client.query<{ remote_id: string; local_id: string }>(
      `SELECT remote_id, local_id FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product'
          AND remote_id = ANY($3::text[])`,
      [meta.businessId, connection.id, remoteProductIds],
    );
    for (const m of productMappings) itemByRemote.set(m.remote_id, m.local_id);
  }

  // Fetch the unit_cost for every mapped item so the COGS reversal uses the
  // same weighted-average cost the sale side posted.
  const itemIds = [...new Set(itemByRemote.values())];
  const costById = new Map<string, bigint>();
  if (itemIds.length > 0) {
    const { rows: stockRows } = await client.query<{ item_id: string; unit_cost: string | null }>(
      `SELECT item_id, unit_cost::text FROM item_stock WHERE item_id = ANY($1::uuid[]) AND unit_cost IS NOT NULL FOR UPDATE`,
      [itemIds],
    );
    for (const r of stockRows) costById.set(r.item_id, BigInt(r.unit_cost as string));
  }

  let recoveredCogsRial = "0";

  if (orderId) {
    for (const line of refund.line_items ?? []) {
      const itemId = itemByRemote.get(String(line.product_id));
      if (!itemId) continue;
      const qty = Math.max(0, Math.abs(Math.round(line.quantity ?? 0)));
      if (qty === 0) continue;

      // Find the order_items rows for this item, not yet fully returned.
      const { rows: items } = await client.query<{ id: string; quantity: string; returned: string }>(
        `SELECT oi.id, oi.quantity::text,
                COALESCE((SELECT sum(l.quantity)::text FROM customer_return_lines l
                           WHERE l.order_item_id = oi.id), '0') AS returned
           FROM order_items oi
          WHERE oi.order_id = $1 AND oi.item_id = $2 AND oi.status <> 'voided'
          ORDER BY oi.created_at, oi.id`,
        [orderId, itemId],
      );

      let remaining = qty;
      const unitCost = costById.get(itemId);
      for (const item of items) {
        if (remaining <= 0) break;
        const take = Math.min(Number(item.quantity) - Number(item.returned), remaining);
        if (take <= 0) continue;

        // Record the return line so a replayed refund delivery is idempotent.
        // We still insert into customer_return_lines even though we don't go
        // through the full createCustomerReturn path — it's the single source
        // of truth for "how much of this order item was returned".
        const { rows: returnRows } = await client.query<{ id: string }>(
          `INSERT INTO customer_returns
             (business_id, location_id, order_id, refund_method, refund_amount_rial, reason, created_by, idempotency_key)
           VALUES ($1, $2, $3, 'online', $4, $5, $6, $7)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [meta.businessId, meta.locationId, orderId, "0",
            `WooCommerce refund #${meta.remoteId}`, null,
            `woo-refund:${connection.id}:${meta.remoteId}`],
        );
        const returnId = returnRows[0]?.id;
        if (returnId) {
          await client.query(
            `INSERT INTO customer_return_lines (customer_return_id, order_item_id, quantity, disposition)
             VALUES ($1, $2, $3, 'restockable')
             ON CONFLICT DO NOTHING`,
            [returnId, item.id, String(take)],
          );
        }

        // Restock item_stock: add the returned quantity back.
        await client.query(
          `UPDATE item_stock SET quantity = quantity + $2, updated_at = now()
            WHERE item_id = $1`,
          [itemId, take],
        );

        // Reverse COGS if we have a cost basis.
        if (unitCost != null && unitCost > 0n) {
          recoveredCogsRial = (BigInt(recoveredCogsRial) + unitCost * BigInt(take)).toString();
        }

        remaining -= take;
      }
    }
  }

  // Post the COGS reversal to the trade's own COGS/inventory accounts.
  if (BigInt(recoveredCogsRial) > 0n) {
    const cogsAccounts = await accountIdsByCode(client, meta.businessId, [codes.cogs, codes.inventory]);
    await postExactJournalEntry(client, {
      businessId: meta.businessId,
      locationId: meta.locationId,
      memo: "برگشت بهای تمام‌شده فروش آنلاین",
      sourceType: "woocommerce_refund",
      sourceId: meta.inboxId,
      createdBy: null,
      postingKind: "cogs_reversal",
      lines: [
        { accountId: cogsAccounts.get(codes.inventory)!, debit: recoveredCogsRial as RialText, credit: zero },
        { accountId: cogsAccounts.get(codes.cogs)!, debit: zero, credit: recoveredCogsRial as RialText },
      ],
    });
  }

  // Post the money side.
  const accounts = await accountIdsByCode(client, meta.businessId, [
    WELL_KNOWN_CODES.salesReturns,
    WELL_KNOWN_CODES.vatPayable,
    WELL_KNOWN_CODES.bankClearing,
  ]);
  await postExactJournalEntry(client, {
    businessId: meta.businessId,
    locationId: meta.locationId,
    memo: `برگشت از فروش ووکامرس #${refund.id}`,
    sourceType: "woocommerce_refund",
    sourceId: meta.inboxId,
    createdBy: null,
    postingKind: "customer_refund",
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.salesReturns)!, debit: meta.net.toString() as RialText, credit: zero },
      ...(meta.tax > 0n
        ? [{ accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: meta.tax.toString() as RialText, credit: zero }]
        : []),
      { accountId: accounts.get(WELL_KNOWN_CODES.bankClearing)!, debit: zero, credit: meta.amount.toString() as RialText },
    ],
  });
}

/**
 * F&B refund: uses the existing `createCustomerReturn` path which reverses
 * inventory through `order_item_inventory_snapshots` → `stock_movements`.
 * Extracted from the old `ingestRefund` so the retail path can share the
 * outer dedup/mapping/audit structure without duplicating it.
 */
async function ingestFnBRefund(
  client: import("pg").PoolClient,
  connection: ConnectionRow,
  refund: WooRefund,
  meta: RefundMeta,
): Promise<void> {
  // Tie the refund to the imported order (via the order mapping) and, for
  // line items whose products were mapped at import time, reverse the
  // inventory deduction and COGS through the shared customer-return path —
  // exactly like a POS return. A refund that can't be tied to local order
  // items (unmapped at import, amount-only refund, unknown order) still
  // posts the money side.
  const { rows: orderRows } = await client.query<{ id: string }>(
    `SELECT local_id::text AS id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'order' AND remote_id = $3`,
    [meta.businessId, connection.id, String(refund.parent_id)],
  );
  const orderId = orderRows[0]?.id ?? null;
  const returnLines = orderId ? await buildRefundReturnLines(client, meta.businessId, connection, orderId, refund) : [];

  if (orderId && returnLines.length > 0) {
    await createCustomerReturn(client, {
      businessId: meta.businessId,
      locationId: meta.locationId,
      orderId,
      refundMethod: "online",
      refundAmount: meta.amount.toString() as RialText,
      reason: refund.reason?.trim() || "WooCommerce refund",
      idempotencyKey: `woo-refund:${connection.id}:${meta.remoteId}`,
      createdBy: null,
      lines: returnLines,
    });
  } else {
    const accounts = await accountIdsByCode(client, meta.businessId, [
      WELL_KNOWN_CODES.salesReturns,
      WELL_KNOWN_CODES.vatPayable,
      WELL_KNOWN_CODES.bankClearing,
    ]);
    await postExactJournalEntry(client, {
      businessId: meta.businessId,
      locationId: meta.locationId,
      memo: `برگشت از فروش ووکامرس #${refund.id}`,
      sourceType: "woocommerce_refund",
      sourceId: meta.inboxId,
      createdBy: null,
      postingKind: "customer_refund",
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.salesReturns)!, debit: meta.net.toString() as RialText, credit: zero },
        ...(meta.tax > 0n
          ? [{ accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: meta.tax.toString() as RialText, credit: zero }]
          : []),
        { accountId: accounts.get(WELL_KNOWN_CODES.bankClearing)!, debit: zero, credit: meta.amount.toString() as RialText },
      ],
    });
  }
}
