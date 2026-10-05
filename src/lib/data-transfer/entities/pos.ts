/**
 * POS adapters — menu items, menu categories, modifiers and orders.
 *
 * `menu_items`, `menu_categories`, `modifier_groups` and `modifiers` are all
 * **location-scoped**: they belong to a branch, not to the business, so every
 * statement here keys on `location_id` and the engine refuses the entity
 * without an active branch (`locationScoped: true` in the registry).
 *
 * Orders are export-only and deliberately so: a POS order is the product of a
 * till session with inventory movements, a journal entry and a payment behind
 * it. Importing a row into `orders` would produce revenue with no COGS, no
 * stock decrement and no ledger — a number that looks like a sale and
 * reconciles with nothing. Historical sales belong in a migration importer
 * (`integrations/holoo/imported-sale-service.ts`), which posts stock, ledger
 * and payment alongside the order the way the till does.
 */

import { query } from "../../db";
import { postgresDateToIso } from "../../jalali";
import { getSetting, SETTING_KEYS } from "../../settings";
import {
  attachModifierGroupToItem,
  createCategory,
  createMenuItem,
  updateCategory,
  updateItemModifierGroup,
  updateMenuItem,
} from "../../menu-service";
import {
  validateCategoryCreate,
  validateCategoryPatch,
  validateItemModifierGroupAttach,
  validateItemModifierGroupPatch,
  validateMenuItemCreate,
  validateMenuItemPatch,
} from "../../menu-validation";
import {
  registerAdapter,
  RowRejection,
  type EntityAdapter,
  type WriteOutcome,
} from "../adapters";

function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return postgresDateToIso(value);
  return String(value).slice(0, 10);
}

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** A branch is required for every entity in this file. */
function requireLocation(locationId: string | null): string {
  if (!locationId) throw new RowRejection("شعبهٔ فعالی برای این عملیات انتخاب نشده است.");
  return locationId;
}

/**
 * Translate a menu-domain validation/service error key into the Persian line
 * the row-level skip report shows. These services answer in keys (the routes
 * map them for HTTP); an import row needs the operator's own language.
 */
function menuErrorText(error: string): string {
  switch (error) {
    case "invalid_price":
      return "قیمت آیتم معتبر نیست.";
    case "missing_fields":
      return "اطلاعات آیتم ناقص است.";
    case "bad_request":
      return "ساختار دادهٔ آیتم معتبر نیست.";
    case "sku_exists":
      return "کد کالا تکراری است.";
    case "category_exists":
      return "دستهٔ هم‌نام از قبل وجود دارد.";
    case "category_not_found":
      return "دستهٔ انتخاب‌شده وجود ندارد.";
    case "item_not_found":
      return "آیتم پیدا نشد.";
    case "group_not_found":
      return "گروه افزودنی پیدا نشد.";
    case "invalid_media":
      return "تصویر انتخاب‌شده معتبر نیست.";
    default:
      return `ثبت آیتم انجام نشد (${error}).`;
  }
}

function reject(error: string): never {
  throw new RowRejection(menuErrorText(error));
}

async function resolveCategory(
  locationId: string,
  name: string,
  create: boolean,
): Promise<{ id: string; label: string } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM menu_categories
      WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
    [locationId, trimmed],
  );
  if (rows[0]) return { id: rows[0].id, label: rows[0].name };
  if (!create) return null;
  const parsed = validateCategoryCreate({ name: trimmed });
  if (!parsed.ok) reject(parsed.error);
  const created = await createCategory(locationId, parsed.value, 0);
  if (!created.ok) reject(created.error);
  return created.id ? { id: created.id, label: trimmed } : null;
}

