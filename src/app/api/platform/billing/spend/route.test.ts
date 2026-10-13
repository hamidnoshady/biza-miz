/**
 * Spend-policy write regression (audit F16): the policy row and its durable
 * audit entry are one transaction, carry before/after values, and invalid
 * input is refused before any write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePlatformCapability: vi.fn(),
  platformAudit: vi.fn(),
  getSpendPolicy: vi.fn(),
  saveSpendPolicy: vi.fn(),
  evaluateBusinessSpend: vi.fn(),
  listSpendPolicies: vi.fn(),
  queryFn: vi.fn(),
  tx: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  requirePlatformCapability: mocks.requirePlatformCapability,
  platformAudit: mocks.platformAudit,
  withPlatformScope: <A extends unknown[]>(h: (...args: A) => unknown) => h,
}));

vi.mock("@/lib/billing/runtime", () => ({
  getSpendPolicy: mocks.getSpendPolicy,
  saveSpendPolicy: mocks.saveSpendPolicy,
  evaluateBusinessSpend: mocks.evaluateBusinessSpend,
  listSpendPolicies: mocks.listSpendPolicies,
}));

vi.mock("@/lib/db", () => ({
  query: mocks.queryFn,
  withoutTenantScopeTransaction: (reason: string, fn: () => Promise<unknown>) => {
    mocks.tx(reason);
    return fn();
  },
}));

import * as route from "./route";

const BUSINESS = "7f9c2b1e-4d3a-4e8f-9a1b-2c3d4e5f6a7b";

function put(body: unknown) {
  return (route.PUT as unknown as (r: Request) => Promise<Response>)(
    new Request("https://admin.example.test/api/platform/billing/spend", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformCapability.mockResolvedValue({
    session: { padmin: "admin-1", role: "owner" },
    error: undefined,
  });
  mocks.evaluateBusinessSpend.mockResolvedValue({ breakdown: {}, evaluation: {} });
});

describe("PUT /api/platform/billing/spend", () => {
  it("refuses a malformed business id before any write", async () => {
    const res = await put({ businessId: "not-a-uuid", actionAtLimit: "warn_only", monthlyBudgetRial: 1000 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_business");
    expect(mocks.saveSpendPolicy).not.toHaveBeenCalled();
    expect(mocks.platformAudit).not.toHaveBeenCalled();
  });

  it("refuses an unknown action and an unsafe budget before any write", async () => {
    let res = await put({ businessId: BUSINESS, actionAtLimit: "delete_everything" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_action");

    res = await put({ businessId: BUSINESS, actionAtLimit: "warn_only", monthlyBudgetRial: -5 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_budget");
    expect(mocks.saveSpendPolicy).not.toHaveBeenCalled();
  });

  it("writes the policy and its before/after audit inside one transaction", async () => {
    mocks.getSpendPolicy
      .mockResolvedValueOnce({
        monthlyBudgetRial: 1_000_000,
        actionAtLimit: "continue",
        thresholds: [50, 100],
      })
      .mockResolvedValueOnce({
        monthlyBudgetRial: 2_000_000,
        actionAtLimit: "warn_only",
        thresholds: [50, 100],
      })
      .mockResolvedValue({ monthlyBudgetRial: 2_000_000, actionAtLimit: "warn_only", thresholds: [50, 100] });

    const res = await put({
      businessId: BUSINESS,
      actionAtLimit: "warn_only",
      monthlyBudgetRial: 2_000_000,
      thresholds: [50, 100],
    });

    expect(res.status).toBe(200);
    expect(mocks.tx).toHaveBeenCalledWith("platform");
    expect(mocks.saveSpendPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS, actionAtLimit: "warn_only" }),
    );
    expect(mocks.platformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-1",
        businessId: BUSINESS,
        action: "billing.spend_policy.updated",
        entity: "business_spend_policy",
        entityId: BUSINESS,
        payload: {
          before: { monthlyBudgetRial: 1_000_000, actionAtLimit: "continue", thresholds: [50, 100] },
          after: { monthlyBudgetRial: 2_000_000, actionAtLimit: "warn_only", thresholds: [50, 100] },
        },
      }),
    );
  });

  it("lets a failed audit write propagate so the policy change is rolled back with it", async () => {
    mocks.getSpendPolicy.mockResolvedValue(null);
    mocks.platformAudit.mockRejectedValue(new Error("audit_down"));
    await expect(
      put({ businessId: BUSINESS, actionAtLimit: "warn_only", monthlyBudgetRial: 100 }),
    ).rejects.toThrow("audit_down");
    // The transaction helper (not a swallowed catch) owns the rollback.
    expect(mocks.tx).toHaveBeenCalled();
  });
});
