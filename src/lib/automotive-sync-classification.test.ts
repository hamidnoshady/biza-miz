/**
 * Issue #839 §22 — the automotive classification contract, without a database.
 *
 * §22 asks for an audit: every new entity classified for the deployment modes,
 * and — only if it replicates — every replication surface updated with it.
 * These assertions are that audit's own checks: every automotive table is
 * claimed exactly once, the claim says what the record's write model is and
 * what a future protocol must add first, nothing classified is in the
 * last-write-wins master sync, no automotive event is advertised as
 * synchronising, and the pairing coverage copy names the bucket.
 *
 * The database half — that the schema has no unclassified automotive table,
 * that none of them carries the master-data capture trigger, and that a paired
 * automotive desktop receives zero vehicle rows — lives in
 * `integration/automotive-sync-classification.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { MASTER_SYNC_TABLES } from "./master-sync-registry";
import { SYNC_EVENT_REGISTRY } from "./sync-event-registry";
import {
  AUTOMOTIVE_SYNC_CLASSIFICATION,
  AUTOMOTIVE_SYNC_CLASS_LABELS,
  automotiveClassifiedTables,
  automotiveCloudOnlyTables,
  automotiveSyncClassificationProblems,
  isAutomotiveTable,
} from "./automotive-sync-classification";
import { pairingDataClassification, replicationCatalogue } from "./replication-catalogue";

describe("the automotive deployment-mode classification (§22)", () => {
  it("classifies every automotive record, each to a real entry", () => {
    const keys = new Set(AUTOMOTIVE_SYNC_CLASSIFICATION.map((entry) => entry.key));
    // §22's list, mapped: the vehicle record, its cost ledger, its price
    // history, its transfers, and the two CRM lead extensions 0213 added. A
    // record that silently loses its entry — or is never written down — fails
    // here, and the database half checks the same list against the schema.
    for (const key of [
      "vehicle_units",
      "vehicle_costs",
      "vehicle_price_history",
      "vehicle_transfers",
      "lead_vehicle_preferences",
      "lead_vehicle_links",
      "vehicle_catalogue",
    ]) {
      expect(keys.has(key), key).toBe(true);
    }
  });

  it("gives every entry a class, a surface, a write model, a conflict rule and a requirement", () => {
    for (const entry of AUTOMOTIVE_SYNC_CLASSIFICATION) {
      expect(AUTOMOTIVE_SYNC_CLASS_LABELS[entry.class].length, entry.key).toBeGreaterThan(3);
      expect(entry.label.trim().length, entry.key).toBeGreaterThan(2);
      expect(entry.surface.trim().length, entry.key).toBeGreaterThan(2);
      expect(entry.reason.trim().length, entry.key).toBeGreaterThan(40);
      expect(entry.conflictRule.trim().length, entry.key).toBeGreaterThan(20);
      // §22's rule in code: even a cloud-only record says what the protocol
      // would have to add. The catalogue entry is the one shipped path, and it
      // says so rather than leaving the field empty.
      expect(entry.requirement.trim().length, entry.key).toBeGreaterThan(20);
      if (entry.key === "vehicle_catalogue") {
        expect(entry.class, entry.key).toBe("cloud_catalogue");
        expect(entry.tables, entry.key).toEqual([]);
      } else {
        expect(entry.class, entry.key).toBe("cloud_only");
        expect(entry.tables.length, entry.key).toBeGreaterThan(0);
      }
    }
  });

  it("claims every table once, and never claims a table twice", () => {
    const all = automotiveClassifiedTables();
    expect(new Set(all).size).toBe(all.length);
    // The six automotive-specific tables, exactly.
    expect([...all].sort()).toEqual(
      [
        "automotive_vehicle_attributes",
        "automotive_vehicle_costs",
        "automotive_vehicle_price_history",
        "automotive_vehicle_transfers",
        "crm_lead_vehicle_links",
        "crm_lead_vehicle_preferences",
      ].sort(),
    );
    expect(automotiveCloudOnlyTables().length).toBe(all.length);
  });

  it("keeps every classified table out of the last-write-wins master sync", () => {
    const master = new Set(MASTER_SYNC_TABLES.map((config) => config.table));
    for (const table of automotiveClassifiedTables()) {
      // The rule for a serial, restated for a car: a field-by-field merge of
      // two VIN lists is how one car is in two places at two prices.
      expect(master.has(table), table).toBe(false);
    }
    // The catalogue half is the opposite decision and is not a hidden exception:
    // the generic `items` table is master-synced, and it carries no
    // automotive-specific column (0212 put those on the serial-keyed table).
    expect(master.has("items")).toBe(true);
    expect(master.has("item_serials")).toBe(false);
  });

  it("advertises no automotive domain as an ongoing sync source", () => {
    const automotiveDomains = replicationCatalogue().filter((domain) => domain.key.startsWith("automotive_"));
    expect(automotiveDomains.length).toBe(1);
    const [domain] = automotiveDomains;
    expect(domain.eventTypes).toEqual([]);
    expect(domain.authority).toBe("cloud_only");
    expect(domain.bootstrap).toBe("none");
    expect(domain.deploymentProfiles).toEqual(["cloud"]);
    expect(domain.notes.length).toBeGreaterThan(30);

    // And no registered sync event belongs to the trade, so a desktop is never
    // promised an automotive workflow that does not exist.
    expect(SYNC_EVENT_REGISTRY.some((event) => event.type.startsWith("automotive."))).toBe(false);
    expect(pairingDataClassification().ongoingDomainEvents.some((event) => event.includes("automotive"))).toBe(false);
  });

  it("names the automotive bucket in the pairing coverage copy", () => {
    // §22 asks for the pairing snapshot to be updated when entities are
    // classified. This is the derived projection; the literal copy the desktop
    // actually receives is asserted in the integration test.
    expect(pairingDataClassification().centralOnlyData).toContain(
      "Automotive vehicle stock (VIN/chassis identity, landed cost, price history, holds and transfers)",
    );
    expect(pairingDataClassification().bootstrapMasterData.join(" ")).not.toContain("Automotive vehicle");
  });

  it("recognizes an automotive table by one predicate the database half shares", () => {
    for (const table of automotiveClassifiedTables()) expect(isAutomotiveTable(table), table).toBe(true);
    for (const table of ["items", "item_serials", "serial_reservations", "aec_rfis", "menu_items"]) {
      expect(isAutomotiveTable(table), table).toBe(false);
    }
  });

  it("reports an unclassified or a vanished table, and nothing when the schema agrees", () => {
    const known = automotiveClassifiedTables();
    expect(automotiveSyncClassificationProblems(known)).toEqual({ uncovered: [], unknown: [] });

    const withNew = automotiveSyncClassificationProblems([...known, "automotive_vehicle_inspections"]);
    expect(withNew.uncovered).toEqual(["automotive_vehicle_inspections"]);
    expect(withNew.unknown).toEqual([]);

    const withDropped = automotiveSyncClassificationProblems(known.filter((table) => table !== "automotive_vehicle_transfers"));
    expect(withDropped.uncovered).toEqual([]);
    expect(withDropped.unknown).toEqual(["automotive_vehicle_transfers"]);
  });
});
