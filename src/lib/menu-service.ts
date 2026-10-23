import { getPool, isPinnedToTransaction, query, withTenantTransaction } from "./db";
import type { PoolClient } from "pg";
import { businessIdForLocation } from "./plan-limits";
import { changeMenuItemPrice, type PriceChangeSource } from "./menu-price-service";
import {
  assertAttachmentSatisfiable,
  assertGroupAttachable,
  assertGroupBoundsSatisfiable,
  assertModifierRemovalSafe,
} from "./menu-modifier-integrity";
import { DEFAULT_SELECTION_BOUNDS, resolveSelectionBounds } from "./modifier-selection";
import type {
  CategoryCreateInput,
  CategoryPatchInput,
  MenuItemCreateInput,
  ModifierCreateInput,
  ModifierGroupCreateInput,
  ModifierGroupPatchInput,
} from "./menu-validation";
import { parsePrice } from "./menu-validation";
import type { MenuItemPatchInput, ModifierPatchInput } from "./menu-validation";

/**
 * The location-scoped menu tree shared by the authenticated dashboard, the
 * public API and the offline pairing snapshot. Keeping the location explicit
 * is what prevents an API key for one branch from reading a sibling branch's
 * menu.
 */
export async function getMenuTree(locationId: string) {
  const [{ rows: categories }, { rows: items }, { rows: modifierGroups }, { rows: modifiers }, { rows: links }] =
    await Promise.all([
      query(
        "SELECT id, name, tax_rate, sort_order, is_active FROM menu_categories WHERE location_id = $1 ORDER BY sort_order, name",
        [locationId],
      ),
      query(
        "SELECT id, category_id, name, description, sku, price, image_url, image_media_id, sort_order, is_active, target_margin_percent FROM menu_items WHERE location_id = $1 ORDER BY sort_order, name",
        [locationId],
      ),
      query(
        "SELECT id, name, min_select, max_select, is_active, sort_order FROM modifier_groups WHERE location_id = $1 ORDER BY sort_order, name",
        [locationId],
      ),
      query(
        "SELECT id, group_id, name, price_delta, sort_order, is_active FROM modifiers WHERE location_id = $1 ORDER BY sort_order, name",
        [locationId],
      ),
      query(
        `SELECT mimg.menu_item_id, mimg.modifier_group_id, mimg.min_select_override, mimg.max_select_override, mimg.sort_order, mimg.is_active
           FROM menu_item_modifier_groups mimg JOIN menu_items mi ON mi.id = mimg.menu_item_id
          WHERE mi.location_id = $1
          ORDER BY mimg.sort_order`,
        [locationId],
      ),
    ]);

  return { categories, items, modifierGroups, modifiers, itemModifierGroups: links };
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

export type ServiceResult = { ok: true } | { ok: false; error: string; status: number };

/**
 * Who/why a caller is patching an item — carried into the canonical price
 * service when the patch contains a price, so the history row and the audit
 * event name the real path (manual / ai / integration / …) instead of
 * guessing. Source is chosen by the calling route/service, never by the
 * request body (issue #844).
 */
export interface MenuItemWriteContext {
  /** The acting member (uuid), or null for a background writer. */
  changedBy?: string | null;
  source?: PriceChangeSource;
  sourceRef?: string | null;
  reason?: string | null;
  note?: string | null;
}

/**
 * One menu write that must read a rule and then write without another request
 * slipping between the two.
 *
 * Every integrity guard in this file is a read-then-write: count the group's
 * remaining active options, compare against the resolved min, then update.
 * On the pool those are separate autocommits on (possibly) separate
 * connections, so two concurrent edits can both pass the check and both write
 * — leaving a required group with no option to select. Inside this helper a
 * pinned client holds `BEGIN`, the guard's reads and the write share one
 * transaction, and the row locks the caller takes (`FOR UPDATE`) stay held
 * until COMMIT. A throw rolls the whole operation back, which is what makes
 * "no partial move" true rather than aspirational.
 *
 * `query()` is deliberately not used inside: it is not pinned to this manual
 * transaction (only `withTenantTransaction` does that), so every statement
 * here goes through the client explicitly.
 */
async function withMenuTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error is the one that explains the failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Serialises every write that can change what a group offers or requires.
 * Taking the group row first is what makes the option-count check and the
 * write that follows it one decision; callers locking two groups must sort
 * their ids (see updateModifier) so opposite moves cannot deadlock.
 */
async function lockGroup(
  client: PoolClient,
  locationId: string,
  groupId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    "SELECT id FROM modifier_groups WHERE id = $1 AND location_id = $2 FOR UPDATE",
    [groupId, locationId],
  );
  return rows.length > 0;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: string }).code === "23505" &&
    (err as { constraint?: string }).constraint === constraint
  );
}

/**
 * `true` when another item of this branch already carries the SKU. The
 * partial unique index (0165) is the race-proof backstop; this check is what
 * gives the operator a named error instead of a 500.
 */
async function skuTakenBy(
  locationId: string,
  sku: string,
  exceptItemId: string | null,
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM menu_items
      WHERE location_id = $1 AND sku = $2 AND ($3::uuid IS NULL OR id <> $3)
      LIMIT 1`,
    [locationId, sku, exceptItemId],
  );
  return rows.length > 0;
}

/** The media asset must be this business's own image — scoped by business_id explicitly, not by ambient RLS. */
async function isValidImageMedia(
  businessId: string,
  mediaId: string,
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM media_assets WHERE id = $1 AND business_id = $2 AND kind = 'image'",
    [mediaId, businessId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Item lifecycle audit — issue #911
// ---------------------------------------------------------------------------

/**
 * The lifecycle events this service writes for a menu item.
 *
 * Selling price is not among them: `menu.item.price_changed` (with its
 * append-only history row) is written by menu-price-service.ts, which is the
 * only writer of that event — these six are the rest of the catalogue's
 * story. Persian labels live in src/lib/audit.ts.
 */
export type MenuItemAuditAction =
  | "menu.item.created"
  | "menu.item.updated"
  | "menu.item.moved"
  | "menu.item.activated"
  | "menu.item.deactivated"
  | "menu.item.deleted";

/**
 * The fields whose change is worth recording for an item: what it is called,
 * where it sits in the catalogue, how the till finds it and whether it sells.
 *
 * Price is deliberately *not* here. A price change has its own event and its
 * own append-only history (`menu.item.price_changed`, written by
 * menu-price-service.ts); listing it here too would double-record every one.
 */
function itemSnapshot(row: {
  name: string;
  category_id: string | null;
  sku: string | null;
  is_active: boolean;
}): Record<string, unknown> {
  return {
    name: row.name,
    categoryId: row.category_id,
    sku: row.sku,
    isActive: row.is_active,
  };
}

/**
 * One `menu.item.*` lifecycle row in the shared audit log.
 *
 * Create, edit, move between categories, activate, deactivate and delete all
 * land here, business-, branch- and actor-scoped, with the before/after of the
 * fields above — the same question the price history answers for money, now
 * answerable for the rest of the catalogue.
 *
 * Written on the caller's own connection (never a second one), so the audit
 * row commits with the change it describes and can never contradict it.
 */
async function recordMenuItemAudit(input: {
  businessId: string | null;
  locationId: string;
  menuItemId: string;
  action: MenuItemAuditAction;
  actorId: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  // No business means no tenant scope to write under; skip rather than fail
  // the change it would have described.
  if (!input.businessId) return;
  await query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, 'menu_item', $5, $6)`,
    [
      input.businessId,
      input.locationId,
      input.actorId,
      input.action,
      input.menuItemId,
      JSON.stringify(input.payload),
    ],
  );
}

