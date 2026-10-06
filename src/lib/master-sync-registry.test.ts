import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MASTER_SYNC_TABLES,
  masterTableConfig,
  masterTableRank,
  rowKey,
  splitRowKey,
  triggerArgs,
} from "./master-sync-registry";

interface TriggerDefinition {
  table: string;
  pk: string;
  scope: string;
  excluded: string;
  file: string;
}

/**
 * The `trg_sync_capture` arguments one migration file defines, in the order
 * they appear in it. Two spellings exist and both are read:
 *
 *   - the `('table', 'pk', 'scope', 'excluded')` VALUES list that 0190 (which
 *     created the contract) and 0206 (issue #795 Phase 7, the serialized-retail
 *     catalogue) loop over through `EXECUTE format(...)`;
 *   - a direct `CREATE TRIGGER ... EXECUTE FUNCTION app_sync_capture_row(...)`
 *     with literal arguments, which is how 0204 changes a single table.
 *
 * The dynamic `%I`/`%L` spelling is deliberately not matched on its own — its
 * arguments come from the VALUES list that feeds it.
 */
function triggerDefinitions(sql: string, file: string): TriggerDefinition[] {
  const found: { at: number; def: TriggerDefinition }[] = [];

  const block = sql.match(
    /\(\s*VALUES([\s\S]*?)\)\s*AS\s+v\(\s*table_name,\s*pk,\s*scope,\s*excluded\s*\)/,
  );
  if (block) {
    const base = sql.indexOf(block[0]);
    const tuple = /\(\s*'([^']+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\s*\)/g;
    for (const match of block[1].matchAll(tuple)) {
      found.push({
        at: base + (match.index ?? 0),
        def: { table: match[1], pk: match[2], scope: match[3], excluded: match[4], file },
      });
    }
  }

  const statement = /CREATE\s+TRIGGER\s+trg_sync_capture([\s\S]*?);/g;
  for (const match of sql.matchAll(statement)) {
    const on = match[1].match(/\bON\s+([a-z_][a-z0-9_]*)/i);
    const args = match[1].match(/app_sync_capture_row\(\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\s*\)/);
    if (!on || !args) continue;
    found.push({
      at: match.index ?? 0,
      def: { table: on[1], pk: args[1], scope: args[2], excluded: args[3], file },
    });
  }

  return found.sort((a, b) => a.at - b.at).map((entry) => entry.def);
}

/**
 * The trigger arguments the migration history leaves in place.
 *
 * Migrations are forward-only and immutable once applied, so a change to a
 * table's trigger arguments can only ever arrive as a LATER migration that
 * drops and recreates it — 0204 does exactly that for `menu_items`, whose
 * `image_media_id` exclusion 0190 shipped with and issue #844 reversed. The
 * contract is therefore the LAST definition of each table across the applied
 * files, in the filename order the runner uses, never the first.
 *
 * Reading only 0190 would force every future trigger change to edit 0190 in
 * place, which changes its sha-256 and aborts every deployed database with
 * `migration_checksum_mismatch` on the next boot.
 */
function effectiveTriggerDefinitions(): Map<string, TriggerDefinition> {
  const effective = new Map<string, TriggerDefinition>();
  const files = readdirSync("migrations")
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const name of files) {
    const sql = readFileSync(`migrations/${name}`, "utf8");
    if (!sql.includes("trg_sync_capture")) continue;
    for (const def of triggerDefinitions(sql, name)) effective.set(def.table, def);
  }
  return effective;
}

describe("master-sync registry", () => {
  it("matches the trigger arguments the migrations leave in place, table for table", () => {
    const effective = effectiveTriggerDefinitions();
    for (const config of MASTER_SYNC_TABLES) {
      const [pk, scope, excluded] = triggerArgs(config);
      const actual = effective.get(config.table);
      expect(actual, `${config.table}: no migration defines trg_sync_capture`).toBeDefined();
      expect(
        [actual?.pk, actual?.scope, actual?.excluded],
        `${config.table} (last defined by ${actual?.file})`,
      ).toEqual([pk, scope, excluded]);
    }
  });

  it("captures no table the registry does not merge", () => {
    const effective = effectiveTriggerDefinitions();
    const unsynced = [...effective.keys()].filter((table) => masterTableConfig(table) === null);
    expect(unsynced).toEqual([]);
  });

  it("lists every parent before the tables that reference it", () => {
    for (const config of MASTER_SYNC_TABLES) {
      if (config.scope.kind === "parent") {
        expect(masterTableRank(config.scope.table)).toBeLessThan(masterTableRank(config.table));
      }
    }
    expect(masterTableRank("party_categories")).toBeLessThan(masterTableRank("parties"));
    expect(masterTableRank("menu_categories")).toBeLessThan(masterTableRank("menu_items"));
    expect(masterTableRank("modifier_groups")).toBeLessThan(masterTableRank("modifiers"));
    // Issue #795 Phase 7: brands before the items that reference them.
    expect(masterTableRank("item_brands")).toBeLessThan(masterTableRank("items"));
    expect(masterTableRank("items")).toBeLessThan(masterTableRank("watch_item_attributes"));
  });

  it("keeps serialized stock out of the feed — a serial must never sell twice across devices", () => {
    // The catalogue syncs; the physical units and everything downstream of
    // them (sales, warranties, repairs, reservations) stay cloud-owned with
    // a single authority over status transitions.
    expect(masterTableConfig("items")).not.toBeNull();
    expect(masterTableConfig("watch_item_attributes")).not.toBeNull();
    expect(masterTableConfig("item_serials")).toBeNull();
    expect(masterTableConfig("serial_warranties")).toBeNull();
    expect(masterTableConfig("serial_reservations")).toBeNull();
  });

  it("never merges values each side derives for itself", () => {
    expect(masterTableConfig("inventory_items")?.excluded).toEqual(
      expect.arrayContaining(["avg_cost", "carrying_value_rial"]),
    );
    expect(masterTableConfig("dining_tables")?.excluded).toContain("status");
    // Ciphertext is under one install's key; the plaintext twin crosses and is
    // re-encrypted on arrival.
    expect(masterTableConfig("parties")?.excluded).toEqual(
      expect.arrayContaining(["phone_enc", "phone_bidx", "address_enc", "notes_enc", "national_id_enc"]),
    );
  });

  it("round-trips composite keys", () => {
    const config = masterTableConfig("menu_item_ingredients")!;
    const key = rowKey(config, { menu_item_id: "a", inventory_item_id: "b" });
    expect(key).toBe("a|b");
    expect(splitRowKey(config, key)).toEqual({ menu_item_id: "a", inventory_item_id: "b" });
    expect(splitRowKey(config, "a")).toBeNull();
    expect(masterTableConfig("orders")).toBeNull();
  });
});