const categoriesAdapter: EntityAdapter = {
  entity: "pos.categories",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT id, name, tax_rate AS "taxRate", sort_order AS "sortOrder",
              is_active AS "isActive"
         FROM menu_categories
        WHERE location_id = $1
        ORDER BY sort_order, name
        LIMIT $2`,
      [locationId, options.limit],
    );
    return rows.map((row) => ({ ...row, taxRate: Number(row.taxRate ?? 0) }));
  },
  async write(context, values, options) {
    const locationId = requireLocation(context.locationId);
    const name = text(values.name);
    if (!name) throw new RowRejection("نام دسته الزامی است.");

    const existing = await resolveCategory(locationId, name, false);
    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `دستهٔ «${name}» از پیش وجود دارد.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      // The menu service's own validator — the same one manual CRUD runs —
      // then the service's UPDATE: import and the category dialog can no
      // longer disagree about what a legal tax rate or sort order is
      // (issue #844: import paths reuse the domain validators).
      // Null/absent means "leave this column alone" (the old coalesce
      // semantics); only what the file actually carries is patched.
      const rawPatch: Record<string, unknown> = {};
      if (values.taxRate !== undefined && values.taxRate !== null) rawPatch.taxRate = values.taxRate;
      if (values.sortOrder !== undefined && values.sortOrder !== null)
        rawPatch.sortOrder = values.sortOrder;
      if (values.isActive !== undefined && values.isActive !== null)
        rawPatch.isActive = values.isActive;
      if (Object.keys(rawPatch).length === 0) return { status: "updated", id: existing.id };
      const patch = validateCategoryPatch(rawPatch);
      if (!patch.ok) reject(patch.error);
      const updated = await updateCategory(locationId, existing.id, patch.value);
      if (!updated.ok) reject(updated.error);
      return { status: "updated", id: existing.id };
    }

    const create = validateCategoryCreate({
      name,
      taxRate: values.taxRate,
      sortOrder: values.sortOrder,
      isActive: values.isActive,
    });
    if (!create.ok) reject(create.error);
    // A file with no tax column creates the category with the business's
    // default rate — exactly what the manual create does — not a silent 0.
    let defaultRate = create.value.taxRate !== undefined ? create.value.taxRate : undefined;
    if (defaultRate === undefined) {
      const tax = await getSetting<{ defaultRate?: number }>(
        context.businessId,
        SETTING_KEYS.tax,
      );
      defaultRate = tax?.defaultRate ?? 0;
    }
    const created = await createCategory(locationId, create.value, defaultRate);
    if (!created.ok) reject(created.error);
    return { status: "created", id: created.id! };
  },
  async resolveReference(context, lookup, { create }) {
    return resolveCategory(requireLocation(context.locationId), lookup, create);
  },
};

