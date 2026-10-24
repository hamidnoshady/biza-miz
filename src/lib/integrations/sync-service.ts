/**
 * Phase 23 (issue #118) — Wave 3: pull products and customers from a
 * WooCommerce store into the local menu/customer directory, remembering each
 * remote id in integration_mappings. DB-touching (not unit-tested directly).
 *
 * Since Phase 27 Wave 14 — products are routed to the right table by industry:
 * F&B (food_service) continues writing to `menu_items`; retail industries
 * (jewelry, watch, accessories, cosmetics) write to the shared `items` +
 * `item_stock` model, with variant/variable products mapped through
 * `integration_mappings` for parent-child linkage.
 *
 * Since Phase 38 — the pull covers the catalogue a store actually has, not
 * the subset `/products` happens to return:
 *
 *   - **variations**, from `products/{parent}/variations`. They were never
 *     fetched before, so a REST-connected store had no variation mapped and
 *     every variation line in every order resolved to nothing.
 *   - **the taxonomy tree** — categories, tags, attribute terms and the
 *     custom taxonomies only `wp/v2` publishes (see woo-taxonomy-service.ts).
 *   - **every product type**, through woo-catalogue.ts's shape table, so a
 *     grouped shelf, an external/affiliate listing or a bundle stops being
 *     an unhandled `type` string.
 *   - **orders**, pulled on a schedule as well as pushed by webhook, because
 *     an unconfigured webhook is a sale that never appears anywhere.
 *
 * Writes are planned in two passes (containers first, then the variations
 * that hang off them) so a page that lists a child before its parent cannot
 * lose it the way the one-at-a-time version did.
 */
import { randomUUID } from "node:crypto";
import { getPool, query, withTenant, withTenantTransaction } from "../db";
import { isUuid } from "../uuid";
import { insertPriceHistory, recordPriceHistory } from "../price-history";
import { changeMenuItemPrice } from "../menu-price-service";
import { getBusinessIndustry } from "../industry-guard";
import { hasSellableCatalogue, isRetailCatalogueIndustry } from "../industries";
import { getConnection, wooClientFor, type ConnectionRow } from "./connections-service";
import {
  createForRemoteOnce,
  listMappings,
  localIdForRemote,
  mergeMappingMeta,
  upsertMapping,
} from "./mapping-service";
import { wooAmountToRial } from "./woo-money";
import { writeIntegrationAudit } from "./audit";
import {
  externalCustomerResolution,
  markWooCustomerVerifiedAbsent,
  reconcileExternalIdentity,
} from "../crm-external-identity";
import {
  inferWooProductType,
  isSellableWooProduct,
  NON_SELLABLE_WOO_TYPE_STRINGS,
  planWooCatalogueWrite,
  UNTRACKED_WOO_TYPE_STRINGS,
  VARIATION_WOO_TYPE_STRINGS,
  wooProductShape,
  wooVariationAttributes,
  wooVariationDisplayName,
} from "./woo-catalogue";
import {
  ensureMenuCategory,
  pruneOrphanProductTerms,
  recordProductTermsFromPayload,
  syncTaxonomyTree,
  type TaxonomySyncOutcome,
} from "./woo-taxonomy-service";
import { WooCommerceError, type WooCustomer, type WooProduct, type WooVariationAttribute } from "./woocommerce-client";

const PER_PAGE = 100;

async function resolveLocationId(businessId: string, locationId: string | null): Promise<string> {
  if (locationId) return locationId;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  if (!rows[0]) throw new Error("no_location");
  return rows[0].id;
}

export interface SyncOutcome {
  created: number;
  updated: number;
  total: number;
}

export type CustomerUpsertOutcome =
  | "created"
  | "updated"
  | "linked"
  | "unresolved"
  | "conflicted"
  | "skipped";

export interface CatalogueSyncOutcome extends SyncOutcome {
  /** Variations pulled from their parents and written as sellable children. */
  variations: number;
  /** Containers (variable/grouped) recorded, not sellable. */
  containers: number;
  /** Products the store listed but this app has no shape for. Always 0 today. */
  skipped: number;
  /**
   * Products that failed to write, and the (capped) list of their remote ids.
   * A sync that imported 90 of 100 products is not a success that may report
   * itself as one — issue #943: the count used to live only in the audit log
   * while the caller, the connection row and the UI all said "done".
   */
  failed: number;
  failureIds: string[];
  /** Variable parents whose `products/{parent}/variations` fetch itself failed. */
  variationFetchFailures: number;
  variationFailureIds: string[];
  /**
   * Mapped products this complete store read no longer saw — deleted in the
   * store, or moved to its trash (which the products endpoint does not
   * return). Their mappings are flagged `remoteMissing`, never removed: the
   * local row and its history belong to the accounting record, and a
   * truncated read must not be able to erase mappings (issue #943, item 5).
   * Only counted on a run with zero product and zero variation-fetch
   * failures; anything less saw only part of the store.
   */
  missingRemotely: number;
  /** The taxonomy tree's failure reason, when it could not be synced. */
  taxonomyError: string | null;
  /** True when anything at all failed — the UI's cue to say "partial". */
  partial: boolean;
  taxonomy?: TaxonomySyncOutcome;
}

/** How many failed remote ids a sync outcome carries before it just says "+N more". */
export const SYNC_FAILURE_ID_CAP = 50;

/**
 * The health a product sync may persist, decided by one pure rule.
 *
 * Full success clears `last_error`; anything less records *what* partially
 * failed — the old code stamped `status='active', last_error=NULL` even when
 * half the catalogue threw, which is how a broken store reported itself
 * healthy. A taxonomy-only partial passes the #939 tree error through bare
 * (`taxonomy_sync_…`): that prefix is the contract the taxonomies UI's
 * Persian mapping and the catalogue integration test assert. Product or
 * variation failures get the `products_sync_partial:` envelope listing every
 * failing axis.
 */
export function catalogueSyncHealth(outcome: {
  failed: number;
  variationFetchFailures: number;
  taxonomyError: string | null;
}): { partial: boolean; lastError: string | null } {
  const partial = outcome.failed > 0 || outcome.variationFetchFailures > 0 || outcome.taxonomyError !== null;
  if (!partial) return { partial: false, lastError: null };
  if (outcome.failed === 0 && outcome.variationFetchFailures === 0 && outcome.taxonomyError) {
    return { partial: true, lastError: outcome.taxonomyError.slice(0, 500) };
  }
  const parts: string[] = [];
  if (outcome.failed > 0) parts.push(`${outcome.failed} products failed`);
  if (outcome.variationFetchFailures > 0) parts.push(`${outcome.variationFetchFailures} variation fetches failed`);
  if (outcome.taxonomyError) parts.push(`taxonomy: ${outcome.taxonomyError}`);
  return { partial: true, lastError: `products_sync_partial: ${parts.join("; ")}`.slice(0, 500) };
}

/** The branch this connection writes into, resolved once per sync. */
export async function connectionLocationId(connection: ConnectionRow): Promise<string> {
  return resolveLocationId(connection.business_id, connection.location_id);
}

// ---------------------------------------------------------------------------
// One product in
// ---------------------------------------------------------------------------

/**
 * One WooCommerce product -> one local row, routed by the business's industry.
 *
 * Split out of `syncProducts` because there are now three ways a product
 * arrives: pulled by the app over REST, pushed by the WordPress plugin as an
 * event, or delivered by a webhook. All three must land identically — same
 * price conversion, same mapping row, same create-vs-update decision — so
 * they all call this rather than each carrying its own copy of the rule.
 *
 * F&B (`food_service`) writes `menu_items` (recipe-based). Retail
 * industries (jewelry, watch, accessories, cosmetics) write the shared
 * `items` + `item_stock` model, with the type deciding the row's kind:
 *
 * | Woo type   | retail `items.kind` | F&B            |
 * |------------|---------------------|----------------|
 * | simple     | simple              | menu_items row |
 * | variation  | variant_child       | menu_items row |
 * | variable   | variant_parent      | skipped        |
 * | grouped    | variant_parent      | skipped        |
 * | external   | simple, no stock    | menu_items row |
 * | bundle /   | simple              | menu_items row |
 * | composite /|                     |                |
 * | subscription / anything else |    |                |
 *
 * Containers are skipped in F&B because `menu_items` has no parent/child
 * concept to put them in — writing one would put an unsellable «تی‌شرت» in
 * the menu beside its three sellable variations.
 */
export async function upsertProductFromWoo(
  connection: ConnectionRow,
  locationId: string,
  product: WooProduct,
): Promise<"created" | "updated" | "skipped"> {
  const industry = await getBusinessIndustry(connection.business_id);
  // Issue #799 Wave 11: the branch is the industry *family*, not "not F&B". A
  // business with no sellable catalogue (the architecture/construction trade
  // today, a service trade tomorrow) has nowhere for a web-store product to
  // land — `items` and `menu_items` are both the wrong shape — so the product
  // is skipped rather than written as a retail row.
  if (isRetailCatalogueIndustry(industry)) {
    return upsertRetailProduct(connection, locationId, product);
  }
  if (industry === "food_service") {
    return upsertFnbProduct(connection, locationId, product);
  }
  return "skipped";
}

/**
 * F&B: one sellable WooCommerce product -> one `menu_items` row.
 *
 * Two Phase 38 changes. A container (`variable`, `grouped`) is skipped — see
 * the table above. And a variation's menu item is named after its attributes
 * («تی‌شرت • رنگ: قرمز، سایز: L»), because the store's own `name` for a
 * variation is often just the parent's name again, and a menu with «تی‌شرت»
 * three times is unusable.
 */
async function upsertFnbProduct(
  connection: ConnectionRow,
  locationId: string,
  product: WooProduct,
): Promise<"created" | "updated" | "skipped"> {
  const businessId = connection.business_id;
  const shape = wooProductShape(inferWooProductType(product));
  if (shape.container) return "skipped";

  const attributes = wooVariationAttributes(product);
  const name = attributes.length ? wooVariationDisplayName(product.name, attributes) : product.name;
  const price = wooAmountToRial(product.regular_price || product.price || "0", connection.currency_unit);
  const remoteId = String(product.id);

  const applyUpdate = async (existing: string): Promise<"updated"> => {
    // name/sku stay a plain update; the price is a canonical price change
    // (issue #844): locked, validated, written to the current price and to
    // immutable history + audit together, `source = 'integration'` naming this
    // WooCommerce connection. An unchanged price writes no history row.
    await query(
      `UPDATE menu_items SET name = $3, sku = $4, updated_at = now()
        WHERE id = $1 AND location_id = $2`,
      [existing, locationId, name, product.sku || null],
    );
    const change = await changeMenuItemPrice({
      businessId,
      locationId,
      menuItemId: existing,
      newPrice: Number(price),
      source: "integration",
      changedBy: null,
      sourceRef: `woocommerce:${connection.id}`,
    });
    if (!change.ok) throw new Error(change.error);
    await recordProductShape(connection, product);
    return "updated";
  };

  const existing = await localIdForRemote(businessId, connection.id, "product", remoteId);
  if (existing) return applyUpdate(existing);

  const categoryId = await categoryForProduct(connection, locationId, product);
  // Created under the identity lock (audit F13): a second delivery of the same
  // new product waits here and then applies itself as an update.
  const outcome = await createForRemoteOnce(businessId, connection.id, "product", remoteId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO menu_items (location_id, category_id, name, sku, price)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [locationId, categoryId, name, product.sku || null, price.toString()],
    );
    return rows[0].id;
  });
  if (!outcome.created) return applyUpdate(outcome.localId);
  await recordProductShape(connection, product);
  return "created";
}