/**
 * Which lifecycle event one patch is recorded as.
 *
 * Exactly one per write — a patch that both moves an item and renames it is
 * one «moved» carrying every changed field, not two rows saying the same
 * thing twice. Activation is the most consequential thing a patch can do
 * (it decides whether the till can sell the item at all), so it names the
 * event when it is present; a move is next.
 */
export function auditActionForPatch(
  body: MenuItemPatchInput,
  existing: { category_id: string | null; is_active: boolean },
): MenuItemAuditAction | null {
  if (body.isActive !== undefined && body.isActive !== existing.is_active) {
    return body.isActive ? "menu.item.activated" : "menu.item.deactivated";
  }
  if (body.categoryId !== undefined && body.categoryId !== existing.category_id) {
    return "menu.item.moved";
  }
  return "menu.item.updated";
}

/** Which fields a patch actually changes — the audit payload's `changed` list. */
export function changedFields(body: MenuItemPatchInput): string[] {
  const fields: string[] = [];
  if (body.name !== undefined) fields.push("name");
  if (body.categoryId !== undefined) fields.push("categoryId");
  if (body.description !== undefined) fields.push("description");
  if (body.sku !== undefined) fields.push("sku");
  if (body.imageUrl !== undefined) fields.push("imageUrl");
  if (body.imageMediaId !== undefined) fields.push("imageMediaId");
  if (body.sortOrder !== undefined) fields.push("sortOrder");
  if (body.isActive !== undefined) fields.push("isActive");
  if (body.targetMarginPercent !== undefined) fields.push("targetMarginPercent");
  return fields;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** Creates a category; `defaultTaxRate` is applied when the caller sent none. */
export async function createCategory(
  locationId: string,
  input: CategoryCreateInput,
  defaultTaxRate: number,
): Promise<ServiceResult & { id?: string }> {
  const { rows: dup } = await query(
    "SELECT id FROM menu_categories WHERE location_id = $1 AND name = $2",
    [locationId, input.name],
  );
  if (dup.length > 0) return { ok: false, error: "category_exists", status: 409 };

  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name, tax_rate, sort_order, is_active)
       SELECT $1, $2, $3,
              COALESCE($4::int, (SELECT COALESCE(MAX(mc.sort_order) + 1, 0)
                                   FROM menu_categories mc WHERE mc.location_id = $1)),
              $5
       RETURNING id`,
      [
        locationId,
        input.name,
        input.taxRate ?? defaultTaxRate,
        input.sortOrder ?? null,
        input.isActive ?? true,
      ],
    );
    return { ok: true, id: rows[0].id };
  } catch (err) {
    // Two simultaneous «افزودن» taps both passed the check above; the index
    // (0165) keeps the data clean and this turns the loser into the same
    // named answer rather than a 500.
    if (isUniqueViolation(err, "uq_menu_categories_location_name")) {
      return { ok: false, error: "category_exists", status: 409 };
    }
    throw err;
  }
}

export async function updateCategory(
  locationId: string,
  id: string,
  input: CategoryPatchInput,
): Promise<ServiceResult> {
  const { rows: existing } = await query<{ id: string }>(
    "SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  if (!existing[0]) return { ok: false, error: "category_not_found", status: 404 };

  if (input.name !== undefined) {
    const { rows: dup } = await query(
      "SELECT id FROM menu_categories WHERE location_id = $1 AND name = $2 AND id <> $3",
      [locationId, input.name, id],
    );
    if (dup.length > 0) return { ok: false, error: "category_exists", status: 409 };
  }

  const fields: string[] = [];
  const values: unknown[] = [id];
  let i = 1;
  const set = (column: string, value: unknown) => {
    fields.push(`${column} = $${++i}`);
    values.push(value);
  };
  if (input.name !== undefined) set("name", input.name);
  // Only fields actually present are written, so patching a name can never
  // silently reset a category-specific tax rate back to the default.
  if (input.taxRate !== undefined) set("tax_rate", input.taxRate);
  if (input.sortOrder !== undefined) set("sort_order", input.sortOrder);
  if (input.isActive !== undefined) set("is_active", input.isActive);

  try {
    await query(`UPDATE menu_categories SET ${fields.join(", ")} WHERE id = $1`, values);
    return { ok: true };
  } catch (err) {
    if (isUniqueViolation(err, "uq_menu_categories_location_name")) {
      return { ok: false, error: "category_exists", status: 409 };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------------

export async function createMenuItem(
  locationId: string,
  businessId: string | undefined,
  input: MenuItemCreateInput,
  context?: MenuItemWriteContext,
): Promise<ServiceResult & { id?: string; duplicate?: boolean }> {
  // Callers inside a tenant-scoped request pass the business id straight
  // through; background callers (autopilot) may only know the location.
  const resolvedBusinessId = businessId ?? (await businessIdForLocation(locationId));
  // One save attempt, one key: absent for every importer and sync path, so
  // nothing that was not asked for is deduplicated.
  const createKey = input.idempotencyKey ?? null;
  if (input.imageMediaId && resolvedBusinessId) {
    if (!(await isValidImageMedia(resolvedBusinessId, input.imageMediaId))) {
      return { ok: false, error: "invalid_media", status: 400 };
    }
  }
  const { rows: cat } = await query<{ id: string }>(
    "SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2",
    [input.categoryId, locationId],
  );
  if (cat.length === 0) return { ok: false, error: "category_not_found", status: 404 };

  if (input.sku && (await skuTakenBy(locationId, input.sku, null))) {
    return { ok: false, error: "sku_exists", status: 409 };
  }

  /**
   * A create key that was already used is answered with the item it made,
   * never a second one (issue #911): a retried save is the same save.
   */
  const existingForKey = async (key: string): Promise<string | null> => {
    const { rows } = await query<{ id: string }>(
      "SELECT id FROM menu_items WHERE location_id = $1 AND create_idempotency_key = $2 LIMIT 1",
      [locationId, key],
    );
    return rows[0]?.id ?? null;
  };

  /** The insert, together with the lifecycle row that describes it. */
  const insert = async (): Promise<ServiceResult & { id?: string; duplicate?: boolean }> => {
    // The key is checked on the same connection the insert will use, inside
    // the caller's transaction when there is one, so two concurrent retries
    // cannot both decide they are the first.
    if (createKey) {
      const existing = await existingForKey(createKey);
      if (existing) return { ok: true, id: existing, duplicate: true };
    }
    try {
      // Absent sortOrder → appended after the category's existing rows, the
      // same COALESCE(MAX+1) placement the original route used.
      const { rows } = await query<{ id: string }>(
        `INSERT INTO menu_items
         (location_id, category_id, name, description, sku, price, image_url, image_media_id,
          sort_order, is_active, create_idempotency_key)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8,
              COALESCE($9::int, (SELECT COALESCE(MAX(mi.sort_order) + 1, 0)
                                   FROM menu_items mi
                                  WHERE mi.location_id = $1 AND mi.category_id = $2)),
              $10, $11
       -- Two retries racing each other end here, not in an aborted
       -- transaction: the loser inserts nothing and answers with the
       -- winner's row below (issue #911).
       ON CONFLICT (location_id, create_idempotency_key)
          WHERE create_idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
        [
          locationId,
          input.categoryId,
          input.name,
          input.description ?? null,
          input.sku ?? null,
          input.price,
          input.imageUrl ?? null,
          input.imageMediaId ?? null,
          input.sortOrder ?? null,
          input.isActive ?? true,
          createKey,
        ],
      );
      const createdId = rows[0]?.id;
      if (!createdId) {
        // The key was already used by an attempt that committed first: that
        // item is the answer to this one. (With no key an insert conflict is
        // not possible, so this is unreachable — `sku_exists` below is the
        // only way a keyless insert can fail.)
        const existing = createKey ? await existingForKey(createKey) : null;
        if (existing) return { ok: true, id: existing, duplicate: true };
        return { ok: false, error: "bad_request", status: 400 };
      }
      // The item's first lifecycle row — who put it in the catalogue and as
      // what. The initial price is part of creating the item rather than a
      // price *change*, so no `menu.item.price_changed` row is written here.
      await recordMenuItemAudit({
        businessId: resolvedBusinessId,
        locationId,
        menuItemId: createdId,
        action: "menu.item.created",
        actorId: context?.changedBy ?? null,
        payload: {
          after: {
            name: input.name,
            categoryId: input.categoryId,
            sku: input.sku ?? null,
            isActive: input.isActive ?? true,
          },
        },
      });
      return { ok: true, id: createdId };
    } catch (err) {
      if (isUniqueViolation(err, "uq_menu_items_location_sku")) {
        return { ok: false, error: "sku_exists", status: 409 };
      }
      throw err;
    }
  };

  if (isPinnedToTransaction()) return insert();
  if (!resolvedBusinessId) return insert();
  return withTenantTransaction(resolvedBusinessId, insert, {
    locationId,
    userId: context?.changedBy ?? null,
  });
}

