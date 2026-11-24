import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessSummary } from "./platform-service";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getBusiness: vi.fn(),
  setStatus: vi.fn(),
  audit: vi.fn(async () => {}),
}));

vi.mock("./db", () => ({
  query: mocks.query,
  withoutTenantScope: (_reason: string, work: () => unknown) => work(),
}));

vi.mock("./platform-service", () => ({
  getBusiness: mocks.getBusiness,
  setBusinessStatus: mocks.setStatus,
}));

vi.mock("./platform-auth", () => ({ platformAudit: mocks.audit }));

import {
  applyBusinessLifecycleTransition,
  BusinessLifecycleMutationError,
  type ApplyBusinessLifecycleInput,
} from "./platform-business-lifecycle-service";

function business(overrides: Partial<BusinessSummary> = {}): BusinessSummary {
  return {
    id: "business-1",
    name: "Acme",
    slug: "acme",
    subdomain: "acme",
    status: "active",
    plan: "standard",
    timezone: "Asia/Tehran",
    industry: "food_service",
    ownershipKind: "customer",
    createdAt: "2026-01-01T00:00:00.000Z",
    suspendedAt: null,
    archivedAt: null,
    locationCount: 1,
    memberCount: 2,
    orderCount: 0,
    lastActivityAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<ApplyBusinessLifecycleInput> = {}): ApplyBusinessLifecycleInput {
  return {
    businessId: "business-1",
    to: "archived",
    expectedFrom: "active",
    action: "archive",
    confirmation: "ARCHIVE acme",
    idempotencyKey: "archive-1",
    correlationId: "corr-1",
    actor: {
      adminId: "admin-1",
      adminName: "Owner",
      adminRole: "owner",
      connectionId: "connection-1",
      connectionName: "test-connector",
      source: "platform_mcp",
    },
    effectiveCapabilities: ["business.archive"],
    ...overrides,
  };
}

function replayRow(overrides: Record<string, unknown> = {}) {
  return {
    business_id: "business-1",
    action: "business.archived",
    payload: {
      source: "platform_mcp",
      action: "archive",
      from: "active",
      to: "archived",
      expectedFrom: "active",
      capability: "business.archive",
      correlationId: "original-correlation",
      idempotencyKey: "archive-1",
      outcome: "succeeded",
      ...overrides,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("applyBusinessLifecycleTransition", () => {
  it("archives through the console's conditional setter and audits before/after", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getBusiness.mockResolvedValue(business());
    mocks.setStatus.mockResolvedValue(business({ status: "archived", archivedAt: "2026-02-01" }));

    const result = await applyBusinessLifecycleTransition(input());

    expect(mocks.setStatus).toHaveBeenCalledWith("business-1", "archived", {
      expectFrom: "active",
    });
    expect(result).toMatchObject({
      ok: true,
      from: "active",
      to: "archived",
      status: "archived",
      capability: "business.archive",
      auditAction: "business.archived",
      replayed: false,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-1",
        businessId: "business-1",
        action: "business.archived",
        entity: "business",
        entityId: "business-1",
        payload: expect.objectContaining({
          source: "platform_mcp",
          action: "archive",
          from: "active",
          to: "archived",
          expectedFrom: "active",
          before: { status: "active", suspendedAt: null, archivedAt: null },
          after: { status: "archived", suspendedAt: null, archivedAt: "2026-02-01" },
          capability: "business.archive",
          actor: expect.objectContaining({
            adminId: "admin-1",
            adminRole: "owner",
            connectionId: "connection-1",
          }),
          correlationId: "corr-1",
          idempotencyKey: "archive-1",
          outcome: "succeeded",
        }),
      }),
    );
  });

  it("replays the original outcome for a retry and never writes again", async () => {
    mocks.query.mockResolvedValue({ rows: [replayRow()] });
    mocks.getBusiness.mockResolvedValue(business({ status: "archived" }));

    const result = await applyBusinessLifecycleTransition(input({ correlationId: "retry-corr" }));

    expect(result).toMatchObject({
      ok: true,
      replayed: true,
      from: "active",
      to: "archived",
      status: "archived",
      correlationId: "original-correlation",
      currentStatus: "archived",
    });
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    // The replay lookup is realm-scoped: a console row can never satisfy an
    // MCP retry, even if the admin and key happen to match.
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("payload->>'source' = $3"),
      ["admin-1", "archive-1", "platform_mcp"],
    );
  });

  it("refuses a key reused across businesses without naming the other tenant", async () => {
    mocks.query.mockResolvedValue({
      rows: [replayRow({ idempotencyKey: "archive-1" })].map((row) => ({
        ...row,
        business_id: "other-business",
      })),
    });

    await expect(applyBusinessLifecycleTransition(input())).rejects.toMatchObject({
      code: "idempotency_conflict",
      details: { reason: "key_reused_across_businesses" },
    });
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("refuses a key reused for a different transition", async () => {
    mocks.query.mockResolvedValue({ rows: [replayRow({ action: "restore", to: "active" })] });

    await expect(
      applyBusinessLifecycleTransition(input({ action: "archive", to: "archived" })),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
      details: { reason: "key_reused_for_different_transition" },
    });
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("rejects a stale expectedStatus before writing", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getBusiness.mockResolvedValue(business({ status: "suspended" }));

    await expect(
      applyBusinessLifecycleTransition(input({ expectedFrom: "active" })),
    ).rejects.toMatchObject({
      code: "stale_state",
      details: { from: "suspended", expectedFrom: "active", to: "archived" },
    });
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rejects an invalid transition", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getBusiness.mockResolvedValue(business({ status: "active" }));

    await expect(
      applyBusinessLifecycleTransition(
        input({ to: "active", expectedFrom: "active", action: "restore", confirmation: "RESTORE acme" }),
      ),
    ).rejects.toMatchObject({ code: "same_status" });
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("rejects a caller without the transition capability", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getBusiness.mockResolvedValue(business());

    await expect(
      applyBusinessLifecycleTransition(input({ effectiveCapabilities: [] })),
    ).rejects.toMatchObject({
      code: "capability_denied",
      details: { capability: "business.archive" },
    });
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("rejects a phrase for another action or another tenant", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getBusiness.mockResolvedValue(business());

    for (const confirmation of ["RESTORE acme", "ARCHIVE other"]) {
      await expect(
        applyBusinessLifecycleTransition(input({ confirmation })),
      ).rejects.toMatchObject({ code: "confirmation_mismatch" });
    }
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("refuses the protected platform-internal tenant", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getBusiness.mockResolvedValue(business({ ownershipKind: "platform_internal" }));

    await expect(applyBusinessLifecycleTransition(input())).rejects.toMatchObject({
      code: "protected_internal_business",
    });
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("fails a genuine concurrent transition as a conflict", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getBusiness.mockResolvedValue(business());
    mocks.setStatus.mockResolvedValue(null);

    await expect(applyBusinessLifecycleTransition(input())).rejects.toMatchObject({
      code: "transition_conflict",
      details: { from: "active", to: "archived" },
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("re-reads the durable outcome when an identical concurrent call won", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [replayRow()] });
    mocks.getBusiness
      .mockResolvedValueOnce(business({ status: "active" }))
      .mockResolvedValue(business({ status: "archived" }));
    mocks.setStatus.mockResolvedValue(null);

    const result = await applyBusinessLifecycleTransition(input());
    expect(result).toMatchObject({ ok: true, replayed: true, status: "archived" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("derives a correlation id from the idempotency key when none is supplied", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getBusiness.mockResolvedValue(business());
    mocks.setStatus.mockResolvedValue(business({ status: "archived" }));

    await applyBusinessLifecycleTransition(input({ correlationId: "" }));
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ correlationId: "idem:archive-1" }),
      }),
    );
  });

  it("validates the idempotency key before touching the database", async () => {
    await expect(
      applyBusinessLifecycleTransition(input({ idempotencyKey: "   " })),
    ).rejects.toBeInstanceOf(BusinessLifecycleMutationError);
    await expect(
      applyBusinessLifecycleTransition(input({ idempotencyKey: "x".repeat(201) })),
    ).rejects.toMatchObject({ code: "idempotency_key_invalid" });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.getBusiness).not.toHaveBeenCalled();
  });
});
