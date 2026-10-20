/**
 * The pure decision rules issue #943 added to the sync service — tested
 * without a database, because the DB-touching flows around them are covered
 * by integration/woocommerce-catalogue.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  SYNC_FAILURE_ID_CAP,
  catalogueSyncHealth,
  parentRemoteIdFromMeta,
  remoteSnapshotFromMeta,
} from "./sync-service";

describe("catalogueSyncHealth", () => {
  it("reports a clean run as non-partial and clears the connection's error", () => {
    expect(catalogueSyncHealth({ failed: 0, variationFetchFailures: 0, taxonomyError: null })).toEqual({
      partial: false,
      lastError: null,
    });
  });

  it("reports product failures as partial, with the count in the persisted error", () => {
    const health = catalogueSyncHealth({ failed: 3, variationFetchFailures: 0, taxonomyError: null });
    expect(health.partial).toBe(true);
    expect(health.lastError).toContain("products_sync_partial");
    expect(health.lastError).toContain("3 products failed");
  });

  it("reports variation-fetch and taxonomy failures as partial too — a sync that silently lost children is not a success", () => {
    expect(catalogueSyncHealth({ failed: 0, variationFetchFailures: 2, taxonomyError: null }).partial).toBe(true);
    const taxonomy = catalogueSyncHealth({ failed: 0, variationFetchFailures: 0, taxonomyError: "term_fetch_failed" });
    expect(taxonomy.partial).toBe(true);
    expect(taxonomy.lastError).toContain("term_fetch_failed");
  });

  it("caps the persisted error instead of writing a novel into last_error", () => {
    const health = catalogueSyncHealth({ failed: 1, variationFetchFailures: 0, taxonomyError: "x".repeat(2000) });
    expect(health.lastError!.length).toBeLessThanOrEqual(500);
  });

  it("caps how many failure ids an outcome carries", () => {
    // The route passes failureIds straight to the UI; the cap is the contract.
    expect(SYNC_FAILURE_ID_CAP).toBe(50);
  });
});

describe("parentRemoteIdFromMeta", () => {
  it("reads the parent the sync recorded on the mapping", () => {
    expect(parentRemoteIdFromMeta({ remoteParentId: "10" })).toBe("10");
  });

  it("is null for a simple product, an empty meta, and a legacy/garbage value", () => {
    expect(parentRemoteIdFromMeta({ remoteParentId: null })).toBeNull();
    expect(parentRemoteIdFromMeta({})).toBeNull();
    expect(parentRemoteIdFromMeta(null)).toBeNull();
    expect(parentRemoteIdFromMeta(undefined)).toBeNull();
    expect(parentRemoteIdFromMeta({ remoteParentId: 10 })).toBeNull();
    expect(parentRemoteIdFromMeta({ remoteParentId: "" })).toBeNull();
  });
});

describe("remoteSnapshotFromMeta", () => {
  it("reads the store's last-seen presentation recorded at sync time", () => {
    expect(
      remoteSnapshotFromMeta({
        remoteStatus: "draft",
        remoteManageStock: false,
        remoteRegularPriceRial: "1500000",
        remoteSalePriceRial: "1200000",
      }),
    ).toEqual({
      remoteStatus: "draft",
      remoteManageStock: false,
      remoteRegularPriceRial: "1500000",
      remoteSalePriceRial: "1200000",
    });
  });

  it("answers nulls for a legacy mapping that predates the snapshot — never a guess", () => {
    expect(remoteSnapshotFromMeta({ wooType: "simple" })).toEqual({
      remoteStatus: null,
      remoteManageStock: null,
      remoteRegularPriceRial: null,
      remoteSalePriceRial: null,
    });
    expect(remoteSnapshotFromMeta(null).remoteManageStock).toBeNull();
  });
});