/**
 * A refused edit, carried out of the transaction so it rolls back.
 *
 * `updateMenuItem` answers with a `ServiceResult`, not a throw, but
 * `withTenantTransaction` only rolls back on a throw — so a refusal is
 * wrapped on its way out and unwrapped on the other side. Without it, an
 * update whose price was refused after the generic fields were written would
 * commit those fields and report failure for an edit that half happened
 * (issue #911).
 */
class MenuItemUpdateRefused extends Error {
  constructor(readonly result: ServiceResult) {
    super("menu_item_update_refused");
    this.name = "MenuItemUpdateRefused";
  }
}

/**
 * Remove an item from the catalogue — or deactivate it when something must
 * keep pointing at it (issue #844's rule, now in one place).
 *
 * An item referenced by an order line, and an item that has any price
 * history, are deactivated instead of deleted: an order must keep its
 * reference and the append-only history must not vanish with the row. A
 * business teardown still cascades both away; the DB trigger tells the two
 * cases apart.
 *
 * Either outcome is recorded in the audit log, named for what actually
 * happened to the item.
 */
export async function deleteMenuItem(
  locationId: string,
  id: string,
  businessId?: string,
  context?: MenuItemWriteContext,
): Promise<ServiceResult & { deactivated?: boolean }> {
  const resolvedBusinessId = businessId ?? (await businessIdForLocation(locationId));

  const remove = async (): Promise<ServiceResult & { deactivated?: boolean }> => {
    const { rows: existing } = await query<{
      id: string;
      name: string;
      category_id: string | null;
      sku: string | null;
      is_active: boolean;
    }>(
      "SELECT id, name, category_id, sku, is_active FROM menu_items WHERE id = $1 AND location_id = $2",
      [id, locationId],
    );
    const current = existing[0];
    if (!current) return { ok: false, error: "item_not_found", status: 404 };

    const { rows: refs } = await query(
      "SELECT id FROM order_items WHERE menu_item_id = $1 LIMIT 1",
      [id],
    );
    const { rows: history } = await query(
      "SELECT id FROM menu_item_price_history WHERE menu_item_id = $1 LIMIT 1",
      [id],
    );
    const deactivated = refs.length > 0 || history.length > 0;
    if (deactivated) {
      await query("UPDATE menu_items SET is_active = false, updated_at = now() WHERE id = $1", [
        id,
      ]);
    } else {
      await query("DELETE FROM menu_items WHERE id = $1 AND location_id = $2", [id, locationId]);
    }

    await recordMenuItemAudit({
      businessId: resolvedBusinessId,
      locationId,
      menuItemId: id,
      action: deactivated ? "menu.item.deactivated" : "menu.item.deleted",
      actorId: context?.changedBy ?? null,
      payload: { before: itemSnapshot(current), deactivated },
    });

    return { ok: true, deactivated };
  };

  if (isPinnedToTransaction()) return remove();
  if (!resolvedBusinessId) return remove();
  return withTenantTransaction(resolvedBusinessId, remove, {
    locationId,
    userId: context?.changedBy ?? null,
  });
}

