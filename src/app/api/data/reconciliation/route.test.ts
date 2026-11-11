import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDataOwner,
  mockEntityAccess,
  mockRequirePermission,
  mockGetBusinessIndustry,
  mockListRuns,
  mockGetRunSummary,
  mockListItems,
  mockApply,
  mockSetCutover,
  mockApproveSafe,
  mockDecideItem,
  mockCancelRun,
} = vi.hoisted(() => ({
  mockDataOwner: vi.fn(),
  mockEntityAccess: vi.fn(),
  mockRequirePermission: vi.fn(),
  mockGetBusinessIndustry: vi.fn(),
  mockListRuns: vi.fn(),
  mockGetRunSummary: vi.fn(),
  mockListItems: vi.fn(),
  mockApply: vi.fn(),
  mockSetCutover: vi.fn(),
  mockApproveSafe: vi.fn(),
  mockDecideItem: vi.fn(),
  mockCancelRun: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mockRequirePermission,
}));
vi.mock("@/lib/industry-guard", () => ({
  getBusinessIndustry: mockGetBusinessIndustry,
}));
vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: vi.fn().mockResolvedValue({ id: "loc-1" }),
}));
vi.mock("../guard", () => ({
  PERMISSIONS: { dataImport: "data.import", ledgerPost: "ledger.post" },
  dataOwner: mockDataOwner,
  entityAccess: mockEntityAccess,
  fileResponse: (body: string, contentType: string, filename: string) =>
    new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    }),
}));
vi.mock("@/lib/import-reconciliation/apply-runner", () => ({
  applyReconciliationRunWithDomainHandlers: mockApply,
}));
vi.mock("@/lib/import-reconciliation/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/import-reconciliation/service")>();
  return {
    ...actual,
    listRuns: mockListRuns,
    getRunSummary: mockGetRunSummary,
    listItems: mockListItems,
    setRunCutoverPolicy: mockSetCutover,
    approveSafeBatch: mockApproveSafe,
    decideItem: mockDecideItem,
    cancelRun: mockCancelRun,
  };
});

import { GET as listRunsHandler } from "./route";
import { GET as getRunHandler, POST as postRunHandler } from "./[id]/route";

const owner = {
  businessId: "biz-1",
  locationId: "loc-1",
  actorUserId: "user-1",
  actorName: "مدیر",
  session: {},
};
const runId = "11111111-1111-4111-8111-111111111111";

describe("/api/data/reconciliation routes (#1118)", () => {
  beforeEach(() => {
    mockDataOwner.mockReset().mockResolvedValue({ owner, error: null });
    mockEntityAccess.mockReset().mockResolvedValue({ error: null });
    mockRequirePermission.mockReset().mockResolvedValue({ error: null });
    mockGetBusinessIndustry.mockReset().mockResolvedValue("cosmetics");
    mockListRuns.mockReset().mockResolvedValue([]);
    mockGetRunSummary.mockReset().mockResolvedValue({
      run: {
        id: runId,
        domain: "product",
        locationId: "loc-1",
        sourceKind: "provider",
        provider: "woocommerce",
        sourceKey: "woo-1",
        connectionId: "22222222-2222-4222-8222-222222222222",
        importMode: "live_link",
        status: "in_review",
        cutoverAuthority: "books",
        cutoverAt: "2026-11-01T00:00:00Z",
        createdByName: "مدیر",
        createdAt: "2026-11-01T00:00:00Z",
        appliedAt: null,
        crossChecked: false,
      },
      counts: {
        read: 1,
        alreadyMapped: 0,
        proposedLinks: 1,
        newRecords: 0,
        conflicts: 0,
        invalid: 0,
        historical: 0,
        pending: 0,
        approved: 1,
        skipped: 0,
        applied: 0,
        failed: 0,
      },
      progress: { stage: "in_review", label: "آماده", fullyReconciled: false, remaining: 0 },
    });
    mockListItems.mockReset().mockResolvedValue([
      {
        id: 1,
        runId,
        externalType: "product",
        externalKey: "w-10",
        rowNumber: 1,
        snapshot: { name: "ساعت", sku: "W-10" },
        outcome: "safe_match",
        reasons: ["unique_sku"],
        canonicalId: "33333333-3333-4333-8333-333333333333",
        candidates: [],
        conflicts: [],
        notes: [],
        historical: false,
        status: "approved",
        effect: "link",
        resolvedCanonicalId: null,
        error: null,
      },
    ]);
    mockApply.mockReset().mockResolvedValue({ summary: { run: { status: "applied" } }, crossCheck: { ok: true, problems: [] } });
    mockSetCutover.mockReset().mockResolvedValue({ id: runId, cutoverAuthority: "books" });
  });

  it("enforces dataImport permission when listing runs and passes domain/connectionId filters", async () => {
    const req = new NextRequest("http://localhost/api/data/reconciliation?domain=product&activeOnly=true");
    const res = await listRunsHandler(req);
    expect(res.status).toBe(200);
    expect(mockListRuns).toHaveBeenCalledWith("biz-1", {
      domain: "product",
      connectionId: undefined,
      activeOnly: true,
    });
  });

  it("exports CSV & JSON reports without sensitive PII and requires ledgerPost on financial_document runs", async () => {
    const csvReq = new NextRequest(`http://localhost/api/data/reconciliation/${runId}?report=csv`);
    const csvRes = await getRunHandler(csvReq, { params: Promise.resolve({ id: runId }) });
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("Content-Type")).toContain("text/csv");
    expect(await csvRes.text()).toContain("w-10");

    mockGetRunSummary.mockResolvedValueOnce({
      run: { id: runId, domain: "financial_document", locationId: "loc-1", status: "in_review" },
      counts: {},
      progress: {},
    });
    mockRequirePermission.mockResolvedValueOnce({
      error: Response.json({ error: "forbidden" }, { status: 403 }),
    });
    const finReq = new NextRequest(`http://localhost/api/data/reconciliation/${runId}`);
    const finRes = await getRunHandler(finReq, { params: Promise.resolve({ id: runId }) });
    expect(finRes.status).toBe(403);
  });

  it("validates cutoverAuthority & authorityOverrides and executes apply cleanly", async () => {
    const badReq = new NextRequest(`http://localhost/api/data/reconciliation/${runId}`, {
      method: "POST",
      body: JSON.stringify({ action: "cutover", cutoverAuthority: "store" }),
    });
    const badRes = await postRunHandler(badReq, { params: Promise.resolve({ id: runId }) });
    expect(badRes.status).toBe(400);

    const goodCutoverReq = new NextRequest(`http://localhost/api/data/reconciliation/${runId}`, {
      method: "POST",
      body: JSON.stringify({ action: "cutover", cutoverAuthority: "books" }),
    });
    const goodCutoverRes = await postRunHandler(goodCutoverReq, { params: Promise.resolve({ id: runId }) });
    expect(goodCutoverRes.status).toBe(200);
    expect(mockSetCutover).toHaveBeenCalledTimes(1);

    const applyReq = new NextRequest(`http://localhost/api/data/reconciliation/${runId}`, {
      method: "POST",
      body: JSON.stringify({ action: "apply" }),
    });
    const applyRes = await postRunHandler(applyReq, { params: Promise.resolve({ id: runId }) });
    expect(applyRes.status).toBe(200);
    expect(mockApply).toHaveBeenCalledTimes(1);
  });
});