/** Retail: route every WooCommerce product type into the `items` model. */
async function upsertRetailProduct(
  connection: ConnectionRow,
  locationId: string,
  product: WooProduct,
): Promise<"created" | "updated" | "skipped"> {
  const businessId = connection.business_id;
  const shape = wooProductShape(inferWooProductType(product));
  const price = wooAmountToRial(product.regular_price || product.price || "0", connection.currency_unit);
  // WooCommerce reports null stock_quantity when a product does not manage
  // stock, and an `external` product never manages stock at all — it is sold
  // on someone else's site, so recording a quantity would be inventing
  // inventory. Both start at zero and count up as receipts land in the app.
  const stockQuantity =
    shape.stockTracked && product.manage_stock && product.stock_quantity != null
      ? Math.max(0, product.stock_quantity)
      : 0;
  const attributes = wooVariationAttributes(product);
  const name =
    shape.itemKind === "variant_child" && attributes.length
      ? wooVariationDisplayName(product.name, attributes)
      : product.name;
  const remoteId = String(product.id);

  const applyUpdate = async (existing: string): Promise<"updated"> => {
    await query(
      `UPDATE items SET name = $3, sku = $4, updated_at = now()
        WHERE id = $1 AND location_id = $2`,
      [existing, locationId, name, product.sku || null],
    );
    // A container is not sellable — it carries no stock/price of its own.
    if (!shape.container) {
      await upsertItemStock(existing, remoteManagesStock(shape, product) ? stockQuantity : null, price, {
        businessId,
        locationId,
      });
    }
    if (attributes.length) {
      await replaceVariantAttributes(existing, attributes);
    }
    await recordProductShape(connection, product);
    return "updated";
  };

  const existing = await localIdForRemote(businessId, connection.id, "product", remoteId);
  if (existing) return applyUpdate(existing);

  // Every create below runs under the identity lock (audit F13): a second
  // delivery of the same new product waits, finds the first one's mapping and
  // applies its payload as an update instead of inserting a twin item.
  if (shape.container) {
    const outcome = await createForRemoteOnce(businessId, connection.id, "product", remoteId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO items (location_id, name, sku, kind, tracking)
         VALUES ($1, $2, $3, 'variant_parent', 'none') RETURNING id`,
        [locationId, name, product.sku || null],
      );
      return rows[0].id;
    });
    if (!outcome.created) return applyUpdate(outcome.localId);
    await recordProductShape(connection, product);
    return "created";
  }

  const isVariation = shape.itemKind === "variant_child";
  let parentItemId: string | null = null;
  if (isVariation && product.parent_id) {
    parentItemId = await localIdForRemote(businessId, connection.id, "product", String(product.parent_id));
    // A variation can still arrive before its parent — a plugin push of a
    // batch that a hook ordered oddly, or a webhook that fired for the child
    // first. Fail this one so the caller retries; the two-pass planning in
    // syncProducts means the parent is written first in the normal case.
    if (!parentItemId) throw new Error("parent_variant_not_found");
  }

  // Item + stock + attributes + mapping in one transaction, so a retry after a
  // partial failure cannot orphan a stock row or duplicate a variant.
  const outcome = await createForRemoteOnce(businessId, connection.id, "product", remoteId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO items (location_id, parent_item_id, name, sku, kind, tracking)
       VALUES ($1, $2, $3, $4, $5, 'none') RETURNING id`,
      [locationId, parentItemId, name, product.sku || null, shape.itemKind],
    );
    const itemId = rows[0].id;
    await client.query(
      `INSERT INTO item_stock (item_id, quantity, unit_price, remote_snapshot_at)
       VALUES ($1, $2, $3, $4)`,
      [itemId, stockQuantity, price > 0n ? Number(price) : null, remoteManagesStock(shape, product) ? new Date().toISOString() : null],
    );
    // The store's opening price is a price fact too: record it in the same
    // transaction with a null "old", so a later sync change has a baseline.
    if (price > 0n && !shape.container) {
      await insertPriceHistory(client, [
        {
          businessId,
          locationId,
          itemId,
          priceKind: "sale",
          oldPrice: null,
          newPrice: Number(price),
          source: "sync",
          reason: "woocommerce_product_created",
        },
      ]);
    }
    for (const attr of attributes) {
      await client.query(
        `INSERT INTO item_variant_attributes (item_id, name, value) VALUES ($1, $2, $3)`,
        [itemId, attr.name, attr.option],
      );
    }
    return itemId;
  });
  if (!outcome.created) return applyUpdate(outcome.localId);
  await recordProductShape(connection, product);
  return "created";
}

/**
 * Remember what a remote product *is*, not just what it maps to.
 *
 * Two facts live here. The parent id, because a later stock/price push to a
 * variation has to go to `products/{parent}/variations/{id}` — without it
 * every push to a variation 404s its way to the dead-letter queue. And the
 * type, so the dashboard can say «متغیر» / «ساده» next to a row instead of
 * showing a bare name.
 *
 * Issue #943 adds the store's *last-seen presentation* of the product — its
 * publish status, whether it manages stock, and its regular/sale price in
 * Rial — so the products page can show «what the store says» beside «what
 * Accounting says» instead of one ambiguous number. This is a snapshot of the
 * remote at sync time, never a source of truth for either side.
 */
async function recordProductShape(connection: ConnectionRow, product: WooProduct): Promise<void> {
  // The primary image is the lowest-position one WooCommerce returns; the
  // mirror is display-only (issue #943) — the app never uploads through it
  // and never sends it back to the store. Upload/attachment transport is
  // #941's canonical mapping, which has not landed (see the policy doc).
  const images = (product.images ?? []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const primary = images[0] ?? null;
  const meta: Record<string, unknown> = {
    wooType: inferWooProductType(product),
    remoteParentId: product.parent_id ? String(product.parent_id) : null,
    remoteStatus: typeof product.status === "string" && product.status ? product.status : null,
    remoteManageStock: Boolean(product.manage_stock),
    remoteRegularPriceRial: safeWooPriceToRial(product.regular_price, connection.currency_unit),
    remoteSalePriceRial: safeWooPriceToRial(product.sale_price ?? "", connection.currency_unit),
    remoteImageSrc: primary && typeof primary.src === "string" && primary.src ? primary.src : null,
    remoteImageAlt: primary && typeof primary.alt === "string" ? primary.alt : null,
    remoteGalleryCount: images.length,
    // Seeing the product in any inbound payload — a sync page, a webhook —
    // clears a stale "the store no longer lists this" flag (issue #943).
    remoteMissing: false,
  };
  await mergeMappingMeta(connection.business_id, connection.id, "product", String(product.id), meta);
  // Upsert the product's category/tag terms into the taxonomy mirror AND
  // record the product→term assignments. In plugin mode the app cannot dial
  // the store, so these inline terms are the *only* way the taxonomy mirror
  // is ever populated — before this, a plugin-connected store's categories
  // column and taxonomy browser stayed empty no matter how many products
  // synced. See upsertTermFromPayload for why upsert rather than replace.
  //
  // A variation inherits its parent's terms for any taxonomy its own payload
  // says nothing about (issue #939 TAX-06) — WooCommerce's REST variation
  // resource carries no categories at all, so without the inheritance inside
  // recordProductTermsFromPayload every REST variation was recorded as
  // belonging to nothing while its parent sat in three categories.
  await recordProductTermsFromPayload(connection.business_id, connection.id, String(product.id), product);
}

/** A remote price string → integer Rial, or null when absent/malformed. */
function safeWooPriceToRial(amount: string | undefined | null, unit: ConnectionRow["currency_unit"]): string | null {
  const text = String(amount ?? "").trim();
  if (!text) return null;
  try {
    return wooAmountToRial(text, unit).toString();
  } catch {
    return null;
  }
}

/**
 * The F&B category bridge, when the owner has turned it on.
 *
 * Off by default: copying a store's categories into a menu someone curated
 * by hand is a decision, not an upgrade side effect.
 */
async function categoryForProduct(
  connection: ConnectionRow,
  locationId: string,
  product: WooProduct,
): Promise<string | null> {
  if (!connection.sync_categories) return null;
  const first = product.categories?.[0];
  if (!first) return null;
  try {
    return await ensureMenuCategory(connection.business_id, connection.id, locationId, {
      remoteId: String(first.id),
      name: first.name,
      slug: first.slug,
    });
  } catch {
    // A category that cannot be created must not lose the product; the item
    // simply lands uncategorised.
    return null;
  }
}

/**
 * Whether the store is the authority for this product's quantity. A product
 * that does not manage stock (or an `external` one) reports no quantity, so
 * the local shelf — counted up by receipts in this app — must not be reset
 * to zero by every product sync, as it used to be.
 */
function remoteManagesStock(shape: ReturnType<typeof wooProductShape>, product: WooProduct): boolean {
  return Boolean(shape.stockTracked && product.manage_stock && product.stock_quantity != null);
}

/**
 * Upsert a retail item's shelf price (Rial) and — when the store manages the
 * product's stock — its on-hand quantity as an absolute snapshot.
 *
 * A snapshot stamps `remote_snapshot_at` with the moment it was applied: the
 * online sale service compares a remote order's instant against it so a sale
 * the store already deducted is not relieved a second time (dashboard audit
 * F03; `decideOnlineStockRelief`). `quantity = null` updates the price only.
 */
async function upsertItemStock(
  itemId: string,
  quantity: number | null,
  price: bigint,
  audit: { businessId: string; locationId: string },
): Promise<void> {
  const unitPrice = price > 0n ? Number(price) : null;
  // `previous` sees the row as it was before this statement, so the returned
  // old/new pair is exact and the history row can be written from the same
  // statement's result (issue #924 F07 — sync is a first-class price source).
  const statement =
    quantity == null
      ? `WITH previous AS (
           SELECT unit_price FROM item_stock WHERE item_id = $1
         ), upserted AS (
           INSERT INTO item_stock (item_id, quantity, unit_price)
           VALUES ($1, 0, $2)
           ON CONFLICT (item_id) DO UPDATE SET unit_price = EXCLUDED.unit_price, updated_at = now()
           RETURNING unit_price
         )
         SELECT previous.unit_price::text AS old_price, upserted.unit_price::text AS new_price
           FROM upserted LEFT JOIN previous ON true`
      : `WITH previous AS (
           SELECT unit_price FROM item_stock WHERE item_id = $1
         ), upserted AS (
           INSERT INTO item_stock (item_id, quantity, unit_price, remote_snapshot_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (item_id) DO UPDATE
             SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price,
                 remote_snapshot_at = now(), updated_at = now()
           RETURNING unit_price
         )
         SELECT previous.unit_price::text AS old_price, upserted.unit_price::text AS new_price
           FROM upserted LEFT JOIN previous ON true`;

  const params = quantity == null ? [itemId, unitPrice] : [itemId, quantity, unitPrice];
  const { rows } = await query<{ old_price: string | null; new_price: string | null }>(statement, params);
  const row = rows[0];
  if (!row || unitPrice == null) return;
  const oldPrice = row.old_price == null ? null : Number(row.old_price);
  if (oldPrice === unitPrice) return;

  await recordPriceHistory([
    {
      businessId: audit.businessId,
      locationId: audit.locationId,
      itemId,
      priceKind: "sale",
      oldPrice,
      newPrice: unitPrice,
      source: "sync",
      reason: "woocommerce_product_sync",
    },
  ]);
}

/** Replace a variation's attribute set (idempotent on re-delivery). */
async function replaceVariantAttributes(itemId: string, attributes: WooVariationAttribute[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM item_variant_attributes WHERE item_id = $1`, [itemId]);
    for (const attr of attributes) {
      if (!attr.name || !attr.option) continue;
      await client.query(
        `INSERT INTO item_variant_attributes (item_id, name, value) VALUES ($1, $2, $3)`,
        [itemId, attr.name, attr.option],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// One customer in
// ---------------------------------------------------------------------------

/**
 * One WooCommerce customer -> one local `customers` row.
 *
 * Phase 38 added the phone canonicalisation. The CRM merged in Phase 36c
 * keys duplicate detection, segments and sending on `customers.phone_e164`,
 * not on the typed string — four spellings of one number are four customers
 * to everything that compares text. Writing a WooCommerce customer's phone
 * unnormalised would have quietly created the duplicates the CRM exists to
 * find.
 *
 * Consent is never touched here. Buying something online is not permission to
 * market to someone; the CRM's rule is that consent is explicit, and no
 * import path is allowed to invent it.
 */
export async function upsertCustomerFromWoo(
  connection: ConnectionRow,
  customer: WooCustomer,
): Promise<CustomerUpsertOutcome> {
  const remoteId = String(customer.id ?? "").trim();
  if (!/^[1-9]\d*$/.test(remoteId)) throw new Error("invalid_customer_id");
  const result = await reconcileExternalIdentity(
    {
      businessId: connection.business_id,
      connectionId: connection.id,
      provider: "woocommerce",
      remoteId,
      name: `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() || null,
      email: customer.email?.trim() || customer.billing?.email?.trim() || null,
      phone: customer.billing?.phone ?? null,
      address: customer.billing?.address_1 ?? null,
      payload: customer as unknown as Record<string, unknown>,
      remoteUpdatedAt: customer.date_modified ?? null,
    },
    // A customer sync is an explicit "import these people" operation, so
    // creating the ones we do not have is the point of it.
    { allowCreate: true, actor: "همگام‌سازی فروشگاه" },
  );

  if (result.remoteDeletedAt || result.status === "ignored") return "skipped";
  if (result.status === "conflict") return "conflicted";
  if (result.created) return "created";
  if (!result.partyId) return "unresolved";
  if (result.reason === "unique_phone" || result.reason === "unique_email") return "linked";
  return "updated";
}

