import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithTenantTransaction,
  mockGetBusinessIndustry,
  mockCreateItem,
  mockCreateVariantChild,
  mockCreateParty,
  mockGetSetting,
  mockPostVoucher,
  mockFinalizeImportJob,
  mockApplyRun,
  mockCrossCheckRun,
  mockGetRunSummary,
  mockProductToken,
  mockPartyToken,
  mockFinToken,
  mockInvToken,
  mockAppendOpeningStock,
} = vi.hoisted(() => ({
  mockWithTenantTransaction: vi.fn(),
  mockGetBusinessIndustry: vi.fn(),
  mockCreateItem: vi.fn(),
  mockCreateVariantChild: vi.fn(),
  mockCreateParty: vi.fn(),
  mockGetSetting: vi.fn(),
  mockPostVoucher: vi.fn(),
  mockFinalizeImportJob: vi.fn(),
  mockApplyRun: vi.fn(),
  mockCrossCheckRun: vi.fn(),
  mockGetRunSummary: vi.fn(),
  mockProductToken: vi.fn(),
  mockPartyToken: vi.fn(),
  mockFinToken: vi.fn(),
  mockInvToken: vi.fn(),
  mockAppendOpeningStock: vi.fn(),
}));

vi.mock("../db", () => ({
  withTenantTransaction: mockWithTenantTransaction,
}));
// The post-apply inbox drain opens no further work while another run owns the
// connection; these tests cover the domain writers, not the drain itself.
vi.mock("./entry-guards", () => ({
  findActiveRunForConnection: vi.fn().mockResolvedValue({ id: "run-active", domain: "product", status: "in_review" }),
  hasNewSourceEventsForRun: vi.fn().mockResolvedValue(false),
}));
vi.mock("../industry-guard", () => ({
  getBusinessIndustry: mockGetBusinessIndustry,
}));
vi.mock("../items-service", () => ({
  createItem: mockCreateItem,
  createVariantChild: mockCreateVariantChild,
}));
vi.mock("../parties-service", () => ({
  createParty: mockCreateParty,
}));
vi.mock("../settings", () => ({
  SETTING_KEYS: { costing: "costing" },
  getSetting: mockGetSetting,
}));
vi.mock("../integrations/holoo/journal-import-service", () => ({
  HOLOO_IMPORT_SOURCE_TYPE: "holoo_import",
  postReconciledHolooVoucherOnClient: mockPostVoucher,
}));
// GH #1567 F2 — imported stock is proposed on an opening-stock draft; the
// draft service has its own DB suite (item-opening-stock.integration.test.ts).
vi.mock("../item-opening-stock-service", () => ({
  appendImportedOpeningStock: mockAppendOpeningStock,
}));
vi.mock("../data-transfer/import-service", () => ({
  finalizeReconciledImportJob: mockFinalizeImportJob,
}));
vi.mock("./service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service")>();
  return {
    ...actual,
    applyRun: mockApplyRun,
    crossCheckRun: mockCrossCheckRun,
    getRunSummary: mockGetRunSummary,
    productCanonicalToken: mockProductToken,
    partyCanonicalToken: mockPartyToken,
    financialDocumentCanonicalToken: mockFinToken,
    inventoryCanonicalToken: mockInvToken,
  };
});

import { applyReconciliationRunWithDomainHandlers } from "./apply-runner";
import type { ApplyContext, ApplyHandler } from "./service";

const bizId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const locId = "33333333-3333-4333-8333-333333333333";
const actor = { userId: "44444444-4444-4444-8444-444444444444", name: "اپراتور" };