const productsAdapter: EntityAdapter = {
  entity: "pos.products",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const where = ["mi.location_id = $1"];
    const params: unknown[] = [locationId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`mi.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.categoryId === "string" && options.filters.categoryId) {
      params.push(options.filters.categoryId);
      where.push(`mi.category_id = $${params.length}::uuid`);
    }
    if (options.filters.activeOnly === true) where.push("mi.is_active");
    if (typeof options.filters.search === "string" && options.filters.search.trim()) {
      params.push(options.filters.search.trim());
      where.push(`mi.name ILIKE '%' || $${params.length} || '%'`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT mi.id, mi.name, mc.name AS "categoryName", mi.price, mi.sku,
              mi.description, mi.image_url AS "imageUrl", mi.image_media_id AS "imageMediaId",
              mi.target_margin_percent AS "targetMarginPercent",
              mi.sort_order AS "sortOrder", mi.is_active AS "isActive",
              mi.created_at AS "createdAt"
         FROM menu_items mi
         LEFT JOIN menu_categories mc ON mc.id = mi.category_id
        WHERE ${where.join(" AND ")}
        ORDER BY mc.sort_order NULLS LAST, mi.sort_order, mi.name
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      price: Number(row.price ?? 0),
      targetMarginPercent:
        row.targetMarginPercent === null || row.targetMarginPercent === undefined
          ? null
          : Number(row.targetMarginPercent),
      createdAt: isoDate(row.createdAt),
    }));
  },
  async write(context, values, options) {
    const locationId = requireLocation(context.locationId);
    const name = text(values.name);
    if (!name) throw new RowRejection("نام آیتم الزامی است.");
    const warnings: string[] = [];
    const writeContext = {
      changedBy: context.actorUserId,
      source: "import" as const,
      sourceRef: "data-transfer",
    };

    let categoryId: string | null = null;
    const categoryName = text(values.categoryName);
    if (categoryName) {
      const strategy = options.relationStrategy.categoryName ?? "create";
      const resolved = await resolveCategory(locationId, categoryName, strategy === "create");
      if (resolved) categoryId = resolved.id;
      else if (strategy === "skip") {
        return { status: "skipped", reason: `دستهٔ «${categoryName}» وجود ندارد.` };
      } else warnings.push(`دستهٔ «${categoryName}» وجود ندارد و آیتم بدون دسته ثبت شد.`);
    }

    const sku = text(values.sku);
    const bySku = async (): Promise<{ id: string } | null> => {
      if (!sku) return null;
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM menu_items
          WHERE location_id = $1 AND lower(btrim(sku)) = lower(btrim($2)) LIMIT 1`,
        [locationId, sku],
      );
      return rows[0] ?? null;
    };

    // Deterministic duplicate identity (issue #844): an explicit rule the
    // operator chose wins; otherwise prefer the SKU whenever the row carries
    // one — it is the item's real identity — and fall back to name+category.
    let existing: { id: string } | null = null;
    if (options.duplicateRule === "sku") {
      existing = await bySku();
    } else if (options.duplicateRule === "name") {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM menu_items
          WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
        [locationId, name],
      );
      existing = rows[0] ?? null;
    } else {
      existing = await bySku();
      if (!existing) {
        const { rows } = await query<{ id: string }>(
          `SELECT id FROM menu_items
            WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2))
              AND category_id IS NOT DISTINCT FROM $3::uuid LIMIT 1`,
          [locationId, name, categoryId],
        );
        existing = rows[0] ?? null;
      }
    }

    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `آیتم «${name}» از پیش در منو هست.` };
    }

    const imageMediaId = text(values.imageMediaId);
    const rawDescription = text(values.description);
    const patchFields: Record<string, unknown> = {
      name,
      description: rawDescription ?? undefined,
      sku: sku ?? undefined,
      imageUrl: text(values.imageUrl) ?? undefined,
      imageMediaId: imageMediaId ?? undefined,
      sortOrder: values.sortOrder ?? undefined,
      isActive: values.isActive ?? undefined,
      targetMarginPercent: values.targetMarginPercent ?? undefined,
    };
    if (categoryId) patchFields.categoryId = categoryId;
    if (values.price !== undefined && values.price !== null) {
      patchFields.price = Number(values.price);
    }

    /**
     * Apply a validated patch through the menu service — import's update and
     * the category dialog now share one code path (validators, SKU races,
     * category-move re-indexing, and the canonical price-change history for
     * any price inside the patch). A media id this business doesn't hold is
     * dropped with a warning instead of failing the whole row: an export
     * moved to another install carries ids that don't exist there.
     */
    const applyPatch = async (id: string, raw: Record<string, unknown>): Promise<{ id: string; warnings: string[] }> => {
      const localWarnings = [...warnings];
      const parsed = validateMenuItemPatch(raw);
      if (!parsed.ok) reject(parsed.error);
      let updated = await updateMenuItem(
        locationId,
        id,
        parsed.value,
        context.businessId,
        writeContext,
      );
      if (!updated.ok && updated.error === "invalid_media" && raw.imageMediaId !== undefined) {
        const { imageMediaId: _dropped, ...rest } = raw;
        localWarnings.push("تصویر انتخاب‌شده در این کسب‌وکار موجود نیست و نادیده گرفته شد.");
        const retry = validateMenuItemPatch(rest);
        if (!retry.ok) reject(retry.error);
        updated = await updateMenuItem(locationId, id, retry.value, context.businessId, writeContext);
      }
      if (!updated.ok) reject(updated.error);
      return { id, warnings: localWarnings };
    };

    if (existing && options.duplicateStrategy === "update") {
      const applied = await applyPatch(existing.id, patchFields);
      return {
        status: "updated",
        id: applied.id,
        ...(applied.warnings.length > 0 ? { warnings: applied.warnings } : {}),
      };
    }

    if (!categoryId) {
      // menu_items.category_id is nullable, but an item nobody can find on the
      // till is not a successful import.
      const fallback = await resolveCategory(locationId, "دسته‌بندی نشده", true);
      categoryId = fallback?.id ?? null;
      warnings.push("آیتم در دستهٔ «دسته‌بندی نشده» ثبت شد.");
    }
    if (!categoryId) reject("missing_fields");

    const createFields: Record<string, unknown> = {
      categoryId,
      name,
      description: rawDescription ?? undefined,
      sku: sku ?? undefined,
      imageUrl: text(values.imageUrl) ?? undefined,
      imageMediaId: imageMediaId ?? undefined,
      sortOrder: values.sortOrder ?? undefined,
      isActive: values.isActive ?? undefined,
    };
    if (values.price !== undefined && values.price !== null) {
      createFields.price = Number(values.price);
    }

    const createdParsed = validateMenuItemCreate(createFields);
    if (!createdParsed.ok) reject(createdParsed.error);
    let created = await createMenuItem(
      locationId,
      context.businessId,
      createdParsed.value,
    );
    if (!created.ok && created.error === "invalid_media" && createFields.imageMediaId !== undefined) {
      const { imageMediaId: _dropped, ...rest } = createFields;
      warnings.push("تصویر انتخاب‌شده در این کسب‌وکار موجود نیست و نادیده گرفته شد.");
      const retry = validateMenuItemCreate(rest);
      if (!retry.ok) reject(retry.error);
      created = await createMenuItem(locationId, context.businessId, retry.value);
    }
    if (!created.ok) reject(created.error);
    const newId = created.id!;

    // targetMarginPercent is a patch-level field; carry it over in its own
    // validated patch when the file provided one.
    if (values.targetMarginPercent !== undefined && values.targetMarginPercent !== null) {
      await applyPatch(newId, { targetMarginPercent: values.targetMarginPercent });
    }

    return {
      status: "created",
      id: newId,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};

