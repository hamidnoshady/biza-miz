/**
 * Applies a parsed menu import (menu-import.ts) to a branch's menu.
 *
 * Extracted from the two import routes (onboarding wizard + Settings) so the
 * write path exists exactly once. Both callers used to carry their own — and
 * subtly different — copies: the wizard's bulk upsert and Settings' per-row
 * one, which had already drifted (tax reactivation existed only on the
 * Settings side). One implementation means a fix to the upsert semantics —
 * sort_order, unique-name repair, inactive-row revival — lands for both.
 *
 * The whole apply is one transaction: either the file lands or nothing moves.
 * Import is an *upsert* — a row whose (category, name) already exists has its
 * price/description/sku overwritten, its category re-activated, and its
 * modifiers re-priced and re-activated. That is deliberate: a re-import is
 * how an operator fixes prices in bulk, and rows silently vanishing into an
 * inactive category would be invisible data loss.
 *
 * DB-touching, so per repo convention no direct unit test — the Settings and
 * setup routes cover it end to end.
 */
import { randomUUID } from "node:crypto";
import { getPool } from "./db";
import { businessIdForLocation } from "./plan-limits";
import { changeMenuItemPriceWith, clientExecutor } from "./menu-price-service";
import type { ImportResult } from "./menu-import";

export interface MenuImportCounts {
  createdCategories: number;
  updatedItems: number;
  createdItems: number;
  createdGroups: number;
  createdModifiers: number;
  reactivatedCategories: number;
}

/** Reject ambiguous per-category tax and per-group selection definitions before any rows are written. */
export function menuImportConsistencyErrors(result: ImportResult): string[] {
  const errors: string[] = [];
  const categoryRates = new Map<string, number>();
  const groupRules = new Map<string, string>();
  const modifierPrices = new Map<string, number>();
  for (const item of result.items) {
    if (item.taxRate !== undefined) {
      const current = categoryRates.get(item.category);
      if (current !== undefined && current !== item.taxRate)
        errors.push(`دستهٔ «${item.category}» بیش از یک نرخ مالیات دارد.`);
      categoryRates.set(item.category, item.taxRate);
    }
    if (item.modifierGroup) {
      const rule = `${item.modifierMinSelect ?? 0}/${item.modifierMaxSelect ?? 1}`;
      const current = groupRules.get(item.modifierGroup);
      if (current !== undefined && current !== rule)
        errors.push(
          `گروه افزودنی «${item.modifierGroup}» بیش از یک محدودهٔ انتخاب دارد.`,
        );
      groupRules.set(item.modifierGroup, rule);
      // Without this, two rows listing «شیر بادام:25000» and «شیر بادام:30000»
      // in the same group would silently resolve to whichever row apply()
      // happened to reach last.
      for (const modifier of item.modifiers ?? []) {
        const key = `${item.modifierGroup}\u0000${modifier.name}`;
        const currentPrice = modifierPrices.get(key);
        if (currentPrice !== undefined && currentPrice !== modifier.priceDelta)
          errors.push(
            `افزودنی «${modifier.name}» در گروه «${item.modifierGroup}» بیش از یک قیمت دارد.`,
          );
        modifierPrices.set(key, modifier.priceDelta);
      }
    }
  }
  return [...new Set(errors)];
}

/**
 * Upsert the parsed rows. `defaultTaxRate` (from SETTING_KEYS.tax) is what a
 * category without a tax column in the file is created with; a category the
 * file *does* price keeps the file's rate on update and never has the
 * default written over an existing, hand-set rate.
 */
export async function applyMenuImport(
  locationId: string,
  result: ImportResult,
  defaultTaxRate: number,
  /** The member who chose the file, recorded on price history (issue #844). */
  actorUserId?: string | null,
): Promise<MenuImportCounts> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const counts = await applyInTransaction(client, locationId, result, defaultTaxRate, actorUserId);
    await client.query("COMMIT");
    return counts;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The transaction body — also reusable by callers that already hold a client. */
