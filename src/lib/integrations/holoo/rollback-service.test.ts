import { describe, expect, it } from "vitest";
import { localIdsCreatedByImportRun, readWeightedAverageRollbackItems } from "./rollback-service";

describe("run-scoped Holoo rollback ownership", () => {
  it("does not delete pre-existing accounts linked from the imported chart", () => {
    const mappings = [
      { entity_type: "holoo_account", local_id: "seed-account", local_created_by_import_run: false },
      { entity_type: "holoo_account", local_id: "imported-account", local_created_by_import_run: true },
    ];
    expect(localIdsCreatedByImportRun(mappings, "holoo_account")).toEqual(["imported-account"]);
  });

  it("deletes only inventory items created by the opening-stock run, not linked existing masters", () => {
    const mappings = [
      { entity_type: "holoo_inventory_item", local_id: "existing-item", local_created_by_import_run: false },
      { entity_type: "holoo_inventory_item", local_id: "created-item", local_created_by_import_run: true },
    ];
    expect(localIdsCreatedByImportRun(mappings, "holoo_inventory_item")).toEqual(["created-item"]);
  });

  it("deduplicates shared run-owned local rows while ignoring another entity type", () => {
    const mappings = [
      { entity_type: "holoo_stock", local_id: "opening-event", local_created_by_import_run: true },
      { entity_type: "holoo_stock", local_id: "opening-event", local_created_by_import_run: true },
      { entity_type: "holoo_account", local_id: "other", local_created_by_import_run: true },
      { entity_type: "holoo_stock", local_id: "linked-stock", local_created_by_import_run: false },
    ];
    expect(localIdsCreatedByImportRun(mappings, "holoo_stock")).toEqual(["opening-event"]);
  });

  it("reads weighted-average rollback snapshots from an opening event", () => {
    expect(readWeightedAverageRollbackItems({
      location_id: "location-1",
      created_at: new Date("2026-10-01T12:00:00Z"),
      metadata: JSON.stringify({ rollback: { weightedAverageItems: [{
        inventoryItemId: "item-1",
        previousAvgCost: "10.00",
        previousCarryingValueRial: "1000",
        expectedAvgCost: "12.00",
        expectedCarryingValueRial: "1300",
      }] } }),
    })).toEqual([{
      inventoryItemId: "item-1",
      locationId: "location-1",
      eventCreatedAt: new Date("2026-10-01T12:00:00Z"),
      previousAvgCost: "10.00",
      previousCarryingValueRial: "1000",
      expectedAvgCost: "12.00",
      expectedCarryingValueRial: "1300",
    }]);
  });

  it("fails closed on malformed weighted-average rollback metadata", () => {
    expect(() => readWeightedAverageRollbackItems({
      location_id: "location-1",
      created_at: new Date(),
      metadata: { rollback: { weightedAverageItems: [{ inventoryItemId: "item-1" }] } },
    })).toThrow("holoo_import_rollback_metadata_invalid");
  });
});