/**
 * Resolve the local customer an order belongs to — or **null** when nobody can
 * honestly say who that is.
 *
 * Null is a supported, deliberate answer. The previous implementation could
 * not return one: faced with two customers sharing a billing phone it took the
 * older record, so an order was always attributed to *somebody*, and when that
 * somebody was wrong nothing anywhere said so. The purchase then entered the
 * wrong person's history, their RFM score, and every segment and campaign
 * built on it.
 *
 * Now an ambiguous buyer parks the external profile in the reconciliation
 * queue and the order imports unattributed. The revenue still posts — the sale
 * happened and the ledger must show it — it simply is not claimed by a named
 * customer until a human claims it. A visible gap beats an invisible error.
 */
export async function resolveOrderCustomerId(
  connection: ConnectionRow,
  order: {
    customer_id?: number;
    billing?: {
      phone?: string;
      email?: string;
      first_name?: string;
      last_name?: string;
      address_1?: string;
      city?: string;
    };
  },
): Promise<string | null> {
  const businessId = connection.business_id;
  const remoteCustomerId = Number(order.customer_id ?? 0) || 0;

  // A profile, including an unresolved or ignored one, is authoritative over
  // the legacy mapping. Only a genuinely profile-less legacy identity may use
  // the compatibility lookup.
  if (remoteCustomerId > 0) {
    const remoteId = String(remoteCustomerId);
    const resolution = await externalCustomerResolution(businessId, connection.id, remoteId);
    if (resolution?.remoteDeletedAt) return null;
    if (resolution?.status === "ignored" || resolution?.status === "needs_review") return null;
    if (resolution?.partyId) return resolution.partyId;
    // A present unresolved profile is authoritative. Do not use an order's
    // historical billing snapshot to overwrite its current store snapshot or
    // create/attach a person behind the reconciliation queue. Legacy lookup is
    // only appropriate when the profile genuinely does not exist.
    if (resolution) return null;

    const { rows } = await query<{ local_id: string }>(
      `SELECT m.local_id::text AS local_id
         FROM integration_mappings m
         JOIN integration_connections c
           ON c.id = m.connection_id AND c.business_id = m.business_id AND c.provider = 'woocommerce'
         JOIN parties p ON p.id = m.local_id AND p.business_id = m.business_id
        WHERE m.business_id = $1 AND m.connection_id = $2
          AND m.entity_type = 'customer' AND m.remote_id = $3`,
      [businessId, connection.id, remoteId],
    );
    if (rows[0]) return rows[0].local_id;
  }

  const phone = order.billing?.phone?.trim() || null;
  const email = order.billing?.email?.trim().toLowerCase() || null;
  const name = `${order.billing?.first_name ?? ""} ${order.billing?.last_name ?? ""}`.trim();

  // A guest with no phone, no email and no store account is not a person this
  // system can identify. The order keeps their name in its note; inventing a
  // customer record would add a ghost nobody can ever match or contact.
  if (remoteCustomerId === 0 && !phone && !email) return null;

  const result = await reconcileExternalIdentity(
    {
      businessId,
      connectionId: connection.id,
      provider: "woocommerce",
      // Guests have no store id, so the profile is keyed by what identifies
      // them — otherwise every guest checkout would collide on the same row.
      remoteId: remoteCustomerId > 0 ? String(remoteCustomerId) : `guest:${phone ?? email}`,
      name,
      email,
      phone,
      address: order.billing?.address_1 ?? null,
      payload: { billing: order.billing ?? {} },
    },
    {
      // A buyer who matches nobody is not ambiguous — they are new, and
      // creating their record is what puts online sales into the customer
      // file, the RFM population and Growth's segments. The bug being fixed
      // here was never "creates customers"; it was "picks one when it cannot
      // tell", and `reconcileExternalIdentity` handles that by parking the
      // profile instead of guessing.
      //
      // Creation is still refused when there is nothing to identify the person
      // by (no phone, no email, no name) — see `insufficient_identity`. A
      // record nobody can ever match, deduplicate or contact is not a
      // customer, it is a ghost, and the order's note already carries the name.
      allowCreate: true,
      actor: "دریافت سفارش",
    },
  );

  return result.partyId;
}

// ---------------------------------------------------------------------------
// The pulls
// ---------------------------------------------------------------------------

/**
 * Full catalogue sync: products, then every variable product's variations,
 * then the taxonomy tree.
 *
 * Pass order matters. A variation cannot be inserted before its parent
 * (`items.parent_item_id`), and the pre-Phase-38 version discovered that one
 * product at a time — it threw, logged, and moved on, so a page that listed
 * a child first simply lost it until the next run. `planWooCatalogueWrite`
 * makes ordering a property of the whole page instead.
 */