describe("applyReconciliationRunWithDomainHandlers domain writers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithTenantTransaction.mockImplementation(async (_biz: string, fn: (c: unknown) => Promise<unknown>) => fn({ query: vi.fn() }));
    mockGetSetting.mockResolvedValue({ method: "fifo", system: "perpetual" });
    mockCrossCheckRun.mockResolvedValue({ ok: true, problems: [] });
    mockFinToken.mockResolvedValue("tok-fin");
    mockInvToken.mockResolvedValue("tok-inv");
    mockProductToken.mockResolvedValue("tok-prod");
  });

  it("wires financial_document create to postReconciledHolooVoucherOnClient", async () => {
    mockGetBusinessIndustry.mockResolvedValueOnce("cosmetics");
    mockGetRunSummary.mockResolvedValueOnce({
      run: {
        id: runId,
        businessId: bizId,
        locationId: locId,
        domain: "financial_document",
        sourceKind: "provider",
        provider: "holoo",
        sourceKey: "holoo:c1:journal",
        connectionId: "55555555-5555-4555-8555-555555555555",
        sourceFingerprint: "fp",
        policyVersion: 1,
        scope: {},
      },
    });
    mockPostVoucher.mockResolvedValueOnce({ entryId: "je-created-1" });

    let capturedResult: { canonicalId: string } | null = null;
    mockApplyRun.mockImplementationOnce(async ({ handler }: { handler: ApplyHandler }) => {
      const fakeClient = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      capturedResult = await handler.create!({
        client: fakeClient as unknown as ApplyContext["client"],
        run: {
          id: runId,
          businessId: bizId,
          locationId: locId,
          domain: "financial_document",
          sourceKind: "provider",
          provider: "holoo",
          sourceKey: "holoo:c1:journal",
          connectionId: "55555555-5555-4555-8555-555555555555",
        } as unknown as ApplyContext["run"],
        item: {
          id: 1,
          externalType: "journal",
          externalKey: "hv-1",
          snapshot: {
            kind: "journal",
            date: "2026-11-01",
            fields: {
              memo: "سند تستی",
              lines: [
                { accountCode: "1100", debitRial: "50000", creditRial: "0" },
                { accountCode: "4300", debitRial: "0", creditRial: "50000" },
              ],
            },
          },
        } as unknown as ApplyContext["item"],
        canonicalId: null,
        authorityOverrides: {},
        idempotencyKey: `${runId}:1`,
        actor,
      });
      return { run: { id: runId, status: "applied" }, counts: {}, progress: {} };
    });

    await applyReconciliationRunWithDomainHandlers({ businessId: bizId, runId, locationId: locId, actor });
    expect(capturedResult).toEqual({ canonicalId: "je-created-1" });
    expect(mockPostVoucher).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        businessId: bizId,
        locationId: locId,
        sourceType: "holoo_import",
        voucher: expect.objectContaining({
          remoteId: "hv-1",
          entryDate: "2026-11-01",
          lines: [
            expect.objectContaining({ accountCode: "1100", debitRial: 50000n, creditRial: 0n }),
            expect.objectContaining({ accountCode: "4300", debitRial: 0n, creditRial: 50000n }),
          ],
        }),
      }),
    );
  });

  it("creates a variable parent as a container and a variation as its child", async () => {
    mockGetBusinessIndustry.mockReset().mockResolvedValue("cosmetics");
    mockGetRunSummary.mockResolvedValueOnce({
      run: {
        id: runId,
        businessId: bizId,
        locationId: locId,
        domain: "product",
        sourceKind: "provider",
        provider: "woocommerce",
        sourceKey: "conn-1",
        connectionId: "55555555-5555-4555-8555-555555555555",
        sourceFingerprint: "fp",
        policyVersion: 1,
        scope: {},
      },
      counts: {},
    });
    mockCreateItem.mockResolvedValueOnce({ id: "parent-1" });
    mockCreateVariantChild.mockResolvedValueOnce({ id: "child-1" });
    const fakeClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT industry FROM businesses")) return { rows: [{ industry: "cosmetics" }] };
        if (sql.includes("SELECT canonical_id::text AS canonical_id FROM source_identities")) {
          return { rows: [{ canonical_id: "parent-1" }] };
        }
        return { rows: [] };
      }),
    };
    let parentResult: { canonicalId: string } | null = null;
    let childResult: { canonicalId: string } | null = null;

    mockApplyRun.mockImplementationOnce(async ({ handler }: { handler: ApplyHandler }) => {
      parentResult = await handler.create!({
        client: fakeClient as unknown as ApplyContext["client"],
        run: {
          id: runId,
          businessId: bizId,
          locationId: locId,
          domain: "product",
          sourceKey: "conn-1",
          provider: "woocommerce",
          connectionId: "55555555-5555-4555-8555-555555555555",
        } as unknown as ApplyContext["run"],
        item: {
          id: 3,
          externalType: "product",
          externalKey: "10",
          snapshot: { name: "تی‌شرت", sku: "TSHIRT", kind: "variant_parent" },
        } as unknown as ApplyContext["item"],
        canonicalId: null,
        authorityOverrides: {},
        idempotencyKey: `${runId}:3`,
        actor,
      });
      childResult = await handler.create!({
        client: fakeClient as unknown as ApplyContext["client"],
        run: {
          id: runId,
          businessId: bizId,
          locationId: locId,
          domain: "product",
          sourceKey: "conn-1",
          provider: "woocommerce",
          connectionId: "55555555-5555-4555-8555-555555555555",
        } as unknown as ApplyContext["run"],
        item: {
          id: 4,
          externalType: "product",
          externalKey: "11",
          snapshot: {
            name: "تی‌شرت - قرمز",
            sku: "TSHIRT-RED",
            kind: "variant_child",
            parentExternalId: "10",
            variantOptions: { "رنگ": "قرمز" },
            priceRial: "120000",
            stockQuantity: "3",
          },
        } as unknown as ApplyContext["item"],
        canonicalId: null,
        authorityOverrides: {},
        idempotencyKey: `${runId}:4`,
        actor,
      });
      return { run: { id: runId, status: "applied" }, counts: {}, progress: {} };
    });

    await applyReconciliationRunWithDomainHandlers({ businessId: bizId, runId, locationId: locId, actor });
    expect(parentResult).toEqual({ canonicalId: "parent-1" });
    expect(mockCreateItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "variant_parent", sku: "TSHIRT" }),
      fakeClient,
    );
    expect(childResult).toEqual({ canonicalId: "child-1" });
    expect(mockCreateVariantChild).toHaveBeenCalledWith(
      "parent-1",
      locId,
      "تی‌شرت - قرمز",
      "TSHIRT-RED",
      [{ name: "رنگ", value: "قرمز" }],
      fakeClient,
    );
    // The store's stock figure becomes a proposed opening line (cost unknown).
    expect(mockAppendOpeningStock).toHaveBeenCalledWith(
      fakeClient,
      expect.objectContaining({ itemId: "child-1", quantity: "3", unitCost: "0", sourceKey: "conn-1" }),
    );
  });

  it("wires inventory create for retail item_stock and food_service inventory_items + stock_movements", async () => {
    mockGetBusinessIndustry.mockResolvedValueOnce("cosmetics");
    mockGetRunSummary.mockResolvedValueOnce({
      run: {
        id: runId,
        businessId: bizId,
        locationId: locId,
        domain: "inventory",
        sourceKind: "provider",
        provider: "holoo",
        sourceKey: "holoo:c1:inventory",
        connectionId: null,
        sourceFingerprint: "fp",
        policyVersion: 1,
        scope: {},
      },
    });
    const fakeRetailClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT id::text AS id FROM items")) return { rows: [{ id: "item-retail-1" }] };
        return { rows: [] };
      }),
    };
    let retailResult: { canonicalId: string } | null = null;
    mockApplyRun.mockImplementationOnce(async ({ handler }: { handler: ApplyHandler }) => {
      retailResult = await handler.create!({
        client: fakeRetailClient as unknown as ApplyContext["client"],
        run: { id: runId, businessId: bizId, locationId: locId, domain: "inventory", sourceKey: "holoo:c1:inventory", provider: "holoo", connectionId: null } as unknown as ApplyContext["run"],
        item: {
          id: 2,
          externalType: "inventory",
          externalKey: "hs-1",
          snapshot: { kind: "snapshot", cause: "opening", productExternalId: "hg-1", quantity: "8", fields: { name: "محصول", unitCostRial: "25000" } },
        } as unknown as ApplyContext["item"],
        canonicalId: "item-retail-1",
        authorityOverrides: {},
        idempotencyKey: `${runId}:2`,
        actor,
      });
      return { run: { id: runId, status: "applied" }, counts: {}, progress: {} };
    });

    await applyReconciliationRunWithDomainHandlers({ businessId: bizId, runId, locationId: locId, actor });
    expect(retailResult).toEqual({ canonicalId: "item-retail-1" });
    // GH #1567 F2 — proposed as opening stock, never written to the shelf
    // without its journal entry.
    expect(fakeRetailClient.query).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO item_stock"), expect.anything());
    expect(mockAppendOpeningStock).toHaveBeenCalledWith(fakeRetailClient, {
      businessId: bizId,
      locationId: locId,
      sourceKey: "holoo:c1:inventory",
      itemId: "item-retail-1",
      quantity: "8",
      unitCost: "25000",
      createdBy: actor.userId ?? null,
    });
  });

  it("writes food_service inventory.items product runs into inventory_items (not menu_items) and finalizes linked Data Transfer jobs", async () => {
    mockGetBusinessIndustry.mockResolvedValueOnce("food_service");
    mockGetRunSummary.mockResolvedValueOnce({
      run: {
        id: runId,
        businessId: bizId,
        locationId: locId,
        domain: "product",
        sourceKind: "file",
        provider: "data_transfer",
        sourceKey: "job:99999999-9999-4999-8999-999999999999",
        connectionId: null,
        sourceFingerprint: "fp",
        policyVersion: 1,
        scope: { entityKey: "inventory.items", canonicalTable: "inventory_items" },
      },
    });
    const fakeFoodClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT industry FROM businesses")) return { rows: [{ industry: "food_service" }] };
        if (sql.includes("INSERT INTO inventory_items")) return { rows: [{ id: "inv-item-99" }] };
        return { rows: [] };
      }),
    };
    let created: { canonicalId: string } | null = null;
    mockApplyRun.mockImplementationOnce(async ({ handler }: { handler: ApplyHandler }) => {
      created = await handler.create!({
        client: fakeFoodClient as unknown as ApplyContext["client"],
        run: { id: runId, businessId: bizId, locationId: locId, domain: "product", scope: { entityKey: "inventory.items", canonicalTable: "inventory_items" } } as unknown as ApplyContext["run"],
        item: {
          id: 5,
          externalType: "product",
          externalKey: "RAW-1",
          snapshot: { name: "آرد گندم", sku: "RAW-1", unit: "kg", fields: { unit: "kg" } },
        } as unknown as ApplyContext["item"],
        canonicalId: null,
        authorityOverrides: {},
        idempotencyKey: `${runId}:5`,
        actor,
      });
      return { run: { id: runId, status: "applied" }, counts: {}, progress: {} };
    });

    await applyReconciliationRunWithDomainHandlers({ businessId: bizId, runId, locationId: locId, actor });
    expect(created).toEqual({ canonicalId: "inv-item-99" });
    expect(fakeFoodClient.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO inventory_items"),
      [locId, "آرد گندم", "RAW-1", "kg", null, null, 1, true],
    );
    expect(mockFinalizeImportJob).toHaveBeenCalledWith(bizId, runId, {
      locationId: locId,
      actorUserId: actor.userId,
      actorName: actor.name,
    });
  });
});
