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
import { getPool, query } from "../db";
import { getBusinessIndustry } from "../industry-guard";
import { hasSellableCatalogue, isRetailCatalogueIndustry } from "../industries";
import { getConnection, wooClientFor, type ConnectionRow } from "./connections-service";
import { listMappings, localIdForRemote, mergeMappingMeta, upsertMapping } from "./mapping-service";
import { wooAmountToRial } from "./woo-money";
import { writeIntegrationAudit } from "./audit";
import {
  partyForExternalCustomer,
  reconcileExternalIdentity,
} from "../crm-external-identity";
import {
  inferWooProductType,
  isSellableWooProduct,
  planWooCatalogueWrite,
  wooProductShape,
  wooVariationAttributes,
  wooVariationDisplayName,
} from "./woo-catalogue";
import {
  ensureMenuCategory,
  recordProductTermsFromPayload,
  syncTaxonomyTree,
  termsByRemoteId,
  type TaxonomySyncOutcome,
} from "./woo-taxonomy-service";
import type { WooCustomer, WooProduct, WooVariationAttribute } from "./woocommerce-client";

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

export interface CatalogueSyncOutcome extends SyncOutcome {
  /** Variations pulled from their parents and written as sellable children. */
  variations: number;
  /** Containers (variable/grouped) recorded, not sellable. */
  containers: number;
  /** Products the store listed but this app has no shape for. Always 0 today. */
  skipped: number;
  taxonomy?: TaxonomySyncOutcome;
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
  const existing = await localIdForRemote(businessId, connection.id, "product", String(product.id));

  if (existing) {
    await query(
      `UPDATE menu_items SET name = $3, sku = $4, price = $5, updated_at = now()
        WHERE id = $1 AND location_id = $2`,
      [existing, locationId, name, product.sku || null, price.toString()],
    );
    await recordProductShape(connection, product);
    return "updated";
  }