export async function syncProducts(businessId: string, connectionId: string): Promise<CatalogueSyncOutcome> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  const client = wooClientFor(connection);
  const locationId = await resolveLocationId(businessId, connection.location_id);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let variations = 0;
  let containers = 0;
  let total = 0;
  const failures: string[] = [];
  const variationFetchFailures: string[] = [];
  /** Every remote id this run saw — the evidence base for the missing-remotely flag. */
  const seenRemoteIds = new Set<string>();

  const apply = async (product: WooProduct) => {
    total += 1;
    // Seen means the store listed it, even when writing it locally failed —
    // a failure is not evidence of absence.
    seenRemoteIds.add(String(product.id));
    try {
      const outcome = await upsertProductFromWoo(connection, locationId, product);
      if (outcome === "created") {
        created += 1;
        const shape = wooProductShape(inferWooProductType(product));
        if (shape.itemKind === "variant_child") variations += 1;
        if (shape.container) containers += 1;
      } else if (outcome === "updated") {
        updated += 1;
        const shape = wooProductShape(inferWooProductType(product));
        if (shape.itemKind === "variant_child") variations += 1;
        if (shape.container) containers += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      // A variation whose parent is not mapped yet (a plugin push out of
      // order, or a webhook for a child before its parent). Failing the whole
      // sync over it would also lose every product after it.
      failures.push(String(product.id));
      await writeIntegrationAudit({
        businessId,
        connectionId,
        action: "product.sync_failed",
        entityType: "product",
        remoteId: String(product.id),
        error: (err as Error).message,
      });
    }
  };

  // Pass 1 — everything /products returns, paged.
  const parents: WooProduct[] = [];
  let page = 1;
  for (;;) {
    const { items, totalPages } = await client.listProductsPage({ per_page: PER_PAGE, page });
    parents.push(...items);
    if (!totalPages || page >= totalPages || items.length === 0) break;
    page += 1;
  }

  const plan = planWooCatalogueWrite(parents);
  for (const product of plan.containers) await apply(product);
  for (const product of plan.sellables) await apply(product);
  for (const product of plan.skipped) await apply(product);

  // Pass 2 — variations. The endpoint that exists precisely because
  // /products does not include them.
  for (const parent of parents) {
    if (!isSellableWooProduct(parent) && inferWooProductType(parent) === "variable") {
      try {
        const children = await client.listVariations(parent.id);
        const childPlan = planWooCatalogueWrite(children);
        for (const child of [...childPlan.containers, ...childPlan.sellables]) {
          await apply(child);
        }
      } catch (err) {
        // A parent whose variations could not even be fetched: its children
        // are missing from this sync, and the outcome must say so rather
        // than report a clean run.
        variationFetchFailures.push(String(parent.id));
        await writeIntegrationAudit({
          businessId,
          connectionId,
          action: "product.variations_failed",
          entityType: "product",
          remoteId: String(parent.id),
          error: (err as Error).message,
        });
      }
    }
  }

  // Issue #939 TAX-04: the taxonomy sync reports its own per-taxonomy
  // outcomes, and this sync reports *them* — it no longer swallows a failed
  // or truncated tree behind a healthy catalogue stamp. A wholesale blowup
  // (the client itself failing) becomes an explicit `failed` outcome rather
  // than an absent one.
  let taxonomy: TaxonomySyncOutcome;
  try {
    taxonomy = await syncTaxonomyTree(businessId, connectionId, client);
  } catch (err) {
    const message = (err as Error).message;
    taxonomy = {
      taxonomies: [],
      terms: 0,
      truncated: false,
      failed: [],
      status: "failed",
      results: [],
      discoveryErrors: [{ stage: "taxonomies", error: message }],
    };
    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "taxonomy.sync_failed",
      error: message,
    });
  }

  // TAX-07: assignments whose product no longer has a mapping (deleted in the
  // store and unmapped here) are dead weight and stale counts; the catalogue
  // pass is the natural moment to sweep them.
  let prunedAssignments = 0;
  try {
    prunedAssignments = await pruneOrphanProductTerms(businessId, connectionId);
  } catch (err) {
    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "taxonomy.prune_failed",
      error: (err as Error).message,
    });
  }

  // One truthful health for both audits (#943 products + #939 TAX): the
  // taxonomy tree reports its own per-taxonomy outcome, the products pass
  // reports its per-product outcome, and one pure rule (catalogueSyncHealth)
  // folds them into what the connection row persists. A partial tree or
  // partial products leave `last_error` naming the failure — "active, no
  // error" over half-synced data was exactly the silent partial success both
  // audits call out — and only a fully clean run clears it.
  const taxonomyError =
    taxonomy.status === "complete"
      ? null
      : `taxonomy_sync_${taxonomy.status}${
          taxonomy.failed.length ? `:${taxonomy.failed.slice(0, 3).join(",")}` : ""
        }`;

  // Removed remote products (issue #943, item 5): a complete, failure-free
  // read that never saw a mapped product means the store deleted it (or
  // trashed it — the products endpoint does not return trash). The mapping
  // is FLAGGED, never removed: a truncated or partially failed read must not
  // be able to erase accounting history, and the flag clears itself the
  // moment any payload sees the product again.
  let missingRemotely = 0;
  if (failures.length === 0 && variationFetchFailures.length === 0) {
    try {
      missingRemotely = await flagProductsMissingRemotely(businessId, connectionId, [...seenRemoteIds]);
      if (missingRemotely > 0) {
        await writeIntegrationAudit({
          businessId,
          connectionId,
          action: "product.missing_remotely",
          entityType: "product",
          payload: { count: missingRemotely },
        });
      }
    } catch (err) {
      // The flag is information, not integrity: a failure to write it must
      // not fail the sync that just did its job.
      await writeIntegrationAudit({
        businessId,
        connectionId,
        action: "product.missing_remotely_failed",
        entityType: "product",
        error: (err as Error).message,
      });
    }
  }

  const outcome: CatalogueSyncOutcome = {
    created,
    updated,
    skipped,
    variations,
    containers,
    total,
    failed: failures.length,
    failureIds: failures.slice(0, SYNC_FAILURE_ID_CAP),
    variationFetchFailures: variationFetchFailures.length,
    variationFailureIds: variationFetchFailures.slice(0, SYNC_FAILURE_ID_CAP),
    missingRemotely,
    taxonomyError,
    partial: false,
    taxonomy,
  };
  const health = catalogueSyncHealth(outcome);
  outcome.partial = health.partial;

  // The products did sync, so the connection recovers to `active` — unless
  // the owner paused it; a sync must never silently unpause (that is the
  // owner's decision, and why this is a CASE and not a flat assignment).
  await query(
    `UPDATE integration_connections
        SET last_sync_at = now(), last_catalogue_sync_at = now(),
            status = CASE WHEN status = 'paused' THEN status ELSE 'active' END,
            last_error = $3, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, connectionId, health.lastError],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "products.synced",
    payload: {
      created,
      updated,
      skipped,
      variations,
      containers,
      total,
      failures: failures.length,
      failureIds: outcome.failureIds,
      variationFetchFailures: variationFetchFailures.length,
      taxonomyError,
      partial: health.partial,
      prunedAssignments,
      taxonomy,
    },
  });
  return outcome;
}

/**
 * Pull recent orders the store has, and feed them through the same ingest a
 * webhook delivery goes through.
 *
 * Why this exists: webhooks are the fast path, and they are also the one
 * thing an owner has to configure by hand in a second system. A store whose
 * webhook was never set up — or whose webhook 404'd for a week — was silently
 * missing sales, with nothing anywhere to say so. A scheduled pull over the
 * same path means a missed webhook becomes a late order rather than a lost
 * one.
 *
 * The delivery id is derived from the order's own `date_modified`, so an
 * unchanged order re-pulled is a duplicate (free, by the inbox's unique key)
 * while an order that changed since the last pull is re-ingested — and then
 * dropped at the order level by its mapping row, because `order.updated`
 * after `order.created` is a no-op.
 */
export async function syncOrders(
  businessId: string,
  connectionId: string,
  options: { sinceDays?: number; maxPages?: number } = {},
): Promise<{ imported: number; duplicates: number; failed: number; total: number }> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  if (!connection.sync_orders) {
    return { imported: 0, duplicates: 0, failed: 0, total: 0 };
  }
  const client = wooClientFor(connection);
  const { ingestRemoteOrder } = await import("./webhook-ingest-service");

  const days = options.sinceDays ?? connection.order_lookback_days ?? 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let imported = 0;
  let duplicates = 0;
  let failed = 0;
  let total = 0;
  let page = 1;

  for (;;) {
    // Paged with the store's X-WP-TotalPages header, not guessed from a full
    // last page: the old short-page stop also ended the loop one page early
    // whenever the store's last page happened to hold exactly `per_page`
    // rows, which is how some orders "synced" and the rest never did.
    //
    // No status filter here, deliberately. The ingest's own
    // `shouldImportWooOrder` gate decides what becomes a sale, and filtering
    // at the source would silently drop a store whose automation moves
    // orders straight from pending to a custom paid status — a state this
    // app has never heard of is a sale, not something to skip. Unpaid orders
    // cost one inbox row and nothing else: their watermark only changes when
    // the store touches them.
    const { items: orders, totalPages } = await client.listOrdersPage({
      per_page: PER_PAGE,
      page,
      after: since,
      orderby: "date",
      order: "asc",
    });
    if (!Array.isArray(orders) || orders.length === 0) break;
    for (const order of orders) {
      total += 1;
      const watermark = order.date_modified || order.date_created || "";
      const outcome = await ingestRemoteOrder(connection, order, `pull:${connection.id}:${order.id}:${watermark}`);
      if (outcome.status === "processed") imported += 1;
      else if (outcome.status === "duplicate") duplicates += 1;
      else failed += 1;
    }
    if (!totalPages || page >= totalPages) break;
    page += 1;
    if (options.maxPages && page > options.maxPages) break;
  }

  await query(
    `UPDATE integration_connections
        SET last_sync_at = now(), last_order_sync_at = now(),
            status = 'active', last_error = NULL, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, connectionId],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "orders.synced",
    payload: { imported, duplicates, failed, total, sinceDays: days },
  });
  return { imported, duplicates, failed, total };
}

export interface CustomerSyncRunOutcome {
  runId: string;
  status: "running" | "partial" | "completed" | "failed";
  currentPage: number;
  totalPages: number | null;
  expected: number | null;
  created: number;
  updated: number;
  linked: number;
  unresolved: number;
  conflicted: number;
  skipped: number;
  deleted: number;
  failed: number;
  total: number;
  hasMore: boolean;
  lastError: string | null;
}

const CUSTOMER_SYNC_PAGES_PER_REQUEST = 3;