export async function applyInTransaction(
  client: import("pg").PoolClient,
  locationId: string,
  result: ImportResult,
  defaultTaxRate: number,
  actorUserId?: string | null,
): Promise<MenuImportCounts> {
  const counts: MenuImportCounts = {
    createdCategories: 0,
    updatedItems: 0,
    createdItems: 0,
    createdGroups: 0,
    createdModifiers: 0,
    reactivatedCategories: 0,
  };

  // ------------------------------------------------------------------ categories
  const categoryTaxRate = new Map<string, number>();
  for (const item of result.items)
    if (item.taxRate !== undefined)
      categoryTaxRate.set(item.category, item.taxRate);

  const categoryIdByName = new Map<string, string>();
  const categoryWasInactive = new Map<string, boolean>();
  {
    const { rows: existingCategories } = await client.query<{
      id: string;
      name: string;
      is_active: boolean;
    }>("SELECT id, name, is_active FROM menu_categories WHERE location_id = $1", [
      locationId,
    ]);
    for (const category of existingCategories) {
      categoryIdByName.set(category.name, category.id);
      categoryWasInactive.set(category.id, !category.is_active);
    }
  }

  const categoriesToUpdate: { id: string; taxRate: number | null }[] = [];
  const categoriesToInsert: { name: string; taxRate: number }[] = [];
  for (const categoryName of result.categories) {
    const existingId = categoryIdByName.get(categoryName);
    if (existingId) {
      // Every category the file writes into is re-activated: a category
      // deactivated by an earlier delete (it had ordered items) would
      // otherwise swallow the imported rows into a part of the menu the POS
      // never shows, with no hint of where they went.
      categoriesToUpdate.push({
        id: existingId,
        taxRate: categoryTaxRate.has(categoryName)
          ? categoryTaxRate.get(categoryName)!
          : null,
      });
    } else {
      categoriesToInsert.push({
        name: categoryName,
        taxRate: categoryTaxRate.get(categoryName) ?? defaultTaxRate,
      });
    }
  }

  if (categoriesToUpdate.length > 0) {
    counts.reactivatedCategories = categoriesToUpdate.filter(
      (c) => categoryWasInactive.get(c.id),
    ).length;
    await client.query(
      `UPDATE menu_categories AS c
         SET tax_rate = COALESCE(u.rate, c.tax_rate),
             is_active = true
       FROM unnest($1::uuid[], $2::numeric[]) AS u(id, rate)
      WHERE c.id = u.id`,
      [
        categoriesToUpdate.map((c) => c.id),
        categoriesToUpdate.map((c) => c.taxRate),
      ],
    );
  }

  for (const category of categoriesToInsert) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name, tax_rate, sort_order)
       SELECT $1, $2, $3, COALESCE(MAX(sort_order) + 1, 0)
         FROM menu_categories WHERE location_id = $1
       RETURNING id`,
      [locationId, category.name, category.taxRate],
    );
    categoryIdByName.set(category.name, rows[0].id);
    counts.createdCategories++;
  }

  // ------------------------------------------------------------------ items
  // Item ids are generated client-side for the inserts so the (category,
  // name) → id mapping stays exact: a bulk INSERT … RETURNING makes no
  // promise about row order, and the modifier links below need each item's
  // real id.
  const itemIdByIndex = new Map<number, string>();
  const inserts: { id: string; categoryId: string; name: string; price: number; description: string | null; sku: string | null }[] = [];
  const updates: { id: string; price: number; description: string | null; sku: string | null }[] = [];

  if (result.items.length > 0) {
    const itemCategoryIds = result.items.map(
      (item) => categoryIdByName.get(item.category)!,
    );
    const itemNames = result.items.map((item) => item.name);
    const { rows: existingItems } = await client.query<{
      id: string;
      category_id: string;
      name: string;
    }>(
      `SELECT m.id, m.category_id, m.name
         FROM menu_items m
         JOIN unnest($1::uuid[], $2::text[]) AS i(category_id, name)
           ON m.category_id = i.category_id AND m.name = i.name
        WHERE m.location_id = $3`,
      [itemCategoryIds, itemNames, locationId],
    );
    const existingByCategoryName = new Map<string, string>();
    for (const row of existingItems)
      existingByCategoryName.set(`${row.category_id}-${row.name}`, row.id);

    for (const [index, item] of result.items.entries()) {
      const categoryId = categoryIdByName.get(item.category)!;
      const existingId = existingByCategoryName.get(`${categoryId}-${item.name}`);
      if (existingId) {
        itemIdByIndex.set(index, existingId);
        updates.push({
          id: existingId,
          price: item.price,
          description: item.description ?? null,
          sku: item.sku ?? null,
        });
      } else {
        const id = randomUUID();
        itemIdByIndex.set(index, id);
        inserts.push({
          id,
          categoryId,
          name: item.name,
          price: item.price,
          description: item.description ?? null,
          sku: item.sku ?? null,
        });
      }
    }

    if (updates.length > 0) {
      // description/sku still land in one set-based statement. The price does
      // NOT: it travels through the canonical price-change service so every
      // actual change appends immutable history + the shared audit event with
      // `source = 'import'`, inside this very transaction (issue #844). A row
      // whose price is unchanged writes no history at all.
      await client.query(
        `UPDATE menu_items
            SET description = COALESCE(i.description, menu_items.description),
                sku = COALESCE(i.sku, menu_items.sku),
                updated_at = now()
           FROM unnest($1::uuid[], $2::text[], $3::text[]) AS i(id, description, sku)
          WHERE menu_items.id = i.id`,
        [updates.map((u) => u.id), updates.map((u) => u.description), updates.map((u) => u.sku)],
      );

      const exec = {
        query: <T extends Record<string, unknown>>(text: string, params?: unknown[]) =>
          client.query<T>(text, params as never),
      };
      const businessId = await businessIdForLocation(locationId, exec);
      if (!businessId) throw new Error("location_without_business");
      for (const update of updates) {
        const change = await changeMenuItemPriceWith(clientExecutor(client), {
          businessId,
          locationId,
          menuItemId: update.id,
          newPrice: update.price,
          source: "import",
          changedBy: actorUserId ?? null,
          sourceRef: "menu-import",
        });
        if (!change.ok) throw new Error(change.error);
      }
      counts.updatedItems = updates.length;
    }

    if (inserts.length > 0) {
      await client.query(
        `INSERT INTO menu_items (id, location_id, category_id, name, price, description, sku, sort_order)
         SELECT i.id, $1, i.category_id, i.name, i.price, i.description, i.sku,
                COALESCE((SELECT MAX(sort_order) FROM menu_items
                           WHERE location_id = $1 AND category_id = i.category_id), -1)
                + row_number() OVER (PARTITION BY i.category_id ORDER BY i.ord)
           FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::bigint[], $6::text[], $7::text[], $8::bigint[])
                AS i(id, category_id, name, price, description, sku, ord)`,
        [
          locationId,
          inserts.map((i) => i.id),
          inserts.map((i) => i.categoryId),
          inserts.map((i) => i.name),
          inserts.map((i) => i.price),
          inserts.map((i) => i.description),
          inserts.map((i) => i.sku),
          inserts.map((_, index) => index),
        ],
      );
      counts.createdItems = inserts.length;
    }
  }

  // ------------------------------------------------------------------ modifier groups
  const groupNames = [
    ...new Set(
      result.items
        .map((item) => item.modifierGroup)
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  if (groupNames.length > 0) {
    const groupRule = new Map<string, { minSelect: number; maxSelect: number }>();
    for (const item of result.items) {
      if (!item.modifierGroup || groupRule.has(item.modifierGroup)) continue;
      groupRule.set(item.modifierGroup, {
        minSelect: item.modifierMinSelect ?? 0,
        maxSelect:
          item.modifierMaxSelect ?? Math.max(1, item.modifiers?.length ?? 1),
      });
    }

    const groupIdByName = new Map<string, string>();
    {
      const { rows: existingGroups } = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM modifier_groups WHERE location_id = $1",
        [locationId],
      );
      for (const group of existingGroups) groupIdByName.set(group.name, group.id);
    }

    const groupsToUpdate: { id: string; minSelect: number; maxSelect: number }[] = [];
    const groupsToInsert: { id: string; name: string; minSelect: number; maxSelect: number; sortOrder: number }[] = [];
    let nextGroupOrder = 0;
    for (const name of groupNames) {
      const rule = groupRule.get(name)!;
      const existingId = groupIdByName.get(name);
      if (existingId) {
        groupsToUpdate.push({ id: existingId, ...rule });
      } else {
        const id = randomUUID();
        groupIdByName.set(name, id);
        groupsToInsert.push({ id, name, ...rule, sortOrder: nextGroupOrder++ });
        counts.createdGroups++;
      }
    }

    if (groupsToUpdate.length > 0) {
      await client.query(
        `UPDATE modifier_groups AS g
            SET min_select = u.min_select,
                max_select = u.max_select
           FROM unnest($1::uuid[], $2::int[], $3::int[]) AS u(id, min_select, max_select)
          WHERE g.id = u.id`,
        [
          groupsToUpdate.map((g) => g.id),
          groupsToUpdate.map((g) => g.minSelect),
          groupsToUpdate.map((g) => g.maxSelect),
        ],
      );
    }

    if (groupsToInsert.length > 0) {
      await client.query(
        `INSERT INTO modifier_groups (id, location_id, name, min_select, max_select, sort_order)
         SELECT i.id, $1, i.name, i.min_select, i.max_select,
                COALESCE((SELECT MAX(sort_order) FROM modifier_groups WHERE location_id = $1), -1) + i.ord + 1
           FROM unnest($2::uuid[], $3::text[], $4::int[], $5::int[], $6::int[])
                AS i(id, name, min_select, max_select, ord)`,
        [
          locationId,
          groupsToInsert.map((g) => g.id),
          groupsToInsert.map((g) => g.name),
          groupsToInsert.map((g) => g.minSelect),
          groupsToInsert.map((g) => g.maxSelect),
          groupsToInsert.map((g) => g.sortOrder),
        ],
      );
    }

    // Link every item that names a group. 0165's link columns default to the
    // group's own bounds — an import never invents per-item overrides.
    const linkItemIds: string[] = [];
    const linkGroupIds: string[] = [];
    for (const [index, item] of result.items.entries()) {
      if (!item.modifierGroup) continue;
      const itemId = itemIdByIndex.get(index);
      const groupId = groupIdByName.get(item.modifierGroup);
      if (!itemId || !groupId) continue;
      linkItemIds.push(itemId);
      linkGroupIds.push(groupId);
    }
    if (linkItemIds.length > 0) {
      await client.query(
        `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id)
         SELECT * FROM UNNEST($1::uuid[], $2::uuid[])
         ON CONFLICT DO NOTHING`,
        [linkItemIds, linkGroupIds],
      );
    }

    // Distinct (group, name) pairs — consistencyErrors above has already
    // refused a file that prices the same pair twice.
    const modifierPairs = new Map<string, { groupId: string; name: string; priceDelta: number }>();
    for (const item of result.items) {
      if (!item.modifierGroup) continue;
      const groupId = groupIdByName.get(item.modifierGroup);
      if (!groupId) continue;
      for (const modifier of item.modifiers ?? []) {
        modifierPairs.set(`${groupId}\u0000${modifier.name}`, {
          groupId,
          name: modifier.name,
          priceDelta: modifier.priceDelta,
        });
      }
    }
    if (modifierPairs.size > 0) {
      const pairList = [...modifierPairs.values()];
      const { rows: existingModifiers } = await client.query<{
        id: string;
        group_id: string;
        name: string;
      }>(
        `SELECT m.id, m.group_id, m.name
           FROM modifiers m
           JOIN unnest($1::uuid[], $2::text[]) AS i(group_id, name)
             ON m.group_id = i.group_id AND m.name = i.name
          WHERE m.location_id = $3`,
        [
          pairList.map((p) => p.groupId),
          pairList.map((p) => p.name),
          locationId,
        ],
      );
      const modifierUpdates: { id: string; priceDelta: number }[] = [];
      const modifierInserts: { id: string; groupId: string; name: string; priceDelta: number }[] = [];
      for (const pair of pairList) {
        const existingId = existingModifiers.find(
          (m) => m.group_id === pair.groupId && m.name === pair.name,
        )?.id;
        if (existingId) {
          modifierUpdates.push({ id: existingId, priceDelta: pair.priceDelta });
        } else {
          modifierInserts.push({ id: randomUUID(), ...pair });
        }
      }

      if (modifierUpdates.length > 0) {
        await client.query(
          `UPDATE modifiers AS m
              SET price_delta = u.price_delta,
                  is_active = true
             FROM unnest($1::uuid[], $2::bigint[]) AS u(id, price_delta)
            WHERE m.id = u.id`,
          [
            modifierUpdates.map((m) => m.id),
            modifierUpdates.map((m) => m.priceDelta),
          ],
        );
      }

      if (modifierInserts.length > 0) {
        // sort_order continues each group's existing sequence; the per-group
        // max is fetched once so the bulk insert needs no per-row subquery.
        const { rows: maxOrders } = await client.query<{ group_id: string; max_order: number }>(
          `SELECT group_id, COALESCE(MAX(sort_order), -1)::int AS max_order
             FROM modifiers
            WHERE group_id = ANY($1::uuid[])
            GROUP BY group_id`,
          [[...new Set(modifierInserts.map((m) => m.groupId))]],
        );
        const baseOrderByGroup = new Map<string, number>();
        for (const row of maxOrders) baseOrderByGroup.set(row.group_id, row.max_order);
        const perGroupCounter = new Map<string, number>();
        const sortOrders = modifierInserts.map((m) => {
          const next = (perGroupCounter.get(m.groupId) ?? 0) + 1;
          perGroupCounter.set(m.groupId, next);
          return (baseOrderByGroup.get(m.groupId) ?? -1) + next;
        });
        await client.query(
          `INSERT INTO modifiers (id, location_id, group_id, name, price_delta, sort_order)
           SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::bigint[], $6::int[])`,
          [
            modifierInserts.map((m) => m.id),
            modifierInserts.map(() => locationId),
            modifierInserts.map((m) => m.groupId),
            modifierInserts.map((m) => m.name),
            modifierInserts.map((m) => m.priceDelta),
            sortOrders,
          ],
        );
        counts.createdModifiers = modifierInserts.length;
      }
    }
  }

  return counts;
}