/**
 * Item ↔ modifier-group attachments — the parity gap Data Transfer needed
 * before it could replace the legacy menu importer (issue #844).
 *
 * One row per (item, group) link with its per-item min/max overrides, its
 * per-item sort order and the link's own active state — the four facts the
 * manual CRUD owns and a flat item/modifier export silently lost. Attachments
 * never create items or groups: a link to something the file didn't carry is
 * a row-level skip naming exactly what was missing (import `pos.products` and
 * `pos.modifiers` first).
 */
const itemModifierGroupsAdapter: EntityAdapter = {
  entity: "pos.item_modifier_groups",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT mi.name AS "itemName", mi.sku AS "itemSku",
              g.name AS "groupName",
              mimg.min_select_override AS "minSelectOverride",
              mimg.max_select_override AS "maxSelectOverride",
              mimg.sort_order AS "sortOrder", mimg.is_active AS "isActive"
         FROM menu_item_modifier_groups mimg
         JOIN menu_items mi ON mi.id = mimg.menu_item_id
         JOIN modifier_groups g ON g.id = mimg.modifier_group_id
        WHERE mi.location_id = $1
        ORDER BY mi.name, mimg.sort_order, g.name
        LIMIT $2`,
      [locationId, options.limit],
    );
    return rows;
  },
  async write(context, values) {
    const locationId = requireLocation(context.locationId);
    const itemName = text(values.itemName);
    const groupName = text(values.groupName);
    if (!itemName) throw new RowRejection("نام آیتم الزامی است.");
    if (!groupName) throw new RowRejection("نام گروه افزودنی الزامی است.");

    // Item identity: SKU when the row carries one, then the name (the same
    // deterministic order the items entity uses).
    let item: { id: string } | null = null;
    const sku = text(values.itemSku);
    if (sku) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM menu_items WHERE location_id = $1 AND lower(btrim(sku)) = lower(btrim($2)) LIMIT 1`,
        [locationId, sku],
      );
      item = rows[0] ?? null;
    }
    if (!item) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM menu_items WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
        [locationId, itemName],
      );
      item = rows[0] ?? null;
    }
    if (!item) {
      return { status: "skipped", reason: `آیتم «${itemName}» در منو پیدا نشد.` };
    }

    const { rows: groups } = await query<{ id: string }>(
      `SELECT id FROM modifier_groups WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
      [locationId, groupName],
    );
    if (!groups[0]) {
      return {
        status: "skipped",
        reason: `گروه افزودنی «${groupName}» وجود ندارد؛ ابتدا افزودنی‌ها را وارد کنید.`,
      };
    }
    const groupId = groups[0].id;

    const { rows: links } = await query(
      `SELECT 1 FROM menu_item_modifier_groups
        WHERE menu_item_id = $1 AND modifier_group_id = $2`,
      [item.id, groupId],
    );
    const minOverride =
      values.minSelectOverride === undefined || values.minSelectOverride === null
        ? undefined
        : Number(values.minSelectOverride);
    const maxOverride =
      values.maxSelectOverride === undefined || values.maxSelectOverride === null
        ? undefined
        : Number(values.maxSelectOverride);
    const sortOrder =
      values.sortOrder === undefined || values.sortOrder === null
        ? undefined
        : Number(values.sortOrder);

    if (links.length > 0) {
      // Null/absent = leave the link's current state alone; only what the
      // file actually carries is patched. An empty patch is a successful
      // no-op (the HTTP validators call it bad_request for a different
      // reason), so emptiness is decided here, before validation.
      const patchRaw: Record<string, unknown> = {};
      if (minOverride !== undefined) patchRaw.minSelectOverride = minOverride;
      if (maxOverride !== undefined) patchRaw.maxSelectOverride = maxOverride;
      if (sortOrder !== undefined) patchRaw.sortOrder = sortOrder;
      if (values.isActive !== undefined && values.isActive !== null)
        patchRaw.isActive = values.isActive;
      if (Object.keys(patchRaw).length === 0) return { status: "updated", id: item.id };
      const parsed = validateItemModifierGroupPatch(patchRaw);
      if (!parsed.ok) reject(parsed.error);
      const updated = await updateItemModifierGroup(
        locationId,
        item.id,
        groupId,
        parsed.value,
      );
      if (!updated.ok) reject(updated.error);
      return { status: "updated", id: item.id };
    }

    const attach = validateItemModifierGroupAttach({
      menuItemId: item.id,
      modifierGroupId: groupId,
      minSelectOverride: minOverride,
      maxSelectOverride: maxOverride,
      sortOrder,
    });
    if (!attach.ok) reject(attach.error);
    const attached = await attachModifierGroupToItem(
      locationId,
      item.id,
      groupId,
      attach.value,
    );
    if (!attached.ok) reject(attached.error);
    // A link whose file row says inactive is switched off right after attach:
    // attach always creates the link active (it is the "is this offered at
    // all" default), and `isActive: false` in the file is an explicit state.
    if (values.isActive === false) {
      const off = await updateItemModifierGroup(locationId, item.id, groupId, {
        isActive: false,
      });
      if (!off.ok) reject(off.error);
    }
    return { status: "created", id: item.id };
  },
};

const modifiersAdapter: EntityAdapter = {
  entity: "pos.modifiers",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT m.id, g.name AS "groupName", m.name, m.price_delta AS "priceDelta",
              g.min_select AS "minSelect", g.max_select AS "maxSelect",
              m.sort_order AS "sortOrder", m.is_active AS "isActive"
         FROM modifiers m
         JOIN modifier_groups g ON g.id = m.group_id
        WHERE m.location_id = $1
        ORDER BY g.sort_order, g.name, m.sort_order, m.name
        LIMIT $2`,
      [locationId, options.limit],
    );
    return rows.map((row) => ({ ...row, priceDelta: Number(row.priceDelta ?? 0) }));
  },
  async write(context, values, options): Promise<WriteOutcome> {
    const locationId = requireLocation(context.locationId);
    const groupName = text(values.groupName);
    const name = text(values.name);
    if (!groupName) throw new RowRejection("نام گروه افزودنی الزامی است.");
    if (!name) throw new RowRejection("نام افزودنی الزامی است.");

    const { rows: groups } = await query<{ id: string }>(
      `SELECT id FROM modifier_groups
        WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
      [locationId, groupName],
    );
    let groupId = groups[0]?.id ?? null;
    if (!groupId) {
      const { rows: created } = await query<{ id: string }>(
        `INSERT INTO modifier_groups (location_id, name, min_select, max_select, sort_order)
         VALUES ($1, $2, coalesce($3, 0), coalesce($4, 1),
                 (SELECT coalesce(max(sort_order), 0) + 1
                    FROM modifier_groups WHERE location_id = $1))
         RETURNING id`,
        [locationId, groupName, values.minSelect ?? null, values.maxSelect ?? null],
      );
      groupId = created[0].id;
    } else if (values.minSelect !== undefined || values.maxSelect !== undefined) {
      await query(
        `UPDATE modifier_groups
            SET min_select = coalesce($3, min_select), max_select = coalesce($4, max_select)
          WHERE location_id = $1 AND id = $2`,
        [locationId, groupId, values.minSelect ?? null, values.maxSelect ?? null],
      );
    }

    const { rows: existingRows } = await query<{ id: string }>(
      `SELECT id FROM modifiers
        WHERE location_id = $1 AND group_id = $2 AND lower(btrim(name)) = lower(btrim($3))
        LIMIT 1`,
      [locationId, groupId, name],
    );
    const existing = existingRows[0];
    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `افزودنی «${name}» از پیش وجود دارد.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE modifiers
            SET price_delta = coalesce($3, price_delta),
                sort_order = coalesce($4, sort_order),
                is_active = coalesce($5, is_active)
          WHERE location_id = $1 AND id = $2`,
        [
          locationId,
          existing.id,
          values.priceDelta ?? null,
          values.sortOrder ?? null,
          values.isActive ?? null,
        ],
      );
      return { status: "updated", id: existing.id };
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO modifiers (location_id, group_id, name, price_delta, sort_order, is_active)
       VALUES ($1, $2, $3, coalesce($4, 0),
               coalesce($5, (SELECT coalesce(max(sort_order), 0) + 1
                               FROM modifiers WHERE group_id = $2)),
               coalesce($6, true))
       RETURNING id`,
      [
        locationId,
        groupId,
        name,
        values.priceDelta ?? null,
        values.sortOrder ?? null,
        values.isActive ?? null,
      ],
    );
    return { status: "created", id: rows[0].id };
  },
};