  const categoryId = await categoryForProduct(connection, locationId, product);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, sku, price)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [locationId, categoryId, name, product.sku || null, price.toString()],
  );
  await upsertMapping(businessId, connection.id, "product", String(product.id), rows[0].id);
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
  const existing = await localIdForRemote(businessId, connection.id, "product", String(product.id));

  if (existing) {
    await query(
      `UPDATE items SET name = $3, sku = $4, updated_at = now()
        WHERE id = $1 AND location_id = $2`,
      [existing, locationId, name, product.sku || null],
    );
    // A container is not sellable — it carries no stock/price of its own.
    if (!shape.container) {
      await upsertItemStock(existing, stockQuantity, price);
    }
    if (attributes.length) {
      await replaceVariantAttributes(existing, attributes);
    }
    await recordProductShape(connection, product);
    return "updated";
  }

  if (shape.container) {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO items (location_id, name, sku, kind, tracking)
       VALUES ($1, $2, $3, 'variant_parent', 'none') RETURNING id`,
      [locationId, name, product.sku || null],
    );
    await upsertMapping(businessId, connection.id, "product", String(product.id), rows[0].id);
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
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO items (location_id, parent_item_id, name, sku, kind, tracking)
       VALUES ($1, $2, $3, $4, $5, 'none') RETURNING id`,
      [locationId, parentItemId, name, product.sku || null, shape.itemKind],
    );
    const itemId = rows[0].id;
    await client.query(
      `INSERT INTO item_stock (item_id, quantity, unit_price)
       VALUES ($1, $2, $3)`,
      [itemId, stockQuantity, price > 0n ? Number(price) : null],
    );
    for (const attr of attributes) {
      await client.query(
        `INSERT INTO item_variant_attributes (item_id, name, value) VALUES ($1, $2, $3)`,
        [itemId, attr.name, attr.option],
      );
    }
    await client.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', $3, $4)
       ON CONFLICT (connection_id, entity_type, remote_id)
       DO UPDATE SET local_id = EXCLUDED.local_id, updated_at = now()`,
      [businessId, connection.id, String(product.id), itemId],
    );
    await client.query("COMMIT");
    await recordProductShape(connection, product);
    return "created";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Remember what a remote product *is*, not just what it maps to.
 *
 * Two facts live here. The parent id, because a later stock/price push to a
 * variation has to go to `products/{parent}/variations/{id}` — without it
 * every push to a variation 404s its way to the dead-letter queue. And the
 * type, so the dashboard can say «متغیر» / «ساده» next to a row instead of
 * showing a bare name.
 */
async function recordProductShape(connection: ConnectionRow, product: WooProduct): Promise<void> {
  const meta: Record<string, unknown> = {
    wooType: inferWooProductType(product),
    remoteParentId: product.parent_id ? String(product.parent_id) : null,
  };
  await mergeMappingMeta(connection.business_id, connection.id, "product", String(product.id), meta);
  // Upsert the product's category/tag terms into the taxonomy mirror AND
  // record the product→term assignments. In plugin mode the app cannot dial
  // the store, so these inline terms are the *only* way the taxonomy mirror
  // is ever populated — before this, a plugin-connected store's categories
  // column and taxonomy browser stayed empty no matter how many products
  // synced. See upsertTermFromPayload for why upsert rather than replace.
  await recordProductTermsFromPayload(connection.business_id, connection.id, String(product.id), product);
  // A variation inherits its parent's categories on the store's own display,
  // so the mirror does too — otherwise a variation would appear in no
  // category at all while its parent sits in three.
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

/** Upsert a retail item's on-hand quantity and shelf price (Rial). */
async function upsertItemStock(itemId: string, quantity: number, price: bigint): Promise<void> {
  await query(
    `INSERT INTO item_stock (item_id, quantity, unit_price)
     VALUES ($1, $2, $3)
     ON CONFLICT (item_id) DO UPDATE
       SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, updated_at = now()`,
    [itemId, quantity, price > 0n ? Number(price) : null],
  );
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
): Promise<"created" | "updated"> {
  const result = await reconcileExternalIdentity(
    {
      businessId: connection.business_id,
      connectionId: connection.id,
      provider: "woocommerce",
      remoteId: String(customer.id),
      name:
        `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() ||
        customer.email ||
        `Customer #${customer.id}`,
      email: customer.email ?? null,
      phone: customer.billing?.phone ?? null,
      address: customer.billing?.address_1 ?? null,
      payload: customer as unknown as Record<string, unknown>,
    },
    // A customer sync is an explicit "import these people" operation, so
    // creating the ones we do not have is the point of it.
    { allowCreate: true, actor: "همگام‌سازی فروشگاه" },
  );

  // Keep the legacy mapping row in step. `integration_mappings` is still what
  // the push side and the Holoo bridge read, and the merge registry now moves
  // it, so it must not fall behind the profile.
  if (result.partyId) {
    await upsertMapping(
      connection.business_id,
      connection.id,
      "customer",
      String(customer.id),
      result.partyId,
    );
  }

  return result.created ? "created" : "updated";
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

  // A registered shopper: the store's own id is the strongest identifier
  // there is, and if it is already mapped there is no identity question.
  if (remoteCustomerId > 0) {
    const mapped = await partyForExternalCustomer(
      businessId,
      connection.id,
      String(remoteCustomerId),
    );
    if (mapped) return mapped;
    const legacy = await localIdForRemote(businessId, connection.id, "customer", String(remoteCustomerId));
    if (legacy) return legacy;
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

  if (result.partyId && remoteCustomerId > 0) {
    await upsertMapping(businessId, connection.id, "customer", String(remoteCustomerId), result.partyId);
  }

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

  const apply = async (product: WooProduct) => {
    total += 1;
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

  let taxonomy: TaxonomySyncOutcome | undefined;
  try {
    taxonomy = await syncTaxonomyTree(businessId, connectionId, client);
  } catch (err) {
    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "taxonomy.sync_failed",
      error: (err as Error).message,
    });
  }

  await query(
    `UPDATE integration_connections
        SET last_sync_at = now(), last_catalogue_sync_at = now(),
            status = 'active', last_error = NULL, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, connectionId],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "products.synced",
    payload: { created, updated, skipped, variations, containers, total, failures: failures.length, taxonomy },
  });
  return { created, updated, skipped, variations, containers, total, taxonomy };
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

export async function syncCustomers(businessId: string, connectionId: string): Promise<SyncOutcome> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  const client = wooClientFor(connection);

  let created = 0;
  let updated = 0;
  let page = 1;
  let total = 0;

  for (;;) {
    // Paged via the store's own X-WP-TotalPages header. The old loop called
    // `listCustomers` — a single-page request — and, while it passed `page`
    // as a parameter, guessed the end from "a short page" alone. That was
    // fine on a mock and wrong on a live store whose first page was full and
    // whose host withheld the paging header on the convenience endpoint: the
    // loop only ran once. listCustomersPage reads the authoritative header
    // and falls back to the short-page rule, exactly like the product pull.
    const { items: customers, totalPages } = await client.listCustomersPage({ per_page: PER_PAGE, page });
    total += customers.length;
    for (const customer of customers) {
      if ((await upsertCustomerFromWoo(connection, customer)) === "created") created += 1;
      else updated += 1;
    }
    if (!totalPages || page >= totalPages || customers.length === 0) break;
    page += 1;
  }

  await query(
    `UPDATE integration_connections
        SET last_sync_at = now(), last_customer_sync_at = now(),
            status = 'active', last_error = NULL, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, connectionId],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "customers.synced",
    payload: { created, updated, total },
  });
  return { created, updated, total };
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

