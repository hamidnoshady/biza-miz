/**
 * Phase 38 Wave 3 (issue #381) — what the website panel shows: every local
 * product with its sync mark and last push, and the outbox as a queue page.
 * DB-touching; the rules it displays are in `sync.ts`.
 */
import { query } from "../db";
import type { LocalProductKind, WebsiteOutboxKind } from "./sync";

export interface WebsiteCatalogRow {
  localKind: LocalProductKind;
  localId: string;
  name: string;
  sku: string | null;
  /** Integer Rial; `null` when unpriced. */
  priceRial: number | null;
  syncEnabled: boolean;
  remoteId: string | null;
  lastPushedAt: string | null;
  lastPushedPriceRial: number | null;
  lastPushedStock: number | null;
}

/**
 * Both product models, side by side (`menu_items` for F&B, `items` for
 * retail — they never merge).
 *
 * «Sellable» is one rule, the same one the till applies: the item is active
 * **and** sits in an active category. A branch's menu manager can retire a
 * whole category without touching its rows, and the POS index
 * (`buildRestaurantMenuIndex`) has always dropped those items from the
 * selling view — a website feed that kept listing them would sell something
 * the cashier cannot (issue #911). An item with no category is not listed
 * either, exactly as it is absent from every POS category.
 *
 * The retail half keeps the rule it already had: active rows with stock, and
 * never a variant parent (it has no price of its own, so it is not a product
 * on a site either).
 */
export async function listWebsiteCatalog(businessId: string, locationId: string): Promise<WebsiteCatalogRow[]> {
  const { rows } = await query<{
    local_kind: LocalProductKind;
    local_id: string;
    name: string;
    sku: string | null;
    price: string | null;
    sync_enabled: boolean | null;
    remote_id: string | null;
    last_pushed_at: string | null;
    last_pushed_price_rial: string | null;
    last_pushed_stock: string | null;
  }>(
    `WITH local AS (
       SELECT 'menu_item'::text AS local_kind, m.id AS local_id, m.name, m.sku, m.price::text AS price, m.sort_order, m.name AS sort_name
         FROM menu_items m
         JOIN menu_categories c ON c.id = m.category_id
        WHERE m.location_id = $2 AND m.is_active AND c.is_active
       UNION ALL
       SELECT 'item', i.id, i.name, i.sku, s.unit_price::text, 0, i.name
         FROM items i JOIN item_stock s ON s.item_id = i.id
        WHERE i.location_id = $2 AND i.is_active AND i.kind <> 'variant_parent'
     )
     SELECT l.local_kind, l.local_id, l.name, l.sku, l.price,
            m.sync_enabled, m.remote_id, m.last_pushed_at,
            m.last_pushed_price_rial::text, m.last_pushed_stock::text
       FROM local l
       LEFT JOIN website_product_map m
         ON m.business_id = $1 AND m.local_kind = l.local_kind AND m.local_id = l.local_id
      ORDER BY (m.sync_enabled IS TRUE) DESC, l.local_kind, l.sort_order, l.sort_name`,
    [businessId, locationId],
  );
  return rows.map((r) => ({
    localKind: r.local_kind,
    localId: r.local_id,
    name: r.name,
    sku: r.sku,
    priceRial: r.price === null ? null : Number(r.price),
    syncEnabled: r.sync_enabled === true,
    remoteId: r.remote_id,
    lastPushedAt: r.last_pushed_at,
    lastPushedPriceRial: r.last_pushed_price_rial === null ? null : Number(r.last_pushed_price_rial),
    lastPushedStock: r.last_pushed_stock === null ? null : Number(r.last_pushed_stock),
  }));
}

export interface WebsiteOutboxView {
  id: string;
  kind: WebsiteOutboxKind;
  localKind: LocalProductKind;
  localId: string;
  productName: string | null;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: string;
  error: string | null;
  sentAt: string | null;
  updatedAt: string;
}

export interface WebsiteQueueSummary {
  pending: number;
  failed: number;
  dead: number;
  sent24h: number;
}

export async function listWebsiteOutbox(
  businessId: string,
  status: "open" | "sent" | "all" = "open",
  limit = 100,
): Promise<WebsiteOutboxView[]> {
  const where =
    status === "open"
      ? `AND o.status IN ('pending', 'processing', 'failed', 'dead')`
      : status === "sent"
        ? `AND o.status = 'sent'`
        : "";
  const { rows } = await query<{
    id: string;
    kind: WebsiteOutboxKind;
    local_kind: LocalProductKind;
    local_id: string;
    product_name: string | null;
    status: WebsiteOutboxView["status"];
    attempts: number;
    next_attempt_at: string;
    error: string | null;
    sent_at: string | null;
    updated_at: string;
  }>(
    `SELECT o.id, o.kind, o.local_kind, o.local_id, o.status, o.attempts, o.next_attempt_at, o.error, o.sent_at, o.updated_at,
            CASE o.local_kind
              WHEN 'menu_item' THEN (SELECT name FROM menu_items WHERE id = o.local_id)
              ELSE (SELECT name FROM items WHERE id = o.local_id)
            END AS product_name
       FROM website_outbox o
      WHERE o.business_id = $1 ${where}
      ORDER BY CASE o.status WHEN 'dead' THEN 0 WHEN 'failed' THEN 1 WHEN 'processing' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END,
               o.updated_at DESC
      LIMIT $2`,
    [businessId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    localKind: r.local_kind,
    localId: r.local_id,
    productName: r.product_name,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    error: r.error,
    sentAt: r.sent_at,
    updatedAt: r.updated_at,
  }));
}

export async function summarizeWebsiteQueue(businessId: string): Promise<WebsiteQueueSummary> {
  const { rows } = await query<{ pending: string; failed: string; dead: string; sent24h: string }>(
    `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'processing'))::text AS pending,
            COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
            COUNT(*) FILTER (WHERE status = 'dead')::text AS dead,
            COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '24 hours')::text AS sent24h
       FROM website_outbox WHERE business_id = $1`,
    [businessId],
  );
  const r = rows[0];
  return { pending: Number(r?.pending ?? 0), failed: Number(r?.failed ?? 0), dead: Number(r?.dead ?? 0), sent24h: Number(r?.sent24h ?? 0) };
}
