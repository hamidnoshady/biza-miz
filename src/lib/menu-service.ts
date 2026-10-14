import { query } from "./db";
import type { PoolClient } from "pg";
import { businessIdForLocation } from "./plan-limits";
import { changeMenuItemPrice, type PriceChangeSource } from "./menu-price-service";
import {
  assertAttachmentSatisfiable,
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
): Promise<ServiceResult & { id?: string }> {
  // Callers inside a tenant-scoped request pass the business id straight
  // through; background callers (autopilot) may only know the location.
  const resolvedBusinessId = businessId ?? (await businessIdForLocation(locationId));
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

  try {
    // Absent sortOrder → appended after the category's existing rows, the
    // same COALESCE(MAX+1) placement the original route used.
    const { rows } = await query<{ id: string }>(
      `INSERT INTO menu_items
         (location_id, category_id, name, description, sku, price, image_url, image_media_id, sort_order, is_active)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8,
              COALESCE($9::int, (SELECT COALESCE(MAX(mi.sort_order) + 1, 0)
                                   FROM menu_items mi
                                  WHERE mi.location_id = $1 AND mi.category_id = $2)),
              $10
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
      ],
    );
    return { ok: true, id: rows[0].id };
  } catch (err) {
    if (isUniqueViolation(err, "uq_menu_items_location_sku")) {
      return { ok: false, error: "sku_exists", status: 409 };
    }
    throw err;
  }
}

export async function updateMenuItem(
  locationId: string,
  id: string,
  body: MenuItemPatchInput,
  businessId?: string,
  context?: MenuItemWriteContext,
): Promise<ServiceResult> {
  const resolvedBusinessId = businessId ?? (await businessIdForLocation(locationId));
  const { rows: existing } = await query<{ id: string; category_id: string | null }>(
    "SELECT id, category_id FROM menu_items WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  if (!existing[0]) return { ok: false, error: "item_not_found", status: 404 };

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
    body.categoryId !== existing[0].category_id &&
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
    if (!resolvedBusinessId) {
      // Without a business there is no history row and no audit event — and
      // a price change with no history is exactly the bug this replaces.
      return { ok: false, error: "missing_fields", status: 400 };
    }
    const change = await changeMenuItemPrice({
      businessId: resolvedBusinessId,
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
  return { ok: true };
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
  const { rows: existing } = await query<{
    id: string;
    min_select: number;
    max_select: number;
    is_active: boolean;
  }>(
    "SELECT id, min_select, max_select, is_active FROM modifier_groups WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  const group = existing[0];
  if (!group) return { ok: false, error: "group_not_found", status: 404 };

  if (input.name !== undefined) {
    const { rows: dup } = await query(
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
  // overrides, which is why this cannot be a plain CHECK constraint.
  if ((group.is_active || becomingActive) && (boundsChanging || becomingActive)) {
    const nextBounds = bounds ?? { min: group.min_select, max: group.max_select };
    const check = await assertGroupBoundsSatisfiable(locationId, id, nextBounds, {
      assumeActive: becomingActive,
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

  try {
    await query(`UPDATE modifier_groups SET ${fields.join(", ")} WHERE id = $1`, values);
    return { ok: true };
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
  const { rows: existing } = await query<{ group_id: string; is_active: boolean }>(
    "SELECT group_id, is_active FROM modifiers WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  if (!existing[0]) return { ok: false, error: "modifier_not_found", status: 404 };

  /** A patch naming the group the modifier is already in changes nothing, but isn't an error. */
  let groupChecked = false;
  let movingGroups = false;

  if (body.groupId !== undefined) {
    const { rows: group } = await query(
      "SELECT id FROM modifier_groups WHERE id = $1 AND location_id = $2",
      [body.groupId, locationId],
    );
    if (group.length === 0) return { ok: false, error: "group_not_found", status: 404 };
    groupChecked = true;
    movingGroups = body.groupId !== existing[0].group_id;
    if (movingGroups && body.name !== undefined) {
      const { rows: dup } = await query(
        "SELECT id FROM modifiers WHERE group_id = $1 AND name = $2 AND is_active AND id <> $3",
        [body.groupId, body.name, id],
      );
      if (dup.length > 0) return { ok: false, error: "modifier_exists", status: 409 };
    }
  }
  if (!movingGroups && body.name !== undefined) {
    const { rows: dup } = await query(
      "SELECT id FROM modifiers WHERE group_id = $1 AND name = $2 AND is_active AND id <> $3",
      [existing[0].group_id, body.name, id],
    );
    if (dup.length > 0) return { ok: false, error: "modifier_exists", status: 409 };
  }

  // Taking the last active option away from a required group would make the
  // group impossible — refuse before the write, naming the rule.
  if (body.isActive === false && existing[0].is_active) {
    const removal = await assertModifierRemovalSafe(locationId, id);
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

  try {
    const result = await query(
      "UPDATE modifiers SET " + fields.join(", ") + " WHERE id = $1 AND location_id = $2",
      values,
    );
    if (result.rowCount !== 1) return { ok: false, error: "modifier_not_found", status: 404 };
    return { ok: true };
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
): Promise<ServiceResult> {
  const { rows } = await query(
    `SELECT 1 FROM menu_items WHERE id = $1 AND location_id = $3
     UNION ALL
     SELECT 1 FROM modifier_groups WHERE id = $2 AND location_id = $3`,
    [menuItemId, modifierGroupId, locationId],
  );
  if (rows.length !== 2) return { ok: false, error: "not_found", status: 404 };

  // A required group attached with fewer active options than its min would be
  // unorderable from the moment it appears.
  const check = await assertAttachmentSatisfiable(
    locationId,
    menuItemId,
    modifierGroupId,
    overrides,
  );
  if (!check.ok) return check;

  await query(
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
}

export async function detachModifierGroupFromItem(
  locationId: string,
  menuItemId: string,
  modifierGroupId: string,
): Promise<ServiceResult> {
  const { rows } = await query(
    `SELECT 1 FROM menu_items WHERE id = $1 AND location_id = $3
     UNION ALL
     SELECT 1 FROM modifier_groups WHERE id = $2 AND location_id = $3`,
    [menuItemId, modifierGroupId, locationId],
  );
  if (rows.length !== 2) return { ok: false, error: "not_found", status: 404 };

  await query(
    "DELETE FROM menu_item_modifier_groups WHERE menu_item_id = $1 AND modifier_group_id = $2",
    [menuItemId, modifierGroupId],
  );
  return { ok: true };
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
  const { rows: existing } = await query<{
    min_select_override: number | null;
    max_select_override: number | null;
  }>(
    `SELECT mimg.min_select_override, mimg.max_select_override
       FROM menu_item_modifier_groups mimg
       JOIN menu_items mi ON mi.id = mimg.menu_item_id
      WHERE mimg.menu_item_id = $1 AND mimg.modifier_group_id = $2 AND mi.location_id = $3`,
    [menuItemId, modifierGroupId, locationId],
  );
  if (!existing[0]) return { ok: false, error: "not_found", status: 404 };

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

  if (input.isActive !== false) {
    // Keeping the attachment offered: the resolved bounds must stay
    // satisfiable against the group's active options.
    const check = await assertAttachmentSatisfiable(
      locationId,
      menuItemId,
      modifierGroupId,
      nextOverrides,
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

  await query(
    `UPDATE menu_item_modifier_groups SET ${fields.join(", ")}
      WHERE menu_item_id = $1 AND modifier_group_id = $2`,
    values,
  );
  return { ok: true };
}

/**
 * Deleting a group destroys its options (CASCADE) and leaves order history on
 * snapshots. When any of its options have ever been sold, the destructive
 * path is refused here and the group is disabled instead — the same
 * deactivate-not-delete rule items, categories and modifiers already follow.
 */
export async function deleteModifierGroup(
  locationId: string,
  id: string,
): Promise<ServiceResult & { deactivated?: boolean }> {
  const { rows: group } = await query<{ id: string }>(
    "SELECT id FROM modifier_groups WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  if (!group[0]) return { ok: false, error: "group_not_found", status: 404 };

  const { rows: refs } = await query(
    `SELECT 1 FROM order_item_modifiers oim
       JOIN modifiers m ON m.id = oim.modifier_id
      WHERE m.group_id = $1 LIMIT 1`,
    [id],
  );
  if (refs.length > 0) {
    await query("UPDATE modifier_groups SET is_active = false WHERE id = $1", [id]);
    return { ok: true, deactivated: true };
  }
  await query("DELETE FROM modifier_groups WHERE id = $1", [id]);
  return { ok: true, deactivated: false };
}

/** Guard for the modifier DELETE route: deactivating must stay satisfiable. */
export async function deleteModifier(
  locationId: string,
  id: string,
): Promise<ServiceResult & { deactivated?: boolean }> {
  const { rows: refs } = await query(
    "SELECT id FROM order_item_modifiers WHERE modifier_id = $1 LIMIT 1",
    [id],
  );
  if (refs.length > 0) {
    const check = await assertModifierRemovalSafe(locationId, id);
    if (!check.ok) return check;
    await query("UPDATE modifiers SET is_active = false WHERE id = $1", [id]);
    return { ok: true, deactivated: true };
  }
  // Unreferenced: still refuse when the group's items depend on this option.
  const check = await assertModifierRemovalSafe(locationId, id);
  if (!check.ok) return check;
  await query("DELETE FROM modifiers WHERE id = $1", [id]);
  return { ok: true, deactivated: false };
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