export interface CatalogueRow {
  remoteId: string;
  localId: string;
  name: string;
  sku: string | null;
  /** The WooCommerce type, as classified (simple / variation / variable / …). */
  wooType: string;
  /** The retail item kind, or null for an F&B menu item. */
  itemKind: string | null;
  sellable: boolean;
  priceRial: bigint | null;
  quantity: number | null;
  parentRemoteId: string | null;
  categories: string[];
  /** Per-variation attributes, «رنگ: قرمز» style. */
  attributes: string[];
}

/**
 * The synced catalogue, in the shape the dashboard shows.
 *
 * Retail and F&B read different tables, and the panel should not have to know
 * which — so this resolves the industry once and returns one shape for both.
 */
export async function catalogueFor(
  businessId: string,
  connectionId: string,
): Promise<{ industry: string; rows: CatalogueRow[] }> {
  const mappings = await listMappings(businessId, connectionId, "product");
  const industry = await getBusinessIndustry(businessId);
  if (mappings.length === 0) return { industry: industry ?? "", rows: [] };
  // No sellable catalogue: an empty register is the truthful answer, not a
  // query against a table this trade does not fill.
  if (!hasSellableCatalogue(industry)) return { industry: industry ?? "", rows: [] };
  const remoteIds = mappings.map((m) => m.remoteId);
  const categories = await termsByRemoteId(businessId, connectionId, remoteIds, "product_cat");

  if (industry === "food_service") {
    const ids = mappings.map((m) => m.localId);
    const { rows } = await query<{ id: string; name: string; sku: string | null; price: string }>(
      `SELECT id, name, sku, price::text FROM menu_items WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const localById = new Map(rows.map((r) => [r.id, r]));
    return {
      industry,
      rows: mappings.flatMap((m) => {
        const item = localById.get(m.localId);
        if (!item) return [];
        const meta = (m.lastPushedPayload ?? {}) as { wooType?: string; remoteParentId?: string | null };
        const type = meta.wooType ?? "simple";
        return [
          {
            remoteId: m.remoteId,
            localId: m.localId,
            name: item.name,
            sku: item.sku,
            wooType: type,
            itemKind: null,
            sellable: isSellableWooProduct({ type }),
            priceRial: BigInt(item.price),
            quantity: null,
            parentRemoteId: meta.remoteParentId ?? null,
            categories: (categories.get(m.remoteId) ?? []).map((c) => c.name).filter(Boolean),
            attributes: [],
          },
        ];
      }),
    };
  }

  const ids = mappings.map((m) => m.localId);
  const { rows } = await query<{
    id: string;
    name: string;
    sku: string | null;
    kind: string;
    quantity: string | null;
    unit_price: string | null;
  }>(
    `SELECT i.id, i.name, i.sku, i.kind, s.quantity::text, s.unit_price::text
       FROM items i
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.id = ANY($1::uuid[])`,
    [ids],
  );
  const localById = new Map(rows.map((r) => [r.id, r]));

  const attributeRows = await query<{ item_id: string; name: string; value: string }>(
    `SELECT item_id, name, value FROM item_variant_attributes WHERE item_id = ANY($1::uuid[]) ORDER BY name`,
    [ids],
  );
  const attributesByItem = new Map<string, string[]>();
  for (const row of attributeRows.rows) {
    const list = attributesByItem.get(row.item_id) ?? [];
    list.push(row.name && row.value ? `${row.name}: ${row.value}` : row.value || row.name);
    attributesByItem.set(row.item_id, list);
  }

  return {
    industry: industry ?? "",
    rows: mappings.flatMap((m) => {
      const item = localById.get(m.localId);
      if (!item) return [];
      const meta = (m.lastPushedPayload ?? {}) as { wooType?: string; remoteParentId?: string | null };
      const type = meta.wooType ?? (item.kind === "variant_parent" ? "variable" : item.kind === "variant_child" ? "variation" : "simple");
      return [
        {
          remoteId: m.remoteId,
          localId: m.localId,
          name: item.name,
          sku: item.sku,
          wooType: type,
          itemKind: item.kind,
          sellable: isSellableWooProduct({ type }),
          priceRial: item.unit_price === null ? null : BigInt(item.unit_price),
          quantity: item.quantity === null ? null : Number(item.quantity),
          parentRemoteId: meta.remoteParentId ?? null,
          categories: (categories.get(m.remoteId) ?? []).map((c) => c.name).filter(Boolean),
          attributes: attributesByItem.get(m.localId) ?? [],
        },
      ];
    }),
  };
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
  return rows[0]?.last_pushed_payload?.remoteParentId ?? null;
}
