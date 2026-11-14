import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithTenantTransaction,
  mockGetBusinessIndustry,
  mockCreateItem,
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
} = vi.hoisted(() => ({
  mockWithTenantTransaction: vi.fn(),
  mockGetBusinessIndustry: vi.fn(),
  mockCreateItem: vi.fn(),
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
}));

vi.mock("../db", () => ({
  withTenantTransaction: mockWithTenantTransaction,
}));
vi.mock("../industry-guard", () => ({
  getBusinessIndustry: mockGetBusinessIndustry,
}));
vi.mock("../items-service", () => ({
  createItem: mockCreateItem,
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
    expect(fakeRetailClient.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO item_stock"),
      ["item-retail-1", "8", "25000"],
    );
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