export async function updateMenuItem(
  locationId: string,
  id: string,
  body: MenuItemPatchInput,
  businessId?: string,
  context?: MenuItemWriteContext,
): Promise<ServiceResult> {
  const resolvedBusinessId = businessId ?? (await businessIdForLocation(locationId));

  /**
   * One item edit, start to finish.
   *
   * The generic fields and the price are one business operation, so they are
   * written as one: the old code UPDATed the non-price fields first and only
   * then ran the price change, so a body carrying both could leave the
   * rename/activation committed and the price refused — the caller saw an
   * error for an edit that had already half happened (issue #911).
   */
  const apply = async (): Promise<ServiceResult> => {
    const { rows: existing } = await query<{
      id: string;
      category_id: string | null;
      name: string;
      sku: string | null;
      is_active: boolean;
    }>(
      "SELECT id, category_id, name, sku, is_active FROM menu_items WHERE id = $1 AND location_id = $2",
      [id, locationId],
    );
    const current = existing[0];
    if (!current) return { ok: false, error: "item_not_found", status: 404 };

    // The price is validated *before* anything is written. A refused price
    // has to leave the row exactly as it was — the old order (fields first,
    // price second) committed the rename and then reported the failure.
    if (body.price !== undefined) {
      if (!resolvedBusinessId) {
        // Without a business there is no history row and no audit event — and
        // a price change with no history is exactly the bug this replaces.
        return { ok: false, error: "missing_fields", status: 400 };
      }
      if (!parsePrice(body.price).ok) return { ok: false, error: "invalid_price", status: 400 };
    }

    if (body.categoryId !== undefined) {
      const { rows: category } = await query(
        "SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2",
        [body.categoryId, locationId],
      );
      if (category.length === 0) return { ok: false, error: "category_not_found", status: 404 };
    }
    if (body.sku && (await skuTakenBy(locationId, body.sku, id))) {
      return { ok: false, error: "sku_exists", status: 409 };
    }
    if (body.imageMediaId && resolvedBusinessId) {
      if (!(await isValidImageMedia(resolvedBusinessId, body.imageMediaId))) {
        return { ok: false, error: "invalid_media", status: 400 };
      }
    }

    const fields: string[] = [];
    const values: unknown[] = [id, locationId];
    let parameterIndex = 2;
    const set = (column: string, value: unknown) => {
      parameterIndex += 1;
      fields.push(column + " = $" + parameterIndex);
      values.push(value);
    };

    if (body.categoryId !== undefined) set("category_id", body.categoryId);
    if (body.name !== undefined) set("name", body.name);
    if (body.description !== undefined) set("description", body.description);
    if (body.sku !== undefined) set("sku", body.sku);
    if (body.imageUrl !== undefined) set("image_url", body.imageUrl);
    if (body.imageMediaId !== undefined) set("image_media_id", body.imageMediaId);
    if (body.sortOrder !== undefined) set("sort_order", body.sortOrder);
    if (body.isActive !== undefined) set("is_active", body.isActive);
    if (body.targetMarginPercent !== undefined) {
      set("target_margin_percent", body.targetMarginPercent);
    }

    // A move to a *different* category re-indexes the item at the end of the
    // destination (unless the caller said where it goes): keeping the source's
    // sort_order left the item wedged mid-list in the destination, silently
    // displacing or colliding with the rows already there (issue #844).
    if (
      body.categoryId !== undefined &&
      body.categoryId !== current.category_id &&
      body.sortOrder === undefined
    ) {
      const { rows: tail } = await query<{ next: number }>(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM menu_items WHERE location_id = $1 AND category_id = $2",
        [locationId, body.categoryId],
      );
      set("sort_order", tail[0]?.next ?? 0);
    }

    // A price is no longer an ordinary patch field: it is a domain operation
    // with its own immutable history (issue #844), applied below through the
    // canonical service. A price-only patch therefore has no generic fields —
    // which is expected, not a bad request.
    if (fields.length === 0 && body.price === undefined) {
      return { ok: false, error: "bad_request", status: 400 };
    }

    if (fields.length > 0) {
      set("updated_at", new Date());
      try {
        const result = await query(
          "UPDATE menu_items SET " + fields.join(", ") + " WHERE id = $1 AND location_id = $2",
          values,
        );
        if (result.rowCount !== 1) return { ok: false, error: "item_not_found", status: 404 };
      } catch (err) {
        if (isUniqueViolation(err, "uq_menu_items_location_sku")) {
          return { ok: false, error: "sku_exists", status: 409 };
        }
        throw err;
      }
    }

    if (body.price !== undefined) {
      // Restated from the guard above: the compiler cannot carry the earlier
      // narrowing into this closure, and a price change with no business is
      // still the one thing that must never be written.
      const business = resolvedBusinessId;
      if (!business) return { ok: false, error: "missing_fields", status: 400 };
      const change = await changeMenuItemPrice({
        businessId: business,
        locationId,
        menuItemId: id,
        newPrice: body.price,
        source: context?.source ?? "manual",
        changedBy: context?.changedBy ?? null,
        sourceRef: context?.sourceRef ?? null,
        reason: context?.reason ?? null,
        note: context?.note ?? null,
      });
      if (!change.ok) return { ok: false, error: change.error, status: change.status };
    }

    // The lifecycle audit row. A price-only patch records nothing here: the
    // price change wrote its own `menu.item.price_changed` event and history
    // row, and a second row for the same write would be double bookkeeping.
    const changed = changedFields(body);
    const action = changed.length > 0 ? auditActionForPatch(body, current) : null;
    if (action) {
      await recordMenuItemAudit({
        businessId: resolvedBusinessId,
        locationId,
        menuItemId: id,
        action,
        actorId: context?.changedBy ?? null,
        payload: {
          changed,
          before: itemSnapshot(current),
          after: itemSnapshot({
            name: body.name ?? current.name,
            category_id: body.categoryId ?? current.category_id,
            sku: body.sku !== undefined ? body.sku : current.sku,
            is_active: body.isActive ?? current.is_active,
          }),
        },
      });
    }

    return { ok: true };
  };

  // A caller that is already inside a transaction (data transfer, the
  // importers) joins *that* one — ambient `query()` is pinned to it, so this
  // edit and the caller's own writes commit or roll back together.
  if (isPinnedToTransaction()) return apply();
  // No business means no tenant scope to open a transaction under; the single
  // write then stands alone, exactly as it did before.
  if (!resolvedBusinessId) return apply();
  try {
    return await withTenantTransaction(
      resolvedBusinessId,
      async () => {
        const result = await apply();
        // A refusal reached *after* a statement ran (an item deleted by
        // another writer, a SKU race, a price the service would not accept)
        // must take the whole edit with it. Returning normally would let the
        // wrapper COMMIT the fields already written.
        if (!result.ok) throw new MenuItemUpdateRefused(result);
        return result;
      },
      {
        locationId,
        userId: context?.changedBy ?? null,
      },
    );
  } catch (error) {
    if (error instanceof MenuItemUpdateRefused) return error.result;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Modifier groups
// ---------------------------------------------------------------------------

export async function createModifierGroup(
  locationId: string,
  input: ModifierGroupCreateInput,
): Promise<ServiceResult & { id?: string }> {
  const bounds = resolveSelectionBounds(DEFAULT_SELECTION_BOUNDS, input);
  if (!bounds) return { ok: false, error: "missing_fields", status: 400 };

  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO modifier_groups (location_id, name, min_select, max_select, sort_order, is_active)
       SELECT $1, $2, $3, $4,
              COALESCE($5::int, (SELECT COALESCE(MAX(g.sort_order) + 1, 0)
                                   FROM modifier_groups g WHERE g.location_id = $1)),
              $6
       RETURNING id`,
      [
        locationId,
        input.name,
        bounds.min,
        bounds.max,
        // Absent → appended after this branch's existing groups. It used to
        // default to 0, so every group created without an explicit order
        // piled onto the same slot and the POS's group order came down to
        // name-tiebreak luck (issue #844).
        input.sortOrder ?? null,
        input.isActive ?? true,
      ],
    );
    return { ok: true, id: rows[0].id };
  } catch (err) {
    if (isUniqueViolation(err, "uq_modifier_groups_location_name")) {
      return { ok: false, error: "group_name_exists", status: 409 };
    }
    throw err;
  }
}

export async function updateModifierGroup(
  locationId: string,
  id: string,
  input: ModifierGroupPatchInput,
): Promise<ServiceResult> {
  try {
    return await withMenuTransaction(async (client) => {
      const { rows: existing } = await client.query<{
        id: string;
        min_select: number;
        max_select: number;
        is_active: boolean;
      }>(
        "SELECT id, min_select, max_select, is_active FROM modifier_groups WHERE id = $1 AND location_id = $2 FOR UPDATE",
        [id, locationId],
      );
      const group = existing[0];
      if (!group) return { ok: false, error: "group_not_found", status: 404 };

      if (input.name !== undefined) {
        const { rows: dup } = await client.query(
          "SELECT id FROM modifier_groups WHERE location_id = $1 AND name = $2 AND id <> $3 AND is_active",
          [locationId, input.name, id],
        );
        if (dup.length > 0) return { ok: false, error: "group_name_exists", status: 409 };
      }

      const bounds =
        input.minSelect !== undefined || input.maxSelect !== undefined
          ? resolveSelectionBounds(
              { min: group.min_select, max: group.max_select },
              input,
            )
          : null;
      if (
        (input.minSelect !== undefined || input.maxSelect !== undefined) &&
        bounds === null
      ) {
        return { ok: false, error: "missing_fields", status: 400 };
      }

      const becomingActive = input.isActive === true && !group.is_active;
      const boundsChanging =
        bounds !== null && (bounds.min !== group.min_select || bounds.max !== group.max_select);

      // A group that is (or is becoming) offered for sale must stay satisfiable
      // for every item that carries it — resolved through each item's own
      // overrides, which is why this cannot be a plain CHECK constraint. The
      // row lock above holds until COMMIT, so a concurrent option removal
      // cannot invalidate the answer between this check and the UPDATE.
      if ((group.is_active || becomingActive) && (boundsChanging || becomingActive)) {
        const nextBounds = bounds ?? { min: group.min_select, max: group.max_select };
        const check = await assertGroupBoundsSatisfiable(locationId, id, nextBounds, {
          assumeActive: becomingActive,
          client,
        });
        if (!check.ok) return check;
      }

      const fields: string[] = [];
      const values: unknown[] = [id];
      let i = 1;
      const set = (column: string, value: unknown) => {
        fields.push(`${column} = $${++i}`);
        values.push(value);
      };
      if (input.name !== undefined) set("name", input.name);
      if (input.minSelect !== undefined && bounds) set("min_select", bounds.min);
      if (input.maxSelect !== undefined && bounds) set("max_select", bounds.max);
      if (input.sortOrder !== undefined) set("sort_order", input.sortOrder);
      if (input.isActive !== undefined) set("is_active", input.isActive);
      if (fields.length === 0) return { ok: false, error: "bad_request", status: 400 };

      await client.query(
        `UPDATE modifier_groups SET ${fields.join(", ")} WHERE id = $1`,
        values,
      );
      return { ok: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, "uq_modifier_groups_location_name")) {
      return { ok: false, error: "group_name_exists", status: 409 };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Modifiers (add-on options)
// ---------------------------------------------------------------------------

export async function createModifier(
  locationId: string,
  input: ModifierCreateInput,
): Promise<ServiceResult & { id?: string }> {
  const { rows: group } = await query<{ id: string }>(
    "SELECT id FROM modifier_groups WHERE id = $1 AND location_id = $2",
    [input.groupId, locationId],
  );
  if (group.length === 0) return { ok: false, error: "group_not_found", status: 404 };

  const { rows: dup } = await query(
    "SELECT id FROM modifiers WHERE group_id = $1 AND name = $2 AND is_active",
    [input.groupId, input.name],
  );
  if (dup.length > 0) return { ok: false, error: "modifier_exists", status: 409 };

  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO modifiers (location_id, group_id, name, price_delta, sort_order, is_active)
       SELECT $1, $2, $3, $4,
              COALESCE($5::int, (SELECT COALESCE(MAX(m.sort_order) + 1, 0)
                                   FROM modifiers m WHERE m.group_id = $2)),
              $6
       RETURNING id`,
      [
        locationId,
        input.groupId,
        input.name,
        input.priceDelta ?? 0,
        input.sortOrder ?? null,
        input.isActive ?? true,
      ],
    );
    return { ok: true, id: rows[0].id };
  } catch (err) {
    if (isUniqueViolation(err, "uq_modifiers_group_name")) {
      return { ok: false, error: "modifier_exists", status: 409 };
    }
    throw err;
  }
}

