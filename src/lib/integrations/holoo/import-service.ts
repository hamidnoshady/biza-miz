/**
 * Phase 26 (issue #125) Wave 3 — base-data import (goods, persons, accounts).
 *
 * DB-touching (not unit-tested directly; the pure planning lives in
 * import-plan.ts). The importer is split into preview (no writes — what would
 * happen) and apply (write, then record a mapping row per created entity), so
 * a run is idempotent and every later wave (rollback in Wave 6, ownership in
 * Wave 7) can answer "who made this row" from integration_mappings alone.
 *
 * Goods route is chosen from the business's industry `salesModel`
 * (`menu_items` for order-ticket food service, `items`/`item_stock` for the
 * retail trades), not by a hand-written industry branch.
 */
import Decimal from "decimal.js";
import { getPool, query } from "../../db";
import { getBusinessIndustry } from "../../industry-guard";
import { industryProfile } from "../../industry-profile";
import { getConnection } from "../connections-service";
import { localIdForRemote, localIdForRemoteOnClient, upsertMapping, upsertMappingOnClient } from "../mapping-service";
import { coaTemplateForIndustry, WELL_KNOWN_CODES, type AccountLevel } from "../../coa-template";
import { getSetting, SETTING_KEYS } from "../../settings";
import { planAccountImport, planGoods, planPersons, holooAccountType } from "./import-plan";
import type { MappedAccount, MappedGoods, MappedOpeningInventory, MappedPerson } from "./mappers";
import { createParty } from "../../parties-service";
import { lockChartOfAccounts } from "../../accounts-service";
import { resolveAttachableParent } from "../../account-hierarchy";
import type { PoolClient } from "pg";

async function resolveLocationId(businessId: string, connectionLocationId: string | null): Promise<string> {
  if (connectionLocationId) return connectionLocationId;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  if (!rows[0]) throw new Error("no_location");
  return rows[0].id;
}

/**
 * The local id of a Holoo parent account: its mapping when one exists, else the
 * seed account with the same code. Runs on the import transaction so a mapping
 * written earlier in the same run is seen. Whether the parent may take a child
 * is decided by the caller through `resolveAttachableParent`.
 */
async function resolveHolooParentId(
  client: PoolClient,
  businessId: string,
  connectionId: string,
  parentCode: string,
): Promise<string> {
  const mapped = await localIdForRemoteOnClient(client, businessId, connectionId, "holoo_account", parentCode);
  if (mapped) return mapped;
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, parentCode],
  );
  if (!rows[0]) throw new Error("unresolved_account_parent");
  return rows[0].id;
}

async function alreadyMapped(businessId: string, connectionId: string, entityType: Parameters<typeof localIdForRemote>[2], remoteIds: string[]): Promise<Set<string>> {
  const mapped = new Set<string>();
  for (const remoteId of remoteIds) {
    if (await localIdForRemote(businessId, connectionId, entityType, remoteId)) mapped.add(remoteId);
  }
  return mapped;
}

