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
import { SYNC_EVENT_REGISTRY, siteSkipsPulledEvent } from "./sync-event-registry";
import {
  AUTOMOTIVE_SYNC_CLASSIFICATION,
  AUTOMOTIVE_SYNC_CLASS_LABELS,
  automotiveClassifiedTables,
  automotiveCloudOnlyTables,
  automotiveSiteLocalTables,
  automotiveSyncClassificationProblems,
  isAutomotiveTable,
} from "./automotive-sync-classification";
import { pairingDataClassification, replicationCatalogue } from "./replication-catalogue";

describe("the automotive deployment-mode classification (§22)", () => {
  it("classifies every automotive record, each to a real entry", () => {
    const keys = new Set(AUTOMOTIVE_SYNC_CLASSIFICATION.map((entry) => entry.key));
    // §22's list, mapped: unit identity, costs, price/sale history, transfers,
    // Media Library links, the two CRM lead extensions and the shared catalogue
    // half. A record that silently loses its entry — or is never written down —
    // fails here, and the database half checks the same list against the schema.
    for (const key of [
      "vehicle_units",
      "vehicle_costs",
      "vehicle_price_history",
      "vehicle_transfers",
      "lead_vehicle_preferences",
      "lead_vehicle_links",
      "vehicle_sales",
      "vehicle_media_links",
      "vehicle_catalogue",
      // §19's Wave 6: the two derived tables a paired desktop does hold.
      "vehicle_board_mirror",
      "vehicle_offline_requests",
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
      } else if (entry.key === "vehicle_board_mirror") {
        // The one exception §19 (Wave 6) adds, and it is a projection rather
        // than a record: the cloud's own answer, replaced whole.
        expect(entry.class, entry.key).toBe("cloud_mirror");
        expect(entry.tables, entry.key).toEqual(["automotive_vehicle_stock_mirror"]);
      } else if (entry.key === "vehicle_offline_requests") {
        expect(entry.class, entry.key).toBe("site_request_queue");
        expect(entry.tables, entry.key).toEqual(["automotive_vehicle_offline_requests"]);
      } else {
        expect(entry.class, entry.key).toBe("cloud_only");
        expect(entry.tables.length, entry.key).toBeGreaterThan(0);
      }
    }
  });

  it("claims every table once, and never claims a table twice", () => {
    const all = automotiveClassifiedTables();
    expect(new Set(all).size).toBe(all.length);
    // Eleven automotive-owned tables, exactly: seven authoritative vehicle/
    // media/history tables (the trade-in link joined them with issue #963),
    // the two CRM lead extensions, and §19's read-only mirror plus request
    // queue.
    expect([...all].sort()).toEqual(
      [
        "automotive_vehicle_attributes",
        "automotive_vehicle_costs",
        "automotive_vehicle_media",
        "automotive_vehicle_price_history",
        "automotive_vehicle_sales",
        "automotive_vehicle_trade_ins",
        "automotive_vehicle_transfers",
        "automotive_vehicle_offline_requests",
        "automotive_vehicle_stock_mirror",
        "crm_lead_vehicle_links",
        "crm_lead_vehicle_preferences",
      ].sort(),
    );
    // Nine of the eleven are cloud-only; the two site-local ones are the
    // mirror and the queue, and the helper names exactly them.
    expect(automotiveCloudOnlyTables().length).toBe(all.length - 2);
    expect(automotiveSiteLocalTables().sort()).toEqual([
      "automotive_vehicle_offline_requests",
      "automotive_vehicle_stock_mirror",
    ]);
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

  it("keeps the authoritative records cloud-only and advertises only the projection", () => {
    const automotiveDomains = replicationCatalogue().filter((domain) => domain.key.startsWith("automotive_"));
    expect(automotiveDomains.map((domain) => domain.key).sort()).toEqual([
      "automotive_vehicle_board",
      "automotive_vehicle_stock",
    ]);

    // The records themselves: still one authority, still no event, still no
    // bootstrap — a VIN is never merged.
    const records = automotiveDomains.find((domain) => domain.key === "automotive_vehicle_stock")!;
    expect(records.eventTypes).toEqual([]);
    expect(records.authority).toBe("cloud_only");
    expect(records.bootstrap).toBe("none");
    expect(records.deploymentProfiles).toEqual(["cloud"]);
    expect(records.notes.length).toBeGreaterThan(30);

    // §19's Wave 6 addition: a *projection* plus a request queue, and exactly
    // the three events that carry a request up — queue it, release a hold it
    // placed, or withdraw one the counter cancelled before the cloud could decide
    // it. Nothing in this domain decides a hold, posts money, or names a sale.
    const board = automotiveDomains.find((domain) => domain.key === "automotive_vehicle_board")!;
    expect(board.authority).toBe("cloud_authoritative");
    expect(board.bootstrap).toBe("snapshot");
    expect(board.deploymentProfiles).toEqual(["cloud", "hybrid", "site"]);
    expect(board.eventTypes.sort()).toEqual([
      "automotive.vehicle.reservation.released",
      "automotive.vehicle.reservation.requested",
      "automotive.vehicle.reservation.withdrawn",
    ]);
    expect(board.notes.length).toBeGreaterThan(30);

    // The registry and the discovery copy agree with the catalogue: the trade's
    // only events are those three requests, and pairing tells the operator about
    // them instead of promising a synchronised vehicle record.
    const automotiveEvents = SYNC_EVENT_REGISTRY.filter((event) => event.type.startsWith("automotive."));
    expect(automotiveEvents.map((event) => event.type).sort()).toEqual([
      "automotive.vehicle.reservation.released",
      "automotive.vehicle.reservation.requested",
      "automotive.vehicle.reservation.withdrawn",
    ]);
    for (const event of automotiveEvents) {
      // A desktop *applies* these (the cloud decides them); it must never be
      // told to acknowledge one as cloud-owned, or a queued hold would be
      // discarded on the way down.
      expect(siteSkipsPulledEvent(event), event.type).toBe(false);
    }
    const advertised = pairingDataClassification().ongoingDomainEvents;
    expect(advertised).toContain("automotive.vehicle.reservation.requested");
    expect(advertised).toContain("automotive.vehicle.reservation.released");
    expect(advertised).toContain("automotive.vehicle.reservation.withdrawn");
  });

  it("names the automotive bucket in the pairing coverage copy", () => {
    // §22 asks for the pairing snapshot to be updated when entities are
    // classified. This is the derived projection; the literal copy the desktop
    // actually receives is asserted in the integration test.
    expect(pairingDataClassification().centralOnlyData).toContain(
      "Automotive vehicle records (VIN/chassis identity, landed cost, price and sale history, holds, transfers and media links)",
    );
    // …and the projection is disclosed as what it is: a read-only mirror, not
    // the record. The cloud-only line above must not be duplicated here, or the
    // operator would read two contradictory promises.
    const bootstrap = pairingDataClassification().bootstrapMasterData;
    expect(bootstrap.join(" ")).toContain("Automotive branch board mirror");
    expect(bootstrap.join(" ")).not.toContain("Automotive vehicle records");
    expect(pairingDataClassification().siteLocalOperationalData.join(" ")).not.toContain("Automotive branch board");
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