async function customerSyncRunSummary(
  businessId: string,
  connectionId: string,
  runId: string,
): Promise<CustomerSyncRunOutcome> {
  const [{ rows: runRows }, { rows: countRows }] = await Promise.all([
    query<{
      status: CustomerSyncRunOutcome["status"];
      current_page: number;
      total_pages: number | null;
      expected_count: number | null;
      last_error: string | null;
    }>(
      `SELECT status, current_page, total_pages, expected_count, last_error
         FROM integration_customer_sync_runs
        WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
      [businessId, connectionId, runId],
    ),
    query<{
      created: number;
      updated: number;
      linked: number;
      unresolved: number;
      conflicted: number;
      skipped: number;
      deleted: number;
      failed: number;
      total: number;
    }>(
      `SELECT count(*) FILTER (WHERE outcome = 'created')::int AS created,
              count(*) FILTER (WHERE outcome = 'updated')::int AS updated,
              count(*) FILTER (WHERE outcome = 'linked')::int AS linked,
              count(*) FILTER (WHERE outcome = 'unresolved')::int AS unresolved,
              count(*) FILTER (WHERE outcome = 'conflicted')::int AS conflicted,
              count(*) FILTER (WHERE outcome = 'skipped')::int AS skipped,
              count(*) FILTER (WHERE outcome = 'deleted')::int AS deleted,
              count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
              count(*)::int AS total
         FROM integration_customer_sync_run_items
        WHERE business_id = $1 AND connection_id = $2 AND run_id = $3`,
      [businessId, connectionId, runId],
    ),
  ]);
  const run = runRows[0];
  if (!run) throw new Error("customer_sync_run_not_found");
  const counts = countRows[0];
  return {
    runId,
    status: run.status,
    currentPage: run.current_page,
    totalPages: run.total_pages,
    expected: run.expected_count,
    created: counts.created,
    updated: counts.updated,
    linked: counts.linked,
    unresolved: counts.unresolved,
    conflicted: counts.conflicted,
    skipped: counts.skipped,
    deleted: counts.deleted,
    failed: counts.failed,
    total: counts.total,
    // Both page batches and the exact-id absence verification can span more
    // than one request. A clean partial run is resumable; only an explicit
    // error or failed customer stops automatic continuation.
    hasMore: run.status !== "completed" && run.last_error === null && counts.failed === 0,
    lastError: run.last_error,
  };
}

async function recordCustomerSyncRunItem(
  businessId: string,
  connectionId: string,
  runId: string,
  remoteId: string,
  outcome: CustomerUpsertOutcome | "deleted" | "failed",
  error?: string,
): Promise<void> {
  await query(
    `INSERT INTO integration_customer_sync_run_items
       (run_id, business_id, connection_id, remote_id, outcome, error)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id, remote_id) DO UPDATE
       SET outcome = EXCLUDED.outcome,
           error = EXCLUDED.error,
           attempts = integration_customer_sync_run_items.attempts + 1,
           updated_at = now()`,
    [runId, businessId, connectionId, remoteId, outcome, error?.slice(0, 500) ?? null],
  );
}

/** Track each row in a plugin full-export run. The plugin tags snapshot rows
 * with this run id; ordinary customer.updated events remain independent. */
export async function recordPluginCustomerSyncItem(
  connection: ConnectionRow,
  runId: string,
  remoteId: string,
  outcome: CustomerUpsertOutcome | "failed",
  error?: string,
): Promise<void> {
  if (connection.provider !== "woocommerce" || !isUuid(runId)) {
    throw new Error("invalid_customer_sync_run_id");
  }
  await withTenantTransaction(connection.business_id, async () => {
    await query(
      `INSERT INTO integration_customer_sync_runs
         (id, business_id, connection_id, transport, status)
       VALUES ($1, $2, $3, 'plugin', 'running')
       ON CONFLICT (id) DO NOTHING`,
      [runId, connection.business_id, connection.id],
    );
    const { rows: owned } = await query<{ expected_count: number | null }>(
      `SELECT expected_count FROM integration_customer_sync_runs
        WHERE id = $1 AND business_id = $2 AND connection_id = $3 AND transport = 'plugin'`,
      [runId, connection.business_id, connection.id],
    );
    if (!owned[0]) throw new Error("customer_sync_run_connection_mismatch");

    await recordCustomerSyncRunItem(
      connection.business_id,
      connection.id,
      runId,
      remoteId,
      outcome,
      error,
    );
    await refreshPluginCustomerSyncRun(connection, runId, owned[0].expected_count);
  });
}

/** An export marker is only complete when every expected event succeeded. */
export async function completePluginCustomerSync(
  connection: ConnectionRow,
  runId: string,
  expectedCount: number,
): Promise<boolean> {
  if (
    connection.provider !== "woocommerce" || !isUuid(runId) ||
    !Number.isInteger(expectedCount) || expectedCount < 0 || expectedCount > 1_000_000
  ) {
    throw new Error("invalid_customer_sync_marker");
  }
  return withTenantTransaction(connection.business_id, async () => {
    await query(
      `INSERT INTO integration_customer_sync_runs
         (id, business_id, connection_id, transport, status)
       VALUES ($1, $2, $3, 'plugin', 'running')
       ON CONFLICT (id) DO NOTHING`,
      [runId, connection.business_id, connection.id],
    );
    const { rows } = await query<{ expected_count: number | null }>(
      `UPDATE integration_customer_sync_runs
          SET expected_count = $4, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND connection_id = $3
          AND transport = 'plugin'
          AND (expected_count IS NULL OR expected_count = $4)
        RETURNING expected_count`,
      [runId, connection.business_id, connection.id, expectedCount],
    );
    if (!rows[0]) throw new Error("customer_sync_marker_mismatch");
    return refreshPluginCustomerSyncRun(connection, runId, rows[0].expected_count);
  });
}

async function refreshPluginCustomerSyncRun(
  connection: ConnectionRow,
  runId: string,
  expectedCount: number | null,
): Promise<boolean> {
  const { rows } = await query<{ total: number; failed: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE outcome = 'failed')::int AS failed
       FROM integration_customer_sync_run_items
      WHERE business_id = $1 AND connection_id = $2 AND run_id = $3`,
    [connection.business_id, connection.id, runId],
  );
  const { total, failed } = rows[0];
  const complete = expectedCount !== null && total === expectedCount && failed === 0;
  const status = expectedCount === null
    ? "running"
    : complete
      ? "completed"
      : total > expectedCount
        ? "failed"
        : "partial";
  const lastError = status === "completed"
    ? null
    : failed > 0
      ? "customer_events_failed"
      : status === "failed"
        ? "customer_event_count_exceeded_expected"
        : expectedCount === null
          ? null
          : "customer_events_incomplete";
  await query(
    `UPDATE integration_customer_sync_runs
        SET status = $4,
            completed_at = CASE WHEN $4 = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END,
            last_error = $5,
            updated_at = now()
      WHERE id = $1 AND business_id = $2 AND connection_id = $3 AND transport = 'plugin'`,
    [runId, connection.business_id, connection.id, status, lastError],
  );
  if (complete) {
    await query(
      `UPDATE integration_connections
          SET last_sync_at = now(), last_customer_sync_at = now(), updated_at = now()
        WHERE business_id = $1 AND id = $2 AND provider = 'woocommerce'`,
      [connection.business_id, connection.id],
    );
  }
  return complete;
}

const CUSTOMER_ABSENCE_VERIFY_BATCH_SIZE = 99;
const CUSTOMER_SYNC_MAX_PAGE_RETRIES = 2;
const CUSTOMER_SYNC_MAX_INLINE_RETRY_MS = 2_000;

/** Retry short transient failures, but never keep an HTTP sync request open for a long Retry-After. */
async function listCustomersPageWithRetry(
  client: ReturnType<typeof wooClientFor>,
  params: { per_page: number; page: number; include?: string },
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.listCustomersPage(params);
    } catch (err) {
      const status = err instanceof WooCommerceError ? err.status : undefined;
      const retryable = status === undefined || status === 408 || status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt >= CUSTOMER_SYNC_MAX_PAGE_RETRIES) throw err;

      const retryAfterMs = err instanceof WooCommerceError ? err.retryAfterMs : null;
      if (retryAfterMs !== null && retryAfterMs > CUSTOMER_SYNC_MAX_INLINE_RETRY_MS) throw err;
      const backoffMs = Math.min(250 * 2 ** attempt, CUSTOMER_SYNC_MAX_INLINE_RETRY_MS);
      await new Promise((resolve) => setTimeout(resolve, Math.max(backoffMs, retryAfterMs ?? 0)));
    }
  }
}

/** Existing remote accounts absent from the completed offset snapshot, plus
 * failed snapshot rows that need one last exact-id retry. */
async function restCustomerAbsenceCandidates(
  businessId: string,
  connectionId: string,
  runId: string,
  runStartedAt: string,
): Promise<string[]> {
  const { rows } = await query<{ remote_id: string }>(
    `WITH known AS (
       SELECT p.remote_id
         FROM crm_external_profiles p
        WHERE p.business_id = $1 AND p.connection_id = $2 AND p.provider = 'woocommerce'
          AND p.remote_deleted_at IS NULL
          AND p.remote_id ~ '^[1-9][0-9]{0,14}$'
          AND (p.last_synced_at IS NULL OR p.last_synced_at < $3::timestamptz)
       UNION
       SELECT m.remote_id
         FROM integration_mappings m
         JOIN integration_connections c
           ON c.id = m.connection_id AND c.business_id = m.business_id AND c.provider = 'woocommerce'
        WHERE m.business_id = $1 AND m.connection_id = $2 AND m.entity_type = 'customer'
          AND m.remote_id ~ '^[1-9][0-9]{0,14}$'
          AND m.updated_at < $3::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM crm_external_profiles p
             WHERE p.business_id = m.business_id AND p.connection_id = m.connection_id
               AND p.provider = 'woocommerce' AND p.remote_id = m.remote_id
          )
       UNION
       SELECT i.remote_id
         FROM integration_customer_sync_run_items i
        WHERE i.business_id = $1 AND i.connection_id = $2 AND i.run_id = $4
          AND i.outcome = 'failed' AND i.remote_id ~ '^[1-9][0-9]{0,14}$'
     )
     SELECT k.remote_id
       FROM known k
      WHERE NOT EXISTS (
        SELECT 1 FROM integration_customer_sync_run_items i
         WHERE i.business_id = $1 AND i.connection_id = $2 AND i.run_id = $4
           AND i.remote_id = k.remote_id AND i.outcome <> 'failed'
      )
      ORDER BY k.remote_id::numeric
      LIMIT $5`,
    [businessId, connectionId, runStartedAt, runId, CUSTOMER_ABSENCE_VERIFY_BATCH_SIZE],
  );
  return rows.map((row) => row.remote_id);
}

/** Query a bounded, explicit set of Woo customer IDs. Unlike offset pages,
 * `include` cannot skip an active account when the store changes mid-run. */
async function fetchRestCustomersByIds(
  client: ReturnType<typeof wooClientFor>,
  remoteIds: string[],
): Promise<Map<string, WooCustomer>> {
  if (remoteIds.length === 0 || remoteIds.length > CUSTOMER_ABSENCE_VERIFY_BATCH_SIZE) {
    throw new Error("invalid_customer_verification_batch");
  }
  const requested = new Set(remoteIds);
  const result = await listCustomersPageWithRetry(client, {
    include: remoteIds.join(","),
    per_page: 100,
    page: 1,
  });
  if (result.totalPages > 1 || result.items.length > remoteIds.length) {
    throw new Error("customer_verification_response_incomplete");
  }
  const customers = new Map<string, WooCustomer>();
  for (const customer of result.items) {
    const remoteId = String(customer.id ?? "");
    if (!requested.has(remoteId) || customers.has(remoteId)) {
      // Some proxies/plugins strip unsupported query parameters. Never treat
      // an unfiltered/inconsistent response as evidence of deletion.
      throw new Error("customer_verification_filter_not_honored");
    }
    customers.set(remoteId, customer);
  }
  return customers;
}

/**
 * Pull customers in bounded page batches. The durable run cursor lets a retry
 * resume after an HTTP timeout; per-remote outcomes make a failed customer
 * visible and keep a partial snapshot from tombstoning accounts we did not see.
 */