async function hasOpeningInventoryEvent(businessId: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM inventory_events WHERE business_id = $1 AND event_type = 'opening'
     ) AS exists`,
    [businessId],
  );
  return Boolean(rows[0]?.exists);
}

function openingValueRial(quantity: string, unitCostRial: bigint): string {
  return new Decimal(quantity).times(unitCostRial.toString()).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

async function applyOpeningInventory(
  businessId: string,
  connectionId: string,
  locationId: string,
  rows: MappedOpeningInventory[],
  createdBy: string | null,
  importRunId?: string | null,
): Promise<{ created: number; skipped: number }> {
  if (rows.length === 0) return { created: 0, skipped: 0 };
  const stockMapped = await alreadyMapped(businessId, connectionId, "holoo_stock", rows.map((row) => row.remoteId));
  const toImport = rows.filter((row) => !stockMapped.has(row.remoteId));
  const importableRows = toImport.filter((row) => {
    const quantity = new Decimal(row.quantity);
    return quantity.isFinite() && quantity.gt(0);
  });
  if (importableRows.length === 0) return { created: 0, skipped: rows.length };

  const costing = await getSetting<{ method?: "fifo" | "lifo" | "weighted_average"; system?: "perpetual" | "periodic"; lockedAt?: string | null }>(businessId, SETTING_KEYS.costing);
  // ادواری: opening stock is the first period-end count, not a priced
  // stock movement — refuse rather than import a perpetual cost basis.
  if (costing?.system === "periodic") throw new Error("periodic_system_unsupported");
  const method = costing?.method ?? "fifo";
  const client = await getPool().connect();
  let eventId: string | null = null;
  const importedRows: MappedOpeningInventory[] = [];
  const itemMappings: Array<{ remoteId: string; localId: string; localCreated: boolean }> = [];
  const createdInventoryItemIds = new Set<string>();
  const weightedAverageSnapshots = new Map<string, {
    previousAvgCost: string | null;
    previousCarryingValueRial: string | null;
    expectedAvgCost: string | null;
    expectedCarryingValueRial: string | null;
  }>();
  let totalValue = 0n;
  try {
    await client.query("BEGIN");
    const { rows: existingOpening } = await client.query<{ id: string; source_type: string }>(
      `SELECT id, source_type FROM inventory_events
        WHERE business_id = $1 AND event_type = 'opening'
        ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [businessId],
    );
    if (existingOpening[0]) {
      // Opening inventory is a cutover document, not a periodic stock feed.
      // If any opening event already exists (manual setup or Holoo), the run is
      // idempotent and no second opening layer is created.
      await client.query("ROLLBACK");
      return { created: 0, skipped: rows.length };
    }

    const { rows: eventRows } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events
         (business_id, location_id, event_type, source_type, source_id, created_by, costing_version, metadata)
       VALUES ($1, $2, 'opening', 'holoo_import', $3, $4, 2, $5)
       RETURNING id`,
      [businessId, locationId, importRunId ?? null, createdBy, JSON.stringify({ connectionId })],
    );
    eventId = eventRows[0].id;

    for (const row of importableRows) {
      const quantity = new Decimal(row.quantity);
      const costValue = openingValueRial(row.quantity, row.unitCostRial);
      totalValue += BigInt(costValue);
      const { rows: existing } = await client.query<{
        id: string;
        avg_cost: string | null;
        carrying_value_rial: string | null;
      }>(
        `SELECT id, avg_cost::text, carrying_value_rial::text
           FROM inventory_items WHERE location_id = $1 AND name = $2
          ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [locationId, row.name],
      );
      let itemId = existing[0]?.id;
      if (!itemId) {
        const { rows: itemRows } = await client.query<{ id: string }>(
          `INSERT INTO inventory_items (location_id, name, sku, unit, avg_cost, carrying_value_rial)
           VALUES ($1, $2, NULL, $3, $4, CASE WHEN $6 = 'weighted_average' THEN $5::bigint ELSE NULL END)
           RETURNING id`,
          [locationId, row.name, row.unit ?? "unit", row.unitCostRial.toString(), costValue, method],
        );
        itemId = itemRows[0].id;
        createdInventoryItemIds.add(itemId);
      } else if (method === "weighted_average") {
        if (!createdInventoryItemIds.has(itemId) && !weightedAverageSnapshots.has(itemId)) {
          weightedAverageSnapshots.set(itemId, {
            previousAvgCost: existing[0].avg_cost,
            previousCarryingValueRial: existing[0].carrying_value_rial,
            expectedAvgCost: existing[0].avg_cost,
            expectedCarryingValueRial: existing[0].carrying_value_rial,
          });
        }
        await client.query(
          `UPDATE inventory_items SET avg_cost = $2, carrying_value_rial = COALESCE(carrying_value_rial, 0) + $3::bigint WHERE id = $1`,
          [itemId, row.unitCostRial.toString(), costValue],
        );
        if (!createdInventoryItemIds.has(itemId)) {
          const { rows: updatedItems } = await client.query<{
            avg_cost: string | null;
            carrying_value_rial: string | null;
          }>("SELECT avg_cost::text, carrying_value_rial::text FROM inventory_items WHERE id = $1", [itemId]);
          const snapshot = weightedAverageSnapshots.get(itemId);
          if (snapshot && updatedItems[0]) {
            weightedAverageSnapshots.set(itemId, {
              ...snapshot,
              expectedAvgCost: updatedItems[0].avg_cost,
              expectedCarryingValueRial: updatedItems[0].carrying_value_rial,
            });
          }
        }
      }
      itemMappings.push({ remoteId: row.remoteId, localId: itemId, localCreated: createdInventoryItemIds.has(itemId) });

      await client.query(
        `INSERT INTO stock_movements
           (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial,
            source_type, source_id, note, created_by, inventory_event_id)
         VALUES ($1, $2, 'adjustment', $3, $4, $5, 'opening', $6, 'موجودی افتتاحیه از هلو', $7, $6)`,
        [locationId, itemId, row.quantity, row.unitCostRial.toString(), costValue, eventId, createdBy],
      );
      if (method !== "weighted_average") {
        await client.query(
          `INSERT INTO inventory_lots
             (location_id, inventory_item_id, remaining_qty, unit_cost, source_type, source_id,
              inventory_event_id, original_quantity, original_value_rial, remaining_value_rial)
           VALUES ($1, $2, $3, $4, 'opening', $5, $5, $3, $6, $6)`,
          [locationId, itemId, row.quantity, row.unitCostRial.toString(), eventId, costValue],
        );
      }
      importedRows.push(row);
    }

    if (totalValue > 0n) {
      const { rows: accounts } = await client.query<{ id: string; code: string }>(
        `SELECT id, code FROM accounts WHERE business_id = $1 AND code = ANY($2::text[]) AND is_active`,
        [businessId, [WELL_KNOWN_CODES.inventory, WELL_KNOWN_CODES.openingEquity]],
      );
      const byCode = new Map(accounts.map((account) => [account.code, account.id]));
      const inventoryAccount = byCode.get(WELL_KNOWN_CODES.inventory);
      const openingEquity = byCode.get(WELL_KNOWN_CODES.openingEquity);
      if (!inventoryAccount || !openingEquity) throw new Error("opening_accounts_missing");
      await client.query(
        `INSERT INTO journal_entries
           (business_id, location_id, entry_date, memo, source_type, source_id, created_by, posting_kind, inventory_event_id)
         VALUES ($1, $2, CURRENT_DATE, 'موجودی افتتاحیه از هلو', 'opening_inventory', $3, $4, 'inventory', $3)
         ON CONFLICT (business_id, source_type, source_id, posting_kind) WHERE source_id IS NOT NULL AND posting_kind IS NOT NULL DO NOTHING`,
        [businessId, locationId, eventId, createdBy],
      );
      const { rows: entryRows } = await client.query<{ id: string }>(
        `SELECT id FROM journal_entries
          WHERE business_id = $1 AND source_type = 'opening_inventory' AND source_id = $2 AND posting_kind = 'inventory'`,
        [businessId, eventId],
      );
      const entryId = entryRows[0]?.id;
      if (entryId) {
        await client.query(`DELETE FROM journal_lines WHERE entry_id = $1`, [entryId]);
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
           VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
          [entryId, inventoryAccount, totalValue.toString(), openingEquity],
        );
      }
    }
    // A zero-value opening event has no journal lines to post, but the stock
    // cutover itself completed and must not remain in a pending state.
    await client.query("UPDATE inventory_events SET posting_status = 'posted' WHERE id = $1", [eventId]);

    if (weightedAverageSnapshots.size > 0) {
      await client.query(
        `UPDATE inventory_events
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
          WHERE id = $1`,
        [
          eventId,
          JSON.stringify({
            rollback: {
              weightedAverageItems: [...weightedAverageSnapshots.entries()].map(([inventoryItemId, snapshot]) => ({
                inventoryItemId,
                ...snapshot,
              })),
            },
          }),
        ],
      );
    }
    for (const row of importedRows) {
      await upsertMappingOnClient(client, businessId, connectionId, "holoo_stock", row.remoteId, eventId, importRunId);
    }
    for (const mapping of itemMappings) {
      await upsertMappingOnClient(
        client,
        businessId,
        connectionId,
        "holoo_inventory_item",
        mapping.remoteId,
        mapping.localId,
        importRunId,
        mapping.localCreated,
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (!eventId) return { created: 0, skipped: rows.length };
  return { created: importedRows.length, skipped: rows.length - importedRows.length };
}

export interface BaseImportInput {
  goods: MappedGoods[];
  persons: MappedPerson[];
  accounts: MappedAccount[];
  /** Opening on-hand stock at the migration/companion cutover. */
  openingInventory?: MappedOpeningInventory[];
}

export interface BaseImportPreview {
  goods: { toCreate: number; skipped: number };
  persons: { toCreate: number; skipped: number };
  accounts: { mappedToSeed: number; toCreate: number; orphaned: number; skipped: number };
  openingInventory: { toImport: number; skipped: number };
}

export interface BaseImportSummary extends BaseImportPreview {
  created: { goods: number; persons: number; accounts: number; openingInventory: number };
}

/** Account codes that the read-only account plan can link or create. */
export async function previewableHolooAccountCodes(
  businessId: string,
  connectionId: string,
  accounts: MappedAccount[],
): Promise<string[]> {
  const alreadyLinked = await alreadyMapped(businessId, connectionId, "holoo_account", accounts.map((account) => account.remoteId));
  const industry = (await getBusinessIndustry(businessId)) ?? "food_service";
  const seedCodes = new Set(coaTemplateForIndustry(industry).map((account) => account.code));
  const plan = planAccountImport(accounts, seedCodes, alreadyLinked);
  const eligibleRemoteIds = new Set([
    ...plan.mappedToSeed.map((account) => account.remoteId),
    ...plan.toCreate.map((account) => account.remoteId),
    ...accounts.filter((account) => alreadyLinked.has(account.remoteId)).map((account) => account.remoteId),
  ]);
  return accounts.filter((account) => eligibleRemoteIds.has(account.remoteId)).map((account) => account.code);
}

/** The plan, with no writes — what `apply` will do. */
export async function previewBaseImport(
  businessId: string,
  connectionId: string,
  input: BaseImportInput,
): Promise<BaseImportPreview> {
  const goodsMapped = await alreadyMapped(businessId, connectionId, "holoo_goods", input.goods.map((g) => g.remoteId));
  const personsMapped = await alreadyMapped(businessId, connectionId, "holoo_customer", input.persons.map((p) => p.remoteId));
  const accountsMapped = await alreadyMapped(businessId, connectionId, "holoo_account", input.accounts.map((account) => account.remoteId));
  const inventoryRows = input.openingInventory ?? [];
  const stockMapped = await alreadyMapped(businessId, connectionId, "holoo_stock", inventoryRows.map((row) => row.remoteId));
  const openingEventExists = inventoryRows.length > 0 ? await hasOpeningInventoryEvent(businessId) : false;

  const goods = planGoods(input.goods, goodsMapped);
  const persons = planPersons(input.persons, personsMapped);

  const industry = (await getBusinessIndustry(businessId)) ?? "food_service";
  const seedCodes = new Set(coaTemplateForIndustry(industry).map((a) => a.code));
  const accounts = planAccountImport(input.accounts, seedCodes, accountsMapped);

  return {
    goods: { toCreate: goods.toCreate.length, skipped: goods.skipped },
    persons: { toCreate: persons.toCreate.length, skipped: persons.skipped },
    accounts: {
      mappedToSeed: accounts.mappedToSeed.length,
      toCreate: accounts.toCreate.length,
      orphaned: accounts.orphaned.length,
      skipped: accounts.skipped,
    },
    openingInventory: openingEventExists
      ? { toImport: 0, skipped: inventoryRows.length }
      : { toImport: inventoryRows.filter((row) => !stockMapped.has(row.remoteId)).length, skipped: stockMapped.size },
  };
}

/** Apply the base import, recording a mapping row per created entity. */
export async function applyBaseImport(
  businessId: string,
  connectionId: string,
  input: BaseImportInput,
  importRunId?: string | null,
  locationIdOverride?: string | null,
): Promise<BaseImportSummary> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  const locationId = await resolveLocationId(businessId, locationIdOverride ?? connection.location_id);
  const industry = (await getBusinessIndustry(businessId)) ?? "food_service";
  const isFoodService = industryProfile(industry).salesModel === "order_ticket";

  let createdGoods = 0;
  let createdPersons = 0;
  let createdAccounts = 0;

  const goodsMapped = await alreadyMapped(businessId, connectionId, "holoo_goods", input.goods.map((g) => g.remoteId));
  const goodsPlan = planGoods(input.goods, goodsMapped);
  for (const goods of goodsPlan.toCreate) {
    let localId: string;
    if (isFoodService) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO menu_items (location_id, name, sku, price)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [locationId, goods.name, goods.sku, goods.priceRial === null ? 0n : goods.priceRial],
      );
      localId = rows[0].id;
    } else {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO items (location_id, name, sku, kind, tracking)
         VALUES ($1, $2, $3, 'simple', 'none') RETURNING id`,
        [locationId, goods.name, goods.sku],
      );
      localId = rows[0].id;
      await query(
        `INSERT INTO item_stock (item_id, quantity, unit_price)
         VALUES ($1, 0, $2)`,
        [localId, goods.priceRial === null ? null : Number(goods.priceRial)],
      );
    }
    await upsertMapping(businessId, connectionId, "holoo_goods", goods.remoteId, localId, importRunId);
    createdGoods += 1;
  }

  const personsMapped = await alreadyMapped(businessId, connectionId, "holoo_customer", input.persons.map((p) => p.remoteId));
  const personsPlan = planPersons(input.persons, personsMapped);
  for (const person of personsPlan.toCreate) {
    // Suppliers go through the existing supplier path (the `suppliers` table,
    // keyed on location); the rest become parties. Both are recorded under the
    // same mapping kind — a Holoo person id is unique, and Wave 4 resolves the
    // right one per transaction type.
    //
    // The customer path used to be `INSERT INTO customers`. It goes through
    // `createParty` now because that is where a party's rules live: the Iranian
    // mobile is normalized before it is stored, and the ledger code is allocated in
    // the same statement. Raw SQL here would silently import `۰۹۱۲…` as Latin
    // digits with no code, and the two only exist in the service.
    let localId: string;
    if (person.isSupplier) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO suppliers (location_id, name, phone) VALUES ($1, $2, $3) RETURNING id`,
        [locationId, person.name, person.phone],
      );
      localId = rows[0].id;
    } else {
      localId = (await createParty(businessId, {
        displayName: person.name,
        phone: person.phone ?? null,
        address: person.address ?? null,
      }, { locationId })).id;
    }
    await upsertMapping(businessId, connectionId, "holoo_customer", person.remoteId, localId, importRunId);
    createdPersons += 1;
  }

  const seedCodes = new Set(coaTemplateForIndustry(industry).map((a) => a.code));
  const accountsMapped = await alreadyMapped(businessId, connectionId, "holoo_account", input.accounts.map((account) => account.remoteId));
  const accountsPlan = planAccountImport(input.accounts, seedCodes, accountsMapped);
  // Accounts are written in one transaction under the canonical chart lock
  // (issue #824 review item 6): the seed links, the new account rows, their
  // derived `level`s and their Holoo mappings commit together or not at all.
  // Every parent is resolved through the shared attachment rules in
  // account-hierarchy.ts, so the archived-parent, depth and type checks are the
  // same ones the editor applies — for a parent found by mapping and for one
  // found by code alike (issue #824 finding 1).
  //
  // `level` is derived from the parent, not left to the column default; the old
  // insert omitted the column, so every imported sub-account landed as «گروه».
  if (accountsPlan.mappedToSeed.length > 0 || accountsPlan.toCreate.length > 0) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await lockChartOfAccounts(client, businessId);
      // Link seed accounts without claiming ownership of their pre-existing local rows.
      for (const account of accountsPlan.mappedToSeed) {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
          [businessId, account.code],
        );
        if (!rows[0]) throw new Error("seed_account_missing");
        await upsertMappingOnClient(client, businessId, connectionId, "holoo_account", account.remoteId, rows[0].id, importRunId, false);
      }
      // Create accounts with codes absent from the seed chart, parents first.
      for (const account of accountsPlan.toCreate) {
        const childType = holooAccountType(account.code, account.nature);
        let parentId: string | null = null;
        let level: AccountLevel = "group";
        if (account.parentCode) {
          parentId = await resolveHolooParentId(client, businessId, connectionId, account.parentCode);
          ({ level } = await resolveAttachableParent(client, businessId, parentId, childType));
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO accounts (business_id, parent_id, code, name, type, level)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [businessId, parentId, account.code, account.name, childType, level],
        );
        await upsertMappingOnClient(
          client,
          businessId,
          connectionId,
          "holoo_account",
          account.remoteId,
          rows[0].id,
          importRunId,
        );
        createdAccounts += 1;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const openingInventoryRows = input.openingInventory ?? [];
  const openingResult = await applyOpeningInventory(
    businessId,
    connectionId,
    locationId,
    openingInventoryRows,
    null,
    importRunId,
  );
  const createdOpeningInventory = openingResult.created;

  return {
    goods: { toCreate: goodsPlan.toCreate.length, skipped: goodsPlan.skipped },
    persons: { toCreate: personsPlan.toCreate.length, skipped: personsPlan.skipped },
    accounts: {
      mappedToSeed: accountsPlan.mappedToSeed.length,
      toCreate: accountsPlan.toCreate.length,
      orphaned: accountsPlan.orphaned.length,
      skipped: accountsPlan.skipped,
    },
    openingInventory: { toImport: createdOpeningInventory, skipped: openingResult.skipped },
    created: { goods: createdGoods, persons: createdPersons, accounts: createdAccounts, openingInventory: createdOpeningInventory },
  };
}