const ordersAdapter: EntityAdapter = {
  entity: "pos.orders",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const where = ["o.location_id = $1"];
    const params: unknown[] = [locationId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`o.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.status === "string" && options.filters.status) {
      params.push(options.filters.status);
      where.push(`o.status = $${params.length}::order_status`);
    }
    if (typeof options.filters.dateFrom === "string" && options.filters.dateFrom) {
      params.push(options.filters.dateFrom);
      where.push(`o.opened_at >= $${params.length}::date`);
    }
    if (typeof options.filters.dateTo === "string" && options.filters.dateTo) {
      params.push(options.filters.dateTo);
      where.push(`o.opened_at < ($${params.length}::date + interval '1 day')`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT o.id, o.order_number AS "orderNumber", o.type::text AS type,
              o.status::text AS status, p.name AS "customerName",
              o.subtotal, o.discount, o.tax, o.service_charge AS "serviceCharge",
              o.total, o.note, o.opened_at AS "openedAt", o.closed_at AS "closedAt",
              (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS "itemCount"
         FROM orders o
         LEFT JOIN parties p ON p.id = o.customer_id
        WHERE ${where.join(" AND ")}
        ORDER BY o.opened_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      orderNumber: Number(row.orderNumber ?? 0),
      subtotal: Number(row.subtotal ?? 0),
      discount: Number(row.discount ?? 0),
      tax: Number(row.tax ?? 0),
      serviceCharge: Number(row.serviceCharge ?? 0),
      total: Number(row.total ?? 0),
      openedAt: isoDate(row.openedAt),
      closedAt: isoDate(row.closedAt),
    }));
  },
};

export function registerPosAdapters(): void {
  registerAdapter(categoriesAdapter);
  registerAdapter(productsAdapter);
  registerAdapter(itemModifierGroupsAdapter);
  registerAdapter(modifiersAdapter);
  registerAdapter(ordersAdapter);
}
