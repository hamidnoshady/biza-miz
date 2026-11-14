import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetConnection,
  mockWooClientFor,
  mockFindActiveRun,
  mockGetSummary,
  mockOpenRun,
  mockReopenStaleRun,
  mockStageProducts,
  mockCompleteDiscovery,
  mockQuery,
} = vi.hoisted(() => ({
  mockGetConnection: vi.fn(),
  mockWooClientFor: vi.fn(),
  mockFindActiveRun: vi.fn(),
  mockGetSummary: vi.fn(),
  mockOpenRun: vi.fn(),
  mockReopenStaleRun: vi.fn(),
  mockStageProducts: vi.fn(),
  mockCompleteDiscovery: vi.fn(),
  mockQuery: vi.fn(),
}));

vi.mock("../db", () => ({
  getPool: vi.fn(),
  query: mockQuery,
  withTenant: vi.fn(),
  withTenantTransaction: vi.fn(),
}));
vi.mock("./connections-service", () => ({
  getConnection: mockGetConnection,
  wooClientFor: mockWooClientFor,
}));
vi.mock("../import-reconciliation/entry-guards", () => ({
  findActiveRunForConnection: mockFindActiveRun,
  hasCanonicalOverlapForDomain: vi.fn(),
}));
vi.mock("../import-reconciliation/service", () => ({
  completeProductDiscovery: mockCompleteDiscovery,
  getRunSummary: mockGetSummary,
  openRun: mockOpenRun,
  reopenStaleRun: mockReopenStaleRun,
  stageProducts: mockStageProducts,
}));

import { stageWooCatalogueToReconciliation } from "./sync-service";

const bizId = "11111111-1111-4111-8111-111111111111";
const connId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const actor = { userId: "44444444-4444-4444-8444-444444444444", name: "مدیر" };

describe("stageWooCatalogueToReconciliation reuse & reopen behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConnection.mockResolvedValue({
      id: connId,
      location_id: "55555555-5555-4555-8555-555555555555",
      currency_unit: "toman",
    });
    mockWooClientFor.mockReturnValue({
      listProductsPage: vi.fn().mockResolvedValue({
        items: [{ id: 101, name: "کالای نمونه", sku: "SKU-1", type: "simple", regular_price: "1000" }],
        totalPages: 1,
      }),
      listVariations: vi.fn().mockResolvedValue([]),
    });
  });

  it("returns an already staged/in_review run directly without calling stageProducts or failing with run_not_discovering", async () => {
    mockFindActiveRun.mockResolvedValueOnce({ id: runId, domain: "product", status: "in_review" });
    mockGetSummary.mockResolvedValueOnce({
      run: { id: runId, status: "in_review" },
      counts: { read: 12, pending: 3 },
      progress: { stage: "in_review" },
    });

    const res = await stageWooCatalogueToReconciliation(bizId, connId, actor);
    expect(res).toMatchObject({ runId, reused: true, run: { id: runId, status: "in_review" } });
    expect(mockWooClientFor).not.toHaveBeenCalled();
    expect(mockStageProducts).not.toHaveBeenCalled();
    expect(mockCompleteDiscovery).not.toHaveBeenCalled();
  });

  it("reopens a stale run before re-staging fresh Woo products", async () => {
    mockFindActiveRun.mockResolvedValueOnce({ id: runId, domain: "product", status: "stale" });
    mockReopenStaleRun.mockResolvedValueOnce({ id: runId, status: "discovering" });
    mockStageProducts.mockResolvedValueOnce({ staged: 1, unchanged: 0, changed: 0 });
    mockCompleteDiscovery.mockResolvedValueOnce({
      run: { id: runId, status: "staged" },
      gate: { path: "review", reasons: [] },
      counts: { read: 1 },
    });

    const res = await stageWooCatalogueToReconciliation(bizId, connId, actor);
    expect(res).toMatchObject({ runId, reused: false, run: { id: runId, status: "staged" } });
    expect(mockReopenStaleRun).toHaveBeenCalledWith(bizId, runId, { sourceFingerprint: `woo:${connId}:1` }, actor);
    expect(mockStageProducts).toHaveBeenCalledTimes(1);
    expect(mockCompleteDiscovery).toHaveBeenCalledTimes(1);
  });
});
