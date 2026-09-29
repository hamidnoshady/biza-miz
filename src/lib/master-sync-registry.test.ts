import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MASTER_SYNC_TABLES,
  masterTableConfig,
  masterTableRank,
  rowKey,
  splitRowKey,
  triggerArgs,
} from "./master-sync-registry";

const migration = readFileSync("migrations/0190_hybrid_sync_completeness.sql", "utf8");

describe("master-sync registry", () => {
  it("matches the trigger arguments migration 0190 creates, table for table", () => {
    for (const config of MASTER_SYNC_TABLES) {
      const [pk, scope, excluded] = triggerArgs(config);
      const line = new RegExp(
        `\\('${config.table}',\\s*'${pk}',\\s*'${scope.replace(/[:]/g, ":")}',\\s*'${excluded}'\\)`,
      );
      expect(migration, config.table).toMatch(line);
    }
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