export async function updateModifier(
  locationId: string,
  id: string,
  body: ModifierPatchInput,
): Promise<ServiceResult> {
  try {
    return await withMenuTransaction(async (client) => {
      const { rows: existing } = await client.query<{
        group_id: string;
        is_active: boolean;
      }>(
        "SELECT group_id, is_active FROM modifiers WHERE id = $1 AND location_id = $2 FOR UPDATE",
        [id, locationId],
      );
      const modifier = existing[0];
      if (!modifier) return { ok: false, error: "modifier_not_found", status: 404 };

      /** A patch naming the group the modifier is already in changes nothing, but isn't an error. */
      let groupChecked = body.groupId !== undefined && body.groupId === modifier.group_id;
      let movingGroups = false;
      const destinationGroupId =
        body.groupId !== undefined && body.groupId !== modifier.group_id
          ? body.groupId
          : null;

      // Lock every group whose satisfiability this write can change — the
      // source (losing an active option) and the destination (gaining one) —
      // in id order, so two opposite moves cannot deadlock. Holding them
      // until COMMIT is what makes the guard below and the UPDATE one
      // decision instead of two races.
      const groupIds = [modifier.group_id, ...(destinationGroupId ? [destinationGroupId] : [])]
        .filter((groupId, index, all) => all.indexOf(groupId) === index)
        .sort();
      for (const groupId of groupIds) {
        const locked = await lockGroup(client, locationId, groupId);
        if (groupId === destinationGroupId) {
          if (!locked) return { ok: false, error: "group_not_found", status: 404 };
          groupChecked = true;
          movingGroups = true;
        }
      }

      if (movingGroups && body.name !== undefined && body.groupId !== undefined) {
        const { rows: dup } = await client.query(
          "SELECT id FROM modifiers WHERE group_id = $1 AND name = $2 AND is_active AND id <> $3",
          [body.groupId, body.name, id],
        );
        if (dup.length > 0) return { ok: false, error: "modifier_exists", status: 409 };
      }
      if (!movingGroups && body.name !== undefined) {
        const { rows: dup } = await client.query(
          "SELECT id FROM modifiers WHERE group_id = $1 AND name = $2 AND is_active AND id <> $3",
          [modifier.group_id, body.name, id],
        );
        if (dup.length > 0) return { ok: false, error: "modifier_exists", status: 409 };
      }

      // Leaving the source group — by deactivating OR by moving to another
      // group — takes an active option away from it. Both shapes run the same
      // removal rule: moving the last active option out of a required 1-of-1
      // group is exactly as unorderable as deactivating it. The refusal
      // happens before any UPDATE, and the transaction rolls back, so there
      // is no partial move.
      if (modifier.is_active && (movingGroups || body.isActive === false)) {
        const removal = await assertModifierRemovalSafe(locationId, id, { client });
        if (!removal.ok) return removal;
      }

      const fields: string[] = [];
      const values: unknown[] = [id, locationId];
      let parameterIndex = 2;
      const set = (column: string, value: unknown) => {
        parameterIndex += 1;
        fields.push(column + " = $" + parameterIndex);
        values.push(value);
      };

      if (movingGroups) {
        set("group_id", body.groupId);
        if (body.sortOrder === undefined) {
          fields.push(
            "sort_order = (SELECT COALESCE(MAX(sibling.sort_order) + 1, 0) FROM modifiers sibling" +
              " WHERE sibling.group_id = $" + parameterIndex + ")",
          );
        }
      }
      if (body.name !== undefined) set("name", body.name);
      if (body.priceDelta !== undefined) set("price_delta", body.priceDelta);
      if (body.sortOrder !== undefined) set("sort_order", body.sortOrder);
      if (body.isActive !== undefined) set("is_active", body.isActive);

      if (fields.length === 0) {
        return groupChecked ? { ok: true } : { ok: false, error: "bad_request", status: 400 };
      }

      const result = await client.query(
        "UPDATE modifiers SET " + fields.join(", ") + " WHERE id = $1 AND location_id = $2",
        values,
      );
      if (result.rowCount !== 1) return { ok: false, error: "modifier_not_found", status: 404 };
      return { ok: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, "uq_modifiers_group_name")) {
      return { ok: false, error: "modifier_exists", status: 409 };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Item ↔ group attachments
// ---------------------------------------------------------------------------

export async function attachModifierGroupToItem(
  locationId: string,
  menuItemId: string,
  modifierGroupId: string,
  overrides: {
    minSelectOverride?: number | null;
    maxSelectOverride?: number | null;
    sortOrder?: number;
  } = {},
  options: {
    /**
     * Import/clone only. A disabled group that an item carries is a legitimate
     * stored state — deactivating a group leaves its links in place — so a
     * restorer must be able to reproduce it. Every interactive caller leaves
     * this off and gets `group_inactive`.
     */
    allowInactiveGroup?: boolean;
  } = {},
): Promise<ServiceResult> {
  return withMenuTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM menu_items WHERE id = $1 AND location_id = $3
       UNION ALL
       SELECT 1 FROM modifier_groups WHERE id = $2 AND location_id = $3`,
      [menuItemId, modifierGroupId, locationId],
    );
    if (rows.length !== 2) return { ok: false, error: "not_found", status: 404 };

    // Lock the ITEM first, then the group (issue #910, concurrency).
    //
    // The insert below appends with `MAX(sort_order) + 1` for this item. Two
    // managers attaching two *different* groups to the same item lock two
    // different group rows, so nothing serialised them: both read the same
    // MAX and both wrote the same slot, leaving two links on one position and
    // a POS order decided by the tie-break. Holding the item row for the
    // duration of the appends makes the position unique per item. The order
    // (item → group → link) is the same one detach and the item reorder take,
    // so the three cannot deadlock against each other.
    const { rows: itemRows } = await client.query(
      "SELECT id FROM menu_items WHERE id = $1 AND location_id = $2 FOR UPDATE",
      [menuItemId, locationId],
    );
    if (!itemRows[0]) return { ok: false, error: "not_found", status: 404 };

    // Serialise against option removal/activation on the group: the count the
    // guard reads must still hold when the attachment is written.
    if (!(await lockGroup(client, locationId, modifierGroupId))) {
      return { ok: false, error: "not_found", status: 404 };
    }

    // A disabled group is dropped by the POS index: attaching it would write a
    // link no till ever shows, and a required one would make the item look
    // configured while it cannot be sold. The picker hides these; the service
    // refuses them so a direct API call, a stale selection or an import cannot
    // write one. Re-enable the group first (PATCH /api/menu/modifier-groups/[id]).
    if (!options.allowInactiveGroup) {
      const attachable = await assertGroupAttachable(locationId, modifierGroupId, { client });
      if (!attachable.ok) return attachable;
    }

    // A required group attached with fewer active options than its min would
    // be unorderable from the moment it appears.
    const check = await assertAttachmentSatisfiable(
      locationId,
      menuItemId,
      modifierGroupId,
      overrides,
      { client },
    );
    if (!check.ok) return check;

    await client.query(
      `INSERT INTO menu_item_modifier_groups
         (menu_item_id, modifier_group_id, min_select_override, max_select_override, sort_order, is_active)
       SELECT $1, $2, $3, $4,
              COALESCE($5::int, (SELECT COALESCE(MAX(l.sort_order) + 1, 0)
                                   FROM menu_item_modifier_groups l WHERE l.menu_item_id = $1)),
              true
       ON CONFLICT (menu_item_id, modifier_group_id) DO UPDATE
         SET min_select_override = EXCLUDED.min_select_override,
             max_select_override = EXCLUDED.max_select_override,
             sort_order = EXCLUDED.sort_order,
             is_active = true`,
      [
        menuItemId,
        modifierGroupId,
        overrides.minSelectOverride ?? null,
        overrides.maxSelectOverride ?? null,
        overrides.sortOrder ?? null,
      ],
    );
    return { ok: true };
  });
}

export async function detachModifierGroupFromItem(
  locationId: string,
  menuItemId: string,
  modifierGroupId: string,
): Promise<ServiceResult> {
  // Pinned to one transaction: detaching removes a row whose position the item
  // reorder rewrites (`reorderItemModifierGroups` locks every link of the item
  // and reassigns 0..n-1). Without the same lock a detach landing mid-reorder
  // would make the reorder's "exactly these ids" check read one list and write
  // another, leaving a gap or a duplicate slot in the POS order. The locks are
  // taken in the order id → group → link, the order attach and the reorder use.
  return withMenuTransaction(async (client) => {
    const { rows: itemRows } = await client.query(
      "SELECT id FROM menu_items WHERE id = $1 AND location_id = $2 FOR UPDATE",
      [menuItemId, locationId],
    );
    if (!itemRows[0]) return { ok: false, error: "not_found", status: 404 };
    if (!(await lockGroup(client, locationId, modifierGroupId))) {
      return { ok: false, error: "not_found", status: 404 };
    }

    // Idempotent on purpose: a retried detach (or one racing another editor)
    // still leaves the link gone, which is what the caller asked for. A 404
    // here would read as "no such item" to the sheet's error banner.
    const { rowCount } = await client.query(
      `DELETE FROM menu_item_modifier_groups
        WHERE menu_item_id = $1 AND modifier_group_id = $2`,
      [menuItemId, modifierGroupId],
    );

    // Close the gap the removal leaves (0,1,2,3 → remove 1 → 0,1,2). The item
    // editor prints «ترتیب N» straight from these values and the POS renders
    // the links in this order, so a hole is a number the manager can see but
    // never fix with the arrows: the reorder route renumbers densely the next
    // time it runs, and until then the sheet shows "ترتیب ۴" of three rows.
    if (rowCount) {
      await client.query(
        `UPDATE menu_item_modifier_groups l
            SET sort_order = p.position
           FROM (SELECT modifier_group_id,
                        row_number() OVER (
                          ORDER BY sort_order, modifier_group_id
                        ) - 1 AS position
                   FROM menu_item_modifier_groups
                  WHERE menu_item_id = $1) p
          WHERE l.menu_item_id = $1
            AND l.modifier_group_id = p.modifier_group_id
            AND l.sort_order IS DISTINCT FROM p.position`,
        [menuItemId],
      );
    }
    return { ok: true };
  });
}

/** Re-configures one item's attachment (per-item bounds / order / on-off). */
export async function updateItemModifierGroup(
  locationId: string,
  menuItemId: string,
  modifierGroupId: string,
  input: {
    minSelectOverride?: number | null;
    maxSelectOverride?: number | null;
    sortOrder?: number;
    isActive?: boolean;
  },
): Promise<ServiceResult> {
  return withMenuTransaction(async (client) => {
    // Locks are taken item → group → link, the order attach, detach and the
    // item reorder use. Taking the link first (as this did) let a detach hold
    // the group while waiting for the link a re-configuration held, and vice
    // versa: the two editors could deadlock instead of the second waiting.
    const { rows: itemRows } = await client.query(
      "SELECT id FROM menu_items WHERE id = $1 AND location_id = $2 FOR UPDATE",
      [menuItemId, locationId],
    );
    if (!itemRows[0]) return { ok: false, error: "not_found", status: 404 };

    // The link row itself: two editors re-configuring the same attachment must
    // not both read the old overrides and write over each other.
    const { rows: existing } = await client.query<{
      min_select_override: number | null;
      max_select_override: number | null;
    }>(
      `SELECT mimg.min_select_override, mimg.max_select_override
         FROM menu_item_modifier_groups mimg
         JOIN menu_items mi ON mi.id = mimg.menu_item_id
        WHERE mimg.menu_item_id = $1 AND mimg.modifier_group_id = $2 AND mi.location_id = $3
        FOR UPDATE OF mimg`,
      [menuItemId, modifierGroupId, locationId],
    );
    if (!existing[0]) return { ok: false, error: "not_found", status: 404 };

    await lockGroup(client, locationId, modifierGroupId);

    const nextOverrides = {
      minSelectOverride:
        input.minSelectOverride !== undefined
          ? input.minSelectOverride
          : existing[0].min_select_override,
      maxSelectOverride:
        input.maxSelectOverride !== undefined
          ? input.maxSelectOverride
          : existing[0].max_select_override,
    };

    if (input.isActive === true) {
      // Re-enabling an attachment to a group that was disabled in the meantime
      // would restore a link the POS drops.
      const attachable = await assertGroupAttachable(locationId, modifierGroupId, { client });
      if (!attachable.ok) return attachable;
    }

    if (input.isActive !== false) {
      // Keeping the attachment offered: the resolved bounds must stay
      // satisfiable against the group's active options.
      const check = await assertAttachmentSatisfiable(
        locationId,
        menuItemId,
        modifierGroupId,
        nextOverrides,
        { client },
      );
      if (!check.ok) return check;
    }

    const fields: string[] = [];
    const values: unknown[] = [menuItemId, modifierGroupId];
    let i = 2;
    const set = (column: string, value: unknown) => {
      fields.push(`${column} = $${++i}`);
      values.push(value);
    };
    if (input.minSelectOverride !== undefined) set("min_select_override", input.minSelectOverride);
    if (input.maxSelectOverride !== undefined) set("max_select_override", input.maxSelectOverride);
    if (input.sortOrder !== undefined) set("sort_order", input.sortOrder);
    if (input.isActive !== undefined) set("is_active", input.isActive);
    if (fields.length === 0) return { ok: false, error: "bad_request", status: 400 };

    await client.query(
      `UPDATE menu_item_modifier_groups SET ${fields.join(", ")}
        WHERE menu_item_id = $1 AND modifier_group_id = $2`,
      values,
    );
    return { ok: true };
  });
}

export async function deleteModifierGroup(
  locationId: string,
  id: string,
): Promise<
  ServiceResult & {
    deactivated?: boolean;
    affected?: { items: number; options: number };
  }
> {
  return withMenuTransaction(async (client) => {
    const { rows: group } = await client.query<{ id: string }>(
      "SELECT id FROM modifier_groups WHERE id = $1 AND location_id = $2 FOR UPDATE",
      [id, locationId],
    );
    if (!group[0]) return { ok: false, error: "group_not_found", status: 404 };

    const { rows: linkRows } = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM menu_item_modifier_groups WHERE modifier_group_id = $1",
      [id],
    );
    const { rows: optionRows } = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM modifiers WHERE group_id = $1",
      [id],
    );
    const { rows: soldRows } = await client.query(
      `SELECT 1 FROM order_item_modifiers oim
         JOIN modifiers m ON m.id = oim.modifier_id
        WHERE m.group_id = $1 LIMIT 1`,
      [id],
    );
    const { rows: recipeRows } = await client.query(
      `SELECT 1 FROM modifier_ingredients mi
         JOIN modifiers m ON m.id = mi.modifier_id
        WHERE m.group_id = $1 LIMIT 1`,
      [id],
    );

    const affected = {
      items: Number(linkRows[0]?.count ?? 0),
      options: Number(optionRows[0]?.count ?? 0),
    };

    // Destructive DELETE cascades BOTH the group's options and every item
    // attachment, which is only ever safe for a group nothing references:
    // no item uses it, it has no options left, none of its options has a
    // recipe, and none has been sold. Anything else is deactivated instead —
    // the same reversible lifecycle items, categories and options follow —
    // so a menu edit cannot silently erase configuration or break the
    // required-selection rules of the items that carry it. Order history is
    // snapshot-based and untouched either way.
    const inUse =
      affected.items > 0 ||
      affected.options > 0 ||
      soldRows.length > 0 ||
      recipeRows.length > 0;
    if (inUse) {
      await client.query("UPDATE modifier_groups SET is_active = false WHERE id = $1", [id]);
      return { ok: true, deactivated: true, affected };
    }
    await client.query("DELETE FROM modifier_groups WHERE id = $1", [id]);
    return { ok: true, deactivated: false, affected };
  });
}

/** Guard for the modifier DELETE route: deactivating must stay satisfiable. */
export async function deleteModifier(
  locationId: string,
  id: string,
): Promise<ServiceResult & { deactivated?: boolean }> {
  return withMenuTransaction(async (client) => {
    const { rows } = await client.query<{ group_id: string }>(
      "SELECT group_id FROM modifiers WHERE id = $1 AND location_id = $2 FOR UPDATE",
      [id, locationId],
    );
    const modifier = rows[0];
    if (!modifier) return { ok: false, error: "modifier_not_found", status: 404 };

    await lockGroup(client, locationId, modifier.group_id);

    const { rows: soldRows } = await client.query(
      "SELECT 1 FROM order_item_modifiers WHERE modifier_id = $1 LIMIT 1",
      [id],
    );
    // Deleting an option cascades its ingredient links too. Losing a recipe
    // (or a sold reference) is configuration/history loss, so those options
    // are deactivated — never hard-deleted — exactly like sold ones.
    const { rows: recipeRows } = await client.query(
      "SELECT 1 FROM modifier_ingredients WHERE modifier_id = $1 LIMIT 1",
      [id],
    );

    // A still-required option must not go, whether it would be deleted or
    // deactivated: the group's items could no longer be ordered.
    const check = await assertModifierRemovalSafe(locationId, id, { client });
    if (!check.ok) return check;

    if (soldRows.length > 0 || recipeRows.length > 0) {
      await client.query("UPDATE modifiers SET is_active = false WHERE id = $1", [id]);
      return { ok: true, deactivated: true };
    }
    await client.query("DELETE FROM modifiers WHERE id = $1", [id]);
    return { ok: true, deactivated: false };
  });
}

// ---------------------------------------------------------------------------
// Import helper (transaction-scoped)
// ---------------------------------------------------------------------------

/**
 * Attaches `groupId` to `itemId` inside an import transaction, with the same
 * satisfiability rule the interactive attach enforces.
 */
export async function attachGroupInTransaction(
  client: PoolClient,
  locationId: string,
  menuItemId: string,
  modifierGroupId: string,
  overrides: { minSelectOverride: number | null; maxSelectOverride: number | null },
): Promise<ServiceResult> {
  // The import and clone path meets the same rule as the screen: a disabled
  // source group must not arrive as a link the POS never offers.
  const attachable = await assertGroupAttachable(locationId, modifierGroupId, {
    client: client as unknown as { query: PoolClient["query"] },
  });
  if (!attachable.ok) return attachable;

  const check = await assertAttachmentSatisfiable(
    locationId,
    menuItemId,
    modifierGroupId,
    overrides,
    { client: client as unknown as { query: PoolClient["query"] } },
  );
  if (!check.ok) return check;
  await client.query(
    `INSERT INTO menu_item_modifier_groups
       (menu_item_id, modifier_group_id, min_select_override, max_select_override, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (menu_item_id, modifier_group_id) DO UPDATE
       SET min_select_override = EXCLUDED.min_select_override,
           max_select_override = EXCLUDED.max_select_override,
           is_active = true`,
    [menuItemId, modifierGroupId, overrides.minSelectOverride, overrides.maxSelectOverride],
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reordering — one atomic statement (issue #844)
// ---------------------------------------------------------------------------

export const MENU_REORDER_ENTITIES = [
  "categories",
  "items",
  "modifierGroups",
  "modifiers",
] as const;

export type MenuReorderEntity = (typeof MENU_REORDER_ENTITIES)[number];

const REORDER_TABLES: Record<MenuReorderEntity, string> = {
  categories: "menu_categories",
  items: "menu_items",
  modifierGroups: "modifier_groups",
  modifiers: "modifiers",
};

export function isMenuReorderEntity(value: unknown): value is MenuReorderEntity {
  return (
    typeof value === "string" &&
    (MENU_REORDER_ENTITIES as readonly string[]).includes(value)
  );
}

/**
 * Persist a complete ordering in ONE statement — and therefore one
 * transaction, automatically.
 *
 * The menu editor used to swap two rows with two sequential PATCH requests
 * (write A's order to B's slot, then B's order to A's slot). A failure after
 * the first write left two rows claiming the same slot, and the next reorder
 * swapped based on that corrupted order — the exact duplicate-sort_order state
 * the issue calls out. One set-based UPDATE assigns every position at once:
 * either the whole ordering lands or none of it does, and a partial failure
 * cannot exist to leave duplicates behind.
 *
 * The caller passes the ids in their new display order; positions are
 * reassigned 0..n-1 over exactly those rows, all verified to belong to this
 * branch first (an id from another branch fails the whole operation rather
 * than silently renumbering someone else's rows).
 */
export async function reorderMenuCollection(
  locationId: string,
  entity: MenuReorderEntity,
  orderedIds: readonly string[],
): Promise<ServiceResult> {
  if (orderedIds.length === 0) return { ok: true };
  if (new Set(orderedIds).size !== orderedIds.length) {
    return { ok: false, error: "bad_request", status: 400 };
  }
  const table = REORDER_TABLES[entity];
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}
      WHERE location_id = $1 AND id = ANY($2::uuid[])`,
    [locationId, [...orderedIds]],
  );
  if (Number(rows[0]?.count ?? 0) !== orderedIds.length) {
    return { ok: false, error: "reorder_mismatch", status: 400 };
  }
  await query(
    `UPDATE ${table} AS t SET sort_order = u.position - 1
       FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id, position)
      WHERE t.id = u.id AND t.location_id = $1`,
    [locationId, [...orderedIds]],
  );
  return { ok: true };
}

/**
 * Persist one item's *attachment* order in ONE statement.
 *
 * The item editor used to swap two links with two sequential PATCHes. A
 * failure after the first left both links claiming the same slot (and the
 * next swap read that corrupted order), which is the same defect #844 fixed
 * for the menu collections. The item-specific order is the precedence the POS,
 * waiter and order editor render, so it has to be stored atomically.
 *
 * `orderedGroupIds` must name every group currently linked to the item — a
 * partial list would leave the omitted links on stale positions and make the
 * resulting order ambiguous. All links belong to the item, and the item to
 * the caller's branch, so no cross-tenant reference can be renumbered.
 */
export async function reorderItemModifierGroups(
  locationId: string,
  menuItemId: string,
  orderedGroupIds: readonly string[],
): Promise<ServiceResult> {
  if (new Set(orderedGroupIds).size !== orderedGroupIds.length) {
    return { ok: false, error: "bad_request", status: 400 };
  }
  return withMenuTransaction(async (client) => {
    const { rows: item } = await client.query<{ id: string }>(
      "SELECT id FROM menu_items WHERE id = $1 AND location_id = $2 FOR UPDATE",
      [menuItemId, locationId],
    );
    if (!item[0]) return { ok: false, error: "item_not_found", status: 404 };

    const { rows: links } = await client.query<{ modifier_group_id: string }>(
      "SELECT modifier_group_id FROM menu_item_modifier_groups WHERE menu_item_id = $1",
      [menuItemId],
    );
    const existing = new Set(links.map((link) => link.modifier_group_id));
    const requested = new Set(orderedGroupIds);
    if (
      existing.size !== requested.size ||
      [...existing].some((groupId) => !requested.has(groupId))
    ) {
      return { ok: false, error: "reorder_mismatch", status: 400 };
    }

    if (orderedGroupIds.length === 0) return { ok: true };
    await client.query(
      `UPDATE menu_item_modifier_groups AS mimg
          SET sort_order = u.position - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id, position)
        WHERE mimg.menu_item_id = $1 AND mimg.modifier_group_id = u.id`,
      [menuItemId, [...orderedGroupIds]],
    );
    return { ok: true };
  });
}