export async function syncCustomers(
  businessId: string,
  connectionId: string,
  options: { requestedBy?: string | null } = {},
): Promise<CustomerSyncRunOutcome> {
  return withTenant(businessId, async () => {
    const connection = await getConnection(businessId, connectionId);
    if (!connection || connection.provider !== "woocommerce") throw new Error("not_found");

    // One active pull per store. Session advisory locks are released if the
    // process dies, unlike a page-level lock that would survive a request.
    const lockClient = await getPool().connect();
    const lockKey = `wp-customer-sync:${businessId}:${connectionId}`;
    try {
      await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
      const { rows: activeRuns } = await query<{
        id: string;
        current_page: number;
        total_pages: number | null;
        started_at: string;
      }>(
        `SELECT id, current_page, total_pages, started_at::text
           FROM integration_customer_sync_runs
          WHERE business_id = $1 AND connection_id = $2 AND transport = 'rest_api'
            AND status IN ('running', 'partial')
          ORDER BY started_at DESC
          LIMIT 1`,
        [businessId, connectionId],
      );
      let runId = activeRuns[0]?.id;
      let page = activeRuns[0]?.current_page ?? 1;
      let totalPages = activeRuns[0]?.total_pages ?? 0;
      let runStartedAt = activeRuns[0]?.started_at;
      if (!runId) {
        runId = randomUUID();
        const { rows } = await query<{ started_at: string }>(
          `INSERT INTO integration_customer_sync_runs
             (id, business_id, connection_id, transport, status, requested_by)
           VALUES ($1, $2, $3, 'rest_api', 'running', $4)
           RETURNING started_at::text`,
          [runId, businessId, connectionId, options.requestedBy ?? null],
        );
        runStartedAt = rows[0].started_at;
      } else {
        await query(
          `UPDATE integration_customer_sync_runs
              SET status = 'running', last_error = NULL, updated_at = now()
            WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
          [businessId, connectionId, runId],
        );
      }

      let client: ReturnType<typeof wooClientFor> | null = null;
      let pagesThisRequest = 0;
      let complete = false;
      while (pagesThisRequest < CUSTOMER_SYNC_PAGES_PER_REQUEST) {
        let customers: WooCustomer[];
        let pageCount: number;
        try {
          client ??= wooClientFor(connection);
          const result = await listCustomersPageWithRetry(client, { per_page: PER_PAGE, page });
          customers = result.items;
          pageCount = result.totalPages;
        } catch (err) {
          await query(
            `UPDATE integration_customer_sync_runs
                SET status = 'partial', last_error = $4, updated_at = now()
              WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
            [businessId, connectionId, runId, (err as Error).message.slice(0, 500)],
          );
          return await customerSyncRunSummary(businessId, connectionId, runId);
        }

        totalPages = Math.max(totalPages, pageCount);
        let pageFailed = 0;
        for (const customer of customers) {
          const remoteId = String(customer.id ?? "");
          try {
            const outcome = await upsertCustomerFromWoo(connection, customer);
            await recordCustomerSyncRunItem(businessId, connectionId, runId, remoteId, outcome);
          } catch (err) {
            pageFailed += 1;
            await recordCustomerSyncRunItem(
              businessId,
              connectionId,
              runId,
              remoteId,
              "failed",
              (err as Error).message,
            );
          }
        }

        await query(
          `UPDATE integration_customer_sync_runs
              SET total_pages = $4, updated_at = now()
            WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
          [businessId, connectionId, runId, totalPages || null],
        );
        if (pageFailed > 0) {
          await query(
            `UPDATE integration_customer_sync_runs
                SET status = 'partial', last_error = 'customer_page_partial', updated_at = now()
              WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
            [businessId, connectionId, runId],
          );
          return await customerSyncRunSummary(businessId, connectionId, runId);
        }

        const wasEmpty = customers.length === 0;
        if (wasEmpty && pageCount > page) {
          // A changing store or stale pagination header can return an empty
          // offset page while claiming later pages exist. Do not call that a
          // complete snapshot: keep the cursor here for an explicit retry and
          // never start absence verification from an inconsistent page walk.
          await query(
            `UPDATE integration_customer_sync_runs
                SET status = 'partial', last_error = 'customer_page_empty_before_end',
                    total_pages = $4, updated_at = now()
              WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
            [businessId, connectionId, runId, totalPages || pageCount],
          );
          return await customerSyncRunSummary(businessId, connectionId, runId);
        }

        page += 1;
        pagesThisRequest += 1;
        await query(
          `UPDATE integration_customer_sync_runs
              SET current_page = $4, total_pages = $5, updated_at = now()
            WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
          [businessId, connectionId, runId, page, totalPages || null],
        );
        if (wasEmpty || !pageCount || page - 1 >= pageCount) {
          complete = true;
          break;
        }
      }

      if (complete) {
        let absencesVerified = false;
        let verificationFailed = false;
        let verificationBatches = 0;
        try {
          while (verificationBatches < CUSTOMER_SYNC_PAGES_PER_REQUEST) {
            const remoteIds = await restCustomerAbsenceCandidates(
              businessId,
              connectionId,
              runId,
              runStartedAt!,
            );
            if (remoteIds.length === 0) {
              absencesVerified = true;
              break;
            }

            client ??= wooClientFor(connection);
            const found = await fetchRestCustomersByIds(client, remoteIds);
            let failedInBatch = 0;
            for (const remoteId of remoteIds) {
              try {
                const customer = found.get(remoteId);
                if (customer) {
                  const outcome = await upsertCustomerFromWoo(connection, customer);
                  await recordCustomerSyncRunItem(businessId, connectionId, runId, remoteId, outcome);
                } else {
                  const deleted = await markWooCustomerVerifiedAbsent(
                    businessId,
                    connectionId,
                    remoteId,
                    runStartedAt!,
                  );
                  await recordCustomerSyncRunItem(
                    businessId,
                    connectionId,
                    runId,
                    remoteId,
                    deleted ? "deleted" : "skipped",
                  );
                }
              } catch (err) {
                failedInBatch += 1;
                await recordCustomerSyncRunItem(
                  businessId,
                  connectionId,
                  runId,
                  remoteId,
                  "failed",
                  (err as Error).message,
                );
              }
            }
            verificationBatches += 1;
            if (failedInBatch > 0) {
              verificationFailed = true;
              break;
            }
          }

          if (!verificationFailed && !absencesVerified) {
            absencesVerified = (await restCustomerAbsenceCandidates(
              businessId,
              connectionId,
              runId,
              runStartedAt!,
            )).length === 0;
          }
        } catch (err) {
          await query(
            `UPDATE integration_customer_sync_runs
                SET status = 'partial', last_error = $4, updated_at = now()
              WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
            [businessId, connectionId, runId, (err as Error).message.slice(0, 500)],
          );
          return await customerSyncRunSummary(businessId, connectionId, runId);
        }

        if (verificationFailed) {
          await query(
            `UPDATE integration_customer_sync_runs
                SET status = 'partial', last_error = 'customer_verification_partial', updated_at = now()
              WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
            [businessId, connectionId, runId],
          );
          return await customerSyncRunSummary(businessId, connectionId, runId);
        }
        if (!absencesVerified) {
          await query(
            `UPDATE integration_customer_sync_runs
                SET status = 'partial', last_error = NULL, updated_at = now()
              WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
            [businessId, connectionId, runId],
          );
          return await customerSyncRunSummary(businessId, connectionId, runId);
        }

        const beforeCompletion = await customerSyncRunSummary(businessId, connectionId, runId);
        if (beforeCompletion.failed > 0) {
          await query(
            `UPDATE integration_customer_sync_runs
                SET status = 'partial', last_error = 'customer_rows_failed', updated_at = now()
              WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
            [businessId, connectionId, runId],
          );
          return await customerSyncRunSummary(businessId, connectionId, runId);
        }

        await withTenantTransaction(businessId, async () => {
          await query(
            `UPDATE integration_customer_sync_runs
                SET status = 'completed', completed_at = now(), last_error = NULL,
                    expected_count = (SELECT count(*)::int FROM integration_customer_sync_run_items
                                       WHERE run_id = $3 AND business_id = $1 AND connection_id = $2),
                    updated_at = now()
              WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
            [businessId, connectionId, runId],
          );
          await query(
            `UPDATE integration_connections
                SET last_sync_at = now(), last_customer_sync_at = now(),
                    status = 'active', last_error = NULL, updated_at = now()
              WHERE business_id = $1 AND id = $2 AND provider = 'woocommerce'`,
            [businessId, connectionId],
          );
        });
        const result = await customerSyncRunSummary(businessId, connectionId, runId);
        await writeIntegrationAudit({
          businessId,
          connectionId,
          action: "customers.synced",
          payload: result,
        });
        return result;
      }

      await query(
        `UPDATE integration_customer_sync_runs
            SET status = 'partial', last_error = NULL, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2 AND id = $3`,
        [businessId, connectionId, runId],
      );
      return await customerSyncRunSummary(businessId, connectionId, runId);
    } finally {
      try {
        await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      } finally {
        lockClient.release();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Reading the catalogue back
// ---------------------------------------------------------------------------

export interface MappedProduct {
  remoteId: string;
  localId: string;
  name: string;
  priceRial: bigint;
}

/**
 * All mapped products for a connection, joined with their local price (Rial).
 * Queries whichever table the business's industry actually uses.
 */
export async function mappedProducts(
  businessId: string,
  connectionId: string,
): Promise<MappedProduct[]> {
  const mappings = await listMappings(businessId, connectionId, "product");
  if (mappings.length === 0) return [];
  const ids = mappings.map((m) => m.localId);
  const industry = await getBusinessIndustry(businessId);

  if (!hasSellableCatalogue(industry)) return [];

  if (industry === "food_service") {
    const { rows } = await query<{ id: string; name: string; price: string }>(
      `SELECT id, name, price FROM menu_items WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return mappings.flatMap((m) => {
      const item = byId.get(m.localId);
      return item ? [{ remoteId: m.remoteId, localId: m.localId, name: item.name, priceRial: BigInt(item.price) }] : [];
    });
  }

  // Retail: items + item_stock. A variant_parent has no sellable price; its
  // children (and simple items) do.
  const { rows } = await query<{ id: string; name: string; unit_price: string | null }>(
    `SELECT i.id, i.name, s.unit_price::text
       FROM items i
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return mappings.flatMap((m) => {
    const item = byId.get(m.localId);
    return item
      ? [{ remoteId: m.remoteId, localId: m.localId, name: item.name, priceRial: item.unit_price ? BigInt(item.unit_price) : 0n }]
      : [];
  });
}

/**
 * The store's last-seen presentation of a product, read from the mapping's
 * metadata (written by `recordProductShape` at every sync). Nulls mean
 * "never synced since this shape existed" — legacy mappings simply have no
 * snapshot yet, and the UI must show «—» rather than guess.
 */
export interface CatalogueRemoteSnapshot {
  /** WooCommerce publish status: publish / draft / pending / private. */
  remoteStatus: string | null;
  /** Whether the store tracks stock for this product (`manage_stock`). */
  remoteManageStock: boolean | null;
  /** The store's regular price at the last sync, integer Rial. */
  remoteRegularPriceRial: string | null;
  /** The store's sale price at the last sync, integer Rial; null = no sale. */
  remoteSalePriceRial: string | null;
  /**
   * The store's primary product image at the last sync — a display-only
   * mirror of what the shopfront shows (issue #943). Nothing here uploads or
   * rewrites imagery: attachment transport and mapping belong to #941, which
   * has not landed; see docs/integrations/woocommerce-price-stock-policy.md for exactly
   * what is blocked on it and why.
   */
  remoteImageSrc: string | null;
  remoteImageAlt: string | null;
}

/** Reads the remote snapshot out of a mapping's metadata. Pure. */
export function remoteSnapshotFromMeta(meta: unknown): CatalogueRemoteSnapshot {
  const m = (meta ?? {}) as Record<string, unknown>;
  return {
    remoteStatus: typeof m.remoteStatus === "string" && m.remoteStatus ? m.remoteStatus : null,
    remoteManageStock: typeof m.remoteManageStock === "boolean" ? m.remoteManageStock : null,
    remoteRegularPriceRial: typeof m.remoteRegularPriceRial === "string" ? m.remoteRegularPriceRial : null,
    remoteSalePriceRial: typeof m.remoteSalePriceRial === "string" ? m.remoteSalePriceRial : null,
    remoteImageSrc: typeof m.remoteImageSrc === "string" && m.remoteImageSrc ? m.remoteImageSrc : null,
    remoteImageAlt: typeof m.remoteImageAlt === "string" ? m.remoteImageAlt : null,
  };
}

export interface CatalogueRow extends CatalogueRemoteSnapshot {
  remoteId: string;
  localId: string;
  name: string;
  sku: string | null;
  /** The WooCommerce type, as classified (simple / variation / variable / …). */
  wooType: string;
  /** The retail item kind, or null for an F&B menu item. */
  itemKind: string | null;
  sellable: boolean;
  /**
   * Whether this product's shape carries store stock at all — false for
   * `variable`/`grouped` containers and for `external` products sold on
   * someone else's site. When false, `quantity` is always null: a tracked
   * figure for an untracked shape would be a number this app fabricated
   * (issue #943). This is the product-TYPE truth; the store's own
   * `manage_stock` setting arrives separately as `remoteManageStock`.
   */
  stockTracked: boolean;
  priceRial: bigint | null;
  quantity: number | null;
  parentRemoteId: string | null;
  categories: string[];
  /** Per-variation attributes, «رنگ: قرمز» style. */
  attributes: string[];
  /** When this product's mapping/metadata was last written — its "last synced" clock. */
  lastSyncedAt: string | null;
  /** The owner paused the SCHEDULED stock push for this one product (issue #943, item 4). Manual edits still queue. */
  stockPushPaused: boolean;
  /** The owner paused the SCHEDULED price push for this one product. */
  pricePushPaused: boolean;
  /** The last complete store read no longer saw this product — deleted or trashed remotely (issue #943, item 5). */
  remoteMissing: boolean;
}

export interface CataloguePageOptions {
  /** Case-insensitive substring over name, SKU, type, categories, attributes. */
  search?: string | null;
  /** Exact WooCommerce type, as the page's own facets report it. */
  type?: string | null;
  /** 1-based; clamped to ≥ 1. */
  page?: number;
  /** Clamped to 10..100 — the dashboard's page-size picker range. */
  pageSize?: number;
}

export interface CataloguePageSummary {
  total: number;
  sellable: number;
  containers: number;
  variations: number;
  outOfStock: number;
  uncategorised: number;
}

export interface CataloguePage {
  industry: string;
  /** The requested page's rows only, in the catalogue's stable order. */
  rows: CatalogueRow[];
  /** Rows matching search/type — what pagination pages through. */
  total: number;
  /** Every mapped product on this connection, before any filter. */
  mappedTotal: number;
  /** Shape/stock/category counts over the WHOLE scoped catalogue. */
  summary: CataloguePageSummary;
  /** Every Woo type present anywhere in the scoped catalogue (the facets). */
  types: string[];
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * The name ordering for the catalogue: the ICU Persian collation when the
 * database has it — the same reading order the dashboard had while the sort
 * ran in Node (`localeCompare(…, "fa")`) — and the cluster default where it
 * does not. Either way the ORDER BY ends with `remote_id COLLATE "C"`, so a
 * page boundary never depends on which of the two is in effect: a row can
 * only move between pages when its own name moved.
 *
 * Probed once per process. A production Postgres built without ICU must
 * still page the catalogue, and pinning the app to one server build is not
 * this function's job.
 */
let nameCollationSqlPromise: Promise<string> | null = null;
function catalogueNameCollation(): Promise<string> {
  nameCollationSqlPromise ??= query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'fa-x-icu') AS found`,
  )
    .then(({ rows }) => (rows[0]?.found ? ` COLLATE "fa-x-icu"` : ``))
    .catch(() => ``);
  return nameCollationSqlPromise;
}

/** timestamptz arrives as a Date from node-pg; the JSON response carries ISO text. */
function isoText(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

/**
 * Retail `base`: the mapping scope joined to `items` (+ its stock row), with
 * the row's Woo type resolved exactly the way the in-memory reader did —
 * the recorded `wooType` wins, and a legacy mapping without one falls back
 * to the item kind.
 */
const RETAIL_CATALOGUE_BASE = `  SELECT sc.remote_id, sc.local_id, sc.meta, sc.updated_at,
         i.name, i.sku, i.kind,
         COALESCE(NULLIF(sc.meta->>'wooType', ''),
                  CASE i.kind WHEN 'variant_parent' THEN 'variable'
                              WHEN 'variant_child' THEN 'variation'
                              ELSE 'simple' END) AS woo_type,
         NULLIF(sc.meta->>'remoteParentId', '') AS parent_remote_id,
         st.quantity,
         st.unit_price::text AS unit_price
    FROM scope sc
    JOIN items i ON i.id = sc.local_id
    LEFT JOIN item_stock st ON st.item_id = i.id`;

/** F&B `base`: menu items carry a price and no stock model of their own. */
const FNB_CATALOGUE_BASE = `  SELECT sc.remote_id, sc.local_id, sc.meta, sc.updated_at,
         mi.name, mi.sku, NULL::text AS kind,
         COALESCE(NULLIF(sc.meta->>'wooType', ''), 'simple') AS woo_type,
         NULLIF(sc.meta->>'remoteParentId', '') AS parent_remote_id,
         NULL::numeric(24, 9) AS quantity,
         mi.price::text AS unit_price
    FROM scope sc
    JOIN menu_items mi ON mi.id = sc.local_id`;

/** Retail variation attributes, «رنگ: قرمز» style, ordered like the old reader. */
const RETAIL_CATALOGUE_ATTRIBUTES = `         COALESCE((SELECT array_agg(
                     CASE WHEN COALESCE(va.name, '') <> '' AND COALESCE(va.value, '') <> ''
                          THEN va.name || ': ' || va.value
                          ELSE COALESCE(NULLIF(va.value, ''), va.name) END
                     ORDER BY va.name)
                     FROM item_variant_attributes va
                    WHERE va.item_id = b.local_id), '{}') AS attributes`;

/** An F&B menu item has no variant-attribute rows; its list is honestly empty. */
const FNB_CATALOGUE_ATTRIBUTES = `         '{}'::text[] AS attributes`;

/**
 * The shared CTE for the scoped catalogue read (issue #943, item 1): one
 * business + one connection's product mappings, joined to the local table
 * the industry actually uses, carrying everything search, facets, summary,
 * ordering and the page slice need — so no part of the screen can see a
 * different subset than another, and no request ever materialises the whole
 * catalogue in memory again.
 *
 * Parameters for every statement built on this CTE:
 *   $1 businessId, $2 connectionId, $3 normalised search ('' = none),
 *   $4 type facet ('' = all), $5 untracked type strings,
 *   $6 non-sellable type strings. The aggregate statement adds
 *   $7 variation type strings; the page statement reuses $7/$8 for its
 *   LIMIT/OFFSET (an unreferenced parameter is one Postgres cannot type).
 *
 * The shape lists come from woo-catalogue.ts's own alias/shape tables — the
 * SQL and the pure classifier cannot drift, because the SQL's lists ARE the
 * classifier's tables. Matching is on `lower(btrim(...))`, exactly like
 * `classifyWooProductType`, and an unrecognised type stays sellable/tracked
 * (the `unknown → simple` default) because the predicates are NOT-ANY.
 */
function catalogueCteSql(baseSelect: string, attributesSelect: string): string {
  return `
WITH scope AS (
  SELECT m.remote_id, m.local_id, m.last_pushed_payload AS meta, m.updated_at
    FROM integration_mappings m
   WHERE m.business_id = $1 AND m.connection_id = $2 AND m.entity_type = 'product'
), base AS (
${baseSelect}
), enriched AS MATERIALIZED (
  SELECT b.*,
         lower(btrim(b.woo_type)) AS woo_type_norm,
         COALESCE((SELECT array_agg(t.name ORDER BY pt.term_remote_id)
                     FROM integration_woo_product_terms pt
                     JOIN integration_woo_terms t
                       ON t.connection_id = pt.connection_id
                      AND t.taxonomy = pt.taxonomy
                      AND t.remote_id = pt.term_remote_id
                    WHERE pt.business_id = $1
                      AND pt.connection_id = $2
                      AND pt.taxonomy = 'product_cat'
                      AND pt.remote_id = b.remote_id
                      AND COALESCE(t.name, '') <> ''), '{}') AS categories,
${attributesSelect}
    FROM base b
)`;
}

/**
 * The one filter predicate, in SQL — the exact mirror of
 * `catalogueRowMatches`: same haystack (name, SKU, type, categories,
 * attributes joined by single spaces, lower-cased), same substring rule,
 * same exact-match type facet. One statement feeds the page AND the count,
 * so the header's «X of Y» can never disagree with the rows below it.
 */
const CATALOGUE_FILTER_SQL = `($3::text = '' OR position($3::text IN lower(array_to_string(ARRAY[e.name, COALESCE(e.sku, ''), e.woo_type] || e.categories || e.attributes, ' '))) > 0)
   AND ($4::text = '' OR e.woo_type = $4::text)`;

type CatalogueRowSql = {
  remote_id: string;
  local_id: string;
  name: string;
  sku: string | null;
  woo_type: string;
  item_kind: string | null;
  sellable: boolean;
  stock_tracked: boolean;
  quantity: string | null;
  unit_price: string | null;
  parent_remote_id: string | null;
  categories: string[] | null;
  attributes: string[] | null;
  remote_status: string | null;
  remote_manage_stock: boolean | null;
  remote_regular_price_rial: string | null;
  remote_sale_price_rial: string | null;
  remote_image_src: string | null;
  remote_image_alt: string | null;
  stock_push_paused: boolean;
  price_push_paused: boolean;
  remote_missing: boolean;
  updated_at: Date | string | null;
};

type CatalogueAggSql = {
  mapped_total: number;
  filtered_total: number;
  sellable: number;
  containers: number;
  variations: number;
  out_of_stock: number;
  uncategorised: number;
  types: string[] | null;
};

/**
 * The synced catalogue page, scoped in SQL to one tenant + one connection.
 *
 * Retail and F&B read different tables, and the panel should not have to
 * know which — so this resolves the industry once and returns one shape for
 * both. Search, the type facet, the facets themselves, the summary counts
 * and the page slice are ALL computed by the database over the same scoped
 * CTE: at catalogue sizes past a few hundred rows the previous read-every-
 * row-then-filter-in-memory path was an O(catalogue) cost per keystroke, and
 * its page boundaries moved whenever anyone's rows moved. The ordering is
 * stable (name → remote id) and every number on the screen comes from one
 * predicate (issue #943, item 1).
 */
export async function cataloguePageFor(
  businessId: string,
  connectionId: string,
  options: CataloguePageOptions = {},
): Promise<CataloguePage> {
  const industry = (await getBusinessIndustry(businessId)) ?? "";
  const search = (options.search ?? "").trim().toLowerCase().slice(0, 200);
  const type = (options.type ?? "").trim();
  const rawPage = Number(options.page ?? 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
  const rawSize = Number(options.pageSize ?? 25);
  const pageSize = Number.isFinite(rawSize) ? Math.min(100, Math.max(10, Math.trunc(rawSize))) : 25;

  const empty: CataloguePage = {
    industry,
    rows: [],
    total: 0,
    mappedTotal: 0,
    summary: { total: 0, sellable: 0, containers: 0, variations: 0, outOfStock: 0, uncategorised: 0 },
    types: [],
    page,
    pageSize,
    totalPages: 1,
  };
  // No sellable catalogue: an empty register is the truthful answer, not a
  // query against a table this trade does not fill.
  if (!hasSellableCatalogue(industry)) return empty;

  const isFnb = industry === "food_service";
  const cte = catalogueCteSql(
    isFnb ? FNB_CATALOGUE_BASE : RETAIL_CATALOGUE_BASE,
    isFnb ? FNB_CATALOGUE_ATTRIBUTES : RETAIL_CATALOGUE_ATTRIBUTES,
  );
  const baseParams: unknown[] = [
    businessId,
    connectionId,
    search,
    type,
    [...UNTRACKED_WOO_TYPE_STRINGS],
    [...NON_SELLABLE_WOO_TYPE_STRINGS],
    [...VARIATION_WOO_TYPE_STRINGS],
  ];

  // The whole-catalogue truth first: summary and facets are UNFILTERED (a
  // type that exists only behind a search is still selectable), and an
  // empty scope ends the request without a second query.
  const agg = await query<CatalogueAggSql>(
    `${cte}
SELECT count(*)::int AS mapped_total,
       count(*) FILTER (WHERE ${CATALOGUE_FILTER_SQL})::int AS filtered_total,
       count(*) FILTER (WHERE NOT (e.woo_type_norm = ANY($6::text[])))::int AS sellable,
       count(*) FILTER (WHERE e.woo_type_norm = ANY($6::text[]))::int AS containers,
       count(*) FILTER (WHERE e.woo_type_norm = ANY($7::text[]))::int AS variations,
       count(*) FILTER (WHERE NOT (e.woo_type_norm = ANY($5::text[])) AND e.quantity = 0)::int AS out_of_stock,
       count(*) FILTER (WHERE cardinality(e.categories) = 0)::int AS uncategorised,
       COALESCE(array_agg(DISTINCT e.woo_type ORDER BY e.woo_type), '{}') AS types
  FROM enriched e`,
    baseParams,
  );
  const totals = agg.rows[0];
  if (!totals || totals.mapped_total === 0) return empty;

  const summary: CataloguePageSummary = {
    total: totals.mapped_total,
    sellable: totals.sellable,
    containers: totals.containers,
    variations: totals.variations,
    // Out of stock means a TRACKED product sitting at zero — an untracked
    // shape (variable parent, grouped shelf, external listing) has no
    // quantity to be out of, and counting one would fabricate the number
    // this row refuses to display (issue #943, item 4).
    outOfStock: totals.out_of_stock,
    uncategorised: totals.uncategorised,
  };
  const total = totals.filtered_total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  let rows: CatalogueRow[] = [];
  if (total > 0 && (page - 1) * pageSize < total) {
    const nameCollation = await catalogueNameCollation();
    const pageResult = await query<CatalogueRowSql>(
      `${cte}
SELECT e.remote_id, e.local_id, e.name, e.sku, e.woo_type, e.kind AS item_kind,
       NOT (e.woo_type_norm = ANY($6::text[])) AS sellable,
       NOT (e.woo_type_norm = ANY($5::text[])) AS stock_tracked,
       CASE WHEN e.woo_type_norm = ANY($5::text[]) THEN NULL ELSE e.quantity END AS quantity,
       e.unit_price,
       e.parent_remote_id,
       e.categories,
       e.attributes,
       CASE WHEN jsonb_typeof(e.meta->'remoteStatus') = 'string' AND COALESCE(e.meta->>'remoteStatus', '') <> ''
            THEN e.meta->>'remoteStatus' END AS remote_status,
       CASE WHEN jsonb_typeof(e.meta->'remoteManageStock') = 'boolean'
            THEN (e.meta->>'remoteManageStock') = 'true' END AS remote_manage_stock,
       CASE WHEN jsonb_typeof(e.meta->'remoteRegularPriceRial') = 'string'
            THEN e.meta->>'remoteRegularPriceRial' END AS remote_regular_price_rial,
       CASE WHEN jsonb_typeof(e.meta->'remoteSalePriceRial') = 'string'
            THEN e.meta->>'remoteSalePriceRial' END AS remote_sale_price_rial,
       CASE WHEN jsonb_typeof(e.meta->'remoteImageSrc') = 'string' AND COALESCE(e.meta->>'remoteImageSrc', '') <> ''
            THEN e.meta->>'remoteImageSrc' END AS remote_image_src,
       CASE WHEN jsonb_typeof(e.meta->'remoteImageAlt') = 'string'
            THEN e.meta->>'remoteImageAlt' END AS remote_image_alt,
       COALESCE(jsonb_typeof(e.meta->'stockPushPaused') = 'boolean' AND (e.meta->>'stockPushPaused')::boolean, false) AS stock_push_paused,
       COALESCE(jsonb_typeof(e.meta->'pricePushPaused') = 'boolean' AND (e.meta->>'pricePushPaused')::boolean, false) AS price_push_paused,
       COALESCE(jsonb_typeof(e.meta->'remoteMissing') = 'boolean' AND (e.meta->>'remoteMissing')::boolean, false) AS remote_missing,
       e.updated_at
  FROM enriched e
 WHERE ${CATALOGUE_FILTER_SQL}
 ORDER BY e.name${nameCollation}, e.remote_id COLLATE "C"
 LIMIT $7 OFFSET $8`,
      // The page statement never reads the variation list ($7 of the
      // aggregate), and an unreferenced parameter is one Postgres cannot
      // type — so this statement's $7/$8 are its own LIMIT/OFFSET.
      [...baseParams.slice(0, 6), pageSize, (page - 1) * pageSize],
    );
    rows = pageResult.rows.map((r) => ({
      remoteId: r.remote_id,
      localId: r.local_id,
      name: r.name,
      sku: r.sku,
      wooType: r.woo_type,
      itemKind: r.item_kind,
      sellable: r.sellable,
      stockTracked: r.stock_tracked,
      priceRial: r.unit_price === null ? null : BigInt(r.unit_price),
      quantity: r.quantity === null ? null : Number(r.quantity),
      parentRemoteId: r.parent_remote_id,
      categories: r.categories ?? [],
      attributes: r.attributes ?? [],
      remoteStatus: r.remote_status,
      remoteManageStock: r.remote_manage_stock,
      remoteRegularPriceRial: r.remote_regular_price_rial,
      remoteSalePriceRial: r.remote_sale_price_rial,
      remoteImageSrc: r.remote_image_src,
      remoteImageAlt: r.remote_image_alt,
      stockPushPaused: r.stock_push_paused,
      pricePushPaused: r.price_push_paused,
      remoteMissing: r.remote_missing,
      lastSyncedAt: isoText(r.updated_at),
    }));
  }

  return { industry, rows, total, mappedTotal: totals.mapped_total, summary, types: totals.types ?? [], page, pageSize, totalPages };
}


/**
 * Flag every mapped product a complete store read did not see (issue #943,
 * item 5). Returns how many mappings changed state.
 *
 * The flag is metadata, not deletion: the local accounting row, its mapping
 * and its history all stay. `recordProductShape` clears the flag whenever any
 * inbound payload — the next sync, a webhook — sees the product again, so a
 * store that hid a product behind a status filter for one read heals on the
 * next honest one. Callers must only run this over a COMPLETE, failure-free
 * read: a truncated page walk saw part of the store, and "I did not see it"
 * is only evidence when the eyes were open the whole time.
 */
export async function flagProductsMissingRemotely(
  businessId: string,
  connectionId: string,
  seenRemoteIds: string[],
): Promise<number> {
  // An EMPTY seen list is authoritative too: a complete, failure-free read
  // that returned zero products (every remote product deleted or trashed)
  // means every mapping is missing — `remote_id = ANY('{}')` is false for
  // every row, so the UPDATE below flags them all. Guarding this away left
  // emptied stores presenting every product as remotely present forever
  // (Codex review, PR #1054).
  const result = await query(
    `UPDATE integration_mappings
        SET last_pushed_payload = COALESCE(last_pushed_payload, '{}'::jsonb) || '{"remoteMissing": true}'::jsonb,
            updated_at = now()
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product'
        AND NOT (remote_id = ANY($3::text[]))
        AND COALESCE(last_pushed_payload->'remoteMissing', to_jsonb(false)) IS DISTINCT FROM to_jsonb(true)`,
    [businessId, connectionId, seenRemoteIds],
  );
  return result.rowCount ?? 0;
}

/**
 * The variation's parent id, read out of a mapping's metadata. Pure, and the
 * one rule every outbound product path shares (issue #943): the manual
 * enqueue, the scheduled stock/price refresh and the REST drain all resolve
 * the parent through this instead of each guessing where it is recorded.
 */
export function parentRemoteIdFromMeta(meta: unknown): string | null {
  const parent = (meta as { remoteParentId?: unknown } | null | undefined)?.remoteParentId;
  return typeof parent === "string" && parent ? parent : null;
}

/** The parent id a remote product's updates must be sent through, if any. */
export async function parentRemoteIdFor(
  businessId: string,
  connectionId: string,
  remoteId: string,
): Promise<string | null> {
  const { rows } = await query<{ last_pushed_payload: { remoteParentId?: string | null } | null }>(
    `SELECT last_pushed_payload FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product' AND remote_id = $3`,
    [businessId, connectionId, remoteId],
  );
  return parentRemoteIdFromMeta(rows[0]?.last_pushed_payload ?? null);
}
