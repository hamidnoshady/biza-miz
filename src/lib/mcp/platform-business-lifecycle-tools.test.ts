import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessSummary } from "../platform-service";

const mocks = vi.hoisted(() => {
  class BusinessLifecycleMutationError extends Error {
    readonly code: string;
    readonly details: Record<string, unknown>;
    constructor(code: string, details: Record<string, unknown> = {}) {
      super(code);
      this.name = "BusinessLifecycleMutationError";
      this.code = code;
      this.details = details;
    }
  }
  return {
    getBusiness: vi.fn(),
    setStatus: vi.fn(),
    apply: vi.fn(),
    audit: vi.fn(async () => {}),
    BusinessLifecycleMutationError,
  };
});

vi.mock("../db", () => ({
  query: vi.fn(),
  withoutTenantScope: (_reason: string, work: () => unknown) => work(),
}));

vi.mock("../platform-auth", () => ({
  platformAudit: mocks.audit,
  revokeAllPlatformAdminSessions: vi.fn(async () => {}),
}));

vi.mock("../platform-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform-service")>();
  return {
    ...actual,
    getBusiness: mocks.getBusiness,
    setBusinessStatus: mocks.setStatus,
  };
});

vi.mock("../platform-business-lifecycle-service", () => ({
  applyBusinessLifecycleTransition: mocks.apply,
  BusinessLifecycleMutationError: mocks.BusinessLifecycleMutationError,
}));

import {
  callPlatformMcpTool,
  platformMcpToolCatalogue,
  type PlatformMcpConnection,
} from "./platform-mcp";

function connection(overrides: Partial<PlatformMcpConnection> = {}): PlatformMcpConnection {
  return {
    id: "connection-1",
    adminId: "admin-1",
    adminName: "Owner",
    adminRole: "owner",
    name: "test-connector",
    origin: "token",
    capabilities: ["business.archive"],
    businessIds: null,
    status: "active",
    lastUsedAt: null,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

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

const archiveArguments = {
  businessId: "business-1",
  expectedStatus: "active",
  idempotencyKey: "archive-attempt-1",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("platform MCP archive-boundary catalogue", () => {
  it("exposes both tools to an owner holding business.archive", () => {
    const names = platformMcpToolCatalogue(
      connection({ capabilities: ["business.archive", "business.suspend"] }),
    ).map((tool) => tool.name);
    expect(names).toContain("archive_business");
    expect(names).toContain("restore_archived_business");
    expect(names).toContain("set_business_status");
  });

  it("hides archive/restore from an engineer even if the credential was minted with the capability", () => {
    const names = platformMcpToolCatalogue(
      connection({ adminRole: "engineer", capabilities: ["business.archive", "business.suspend"] }),
    ).map((tool) => tool.name);
    expect(names).not.toContain("archive_business");
    expect(names).not.toContain("restore_archived_business");
    expect(names).toContain("set_business_status");
  });

  it("hides archive/restore from a credential that only holds business.suspend, and denies the call", async () => {
    const suspendOnly = connection({ capabilities: ["business.suspend"] });
    expect(platformMcpToolCatalogue(suspendOnly).map((tool) => tool.name)).not.toContain(
      "archive_business",
    );

    const result = await callPlatformMcpTool(suspendOnly, "archive_business", archiveArguments);
    expect(result.text).toContain("denied");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: "denied_capability", tool: "archive_business" }),
      }),
    );
  });

  it("describes the risk and the typed confirmation in the tool catalogue", () => {
    const archive = platformMcpToolCatalogue(connection()).find(
      (tool) => tool.name === "archive_business",
    );
    const restore = platformMcpToolCatalogue(connection()).find(
      (tool) => tool.name === "restore_archived_business",
    );
    expect(archive?.stepUp).toBe(true);
    expect(restore?.stepUp).toBe(true);
    expect(archive?.description).toContain("ARCHIVE <slug>");
    expect(archive?.description).toContain("confirm:true");
    expect(restore?.description).toContain("RESTORE <slug>");
    expect(archive?.inputSchema.required).toEqual(
      expect.arrayContaining(["businessId", "expectedStatus", "idempotencyKey"]),
    );
  });
});

describe("archive_business / restore_archived_business execution", () => {
  it("returns a no-write preview unless confirm:true", async () => {
    mocks.getBusiness.mockResolvedValue(business());

    const result = await callPlatformMcpTool(connection(), "archive_business", archiveArguments);
    const data = result.data as Record<string, unknown>;

    expect(data).toMatchObject({
      ok: false,
      preview: true,
      stepUpRequired: true,
      action: "archive",
      businessId: "business-1",
      from: "active",
      to: "archived",
      stale: false,
      transitionValid: true,
      confirmationPhrase: "ARCHIVE acme",
      requiredCapability: "business.archive",
    });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          tool: "archive_business",
          outcome: "preview",
          idempotencyKey: "archive-attempt-1",
        }),
      }),
    );
  });

  it("reports staleness and an invalid transition in the preview", async () => {
    mocks.getBusiness.mockResolvedValue(business({ status: "archived" }));

    const stale = await callPlatformMcpTool(connection(), "archive_business", archiveArguments);
    expect(stale.data).toMatchObject({
      preview: true,
      stale: true,
      transitionValid: false,
      transitionError: "same_status",
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("passes one explicit target, the typed phrase and the effective capability to the lifecycle service", async () => {
    mocks.getBusiness.mockResolvedValue(business());
    mocks.apply.mockResolvedValue({
      ok: true,
      businessId: "business-1",
      action: "archive",
      from: "active",
      to: "archived",
      status: "archived",
      capability: "business.archive",
      auditAction: "business.archived",
      correlationId: "mcp:connection-1:archive-attempt-1",
      idempotencyKey: "archive-attempt-1",
      replayed: false,
      business: business({ status: "archived" }),
      currentStatus: "archived",
    });

    const result = await callPlatformMcpTool(connection(), "archive_business", {
      ...archiveArguments,
      confirmation: "ARCHIVE acme",
      confirm: true,
      reason: "customer closed",
    });
    expect(result.data).toMatchObject({ ok: true, status: "archived" });
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "business-1",
        to: "archived",
        expectedFrom: "active",
        action: "archive",
        confirmation: "ARCHIVE acme",
        idempotencyKey: "archive-attempt-1",
        reason: "customer closed",
        actor: expect.objectContaining({
          adminId: "admin-1",
          adminRole: "owner",
          connectionId: "connection-1",
          source: "platform_mcp",
        }),
        effectiveCapabilities: expect.arrayContaining(["business.archive"]),
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          tool: "archive_business",
          outcome: "ok",
          correlationId: "mcp:connection-1:archive-attempt-1",
        }),
      }),
    );
  });

  it("rejects batch businessIds instead of archiving several tenants", async () => {
    mocks.getBusiness.mockResolvedValue(business());

    const result = await callPlatformMcpTool(connection(), "archive_business", {
      ...archiveArguments,
      businessIds: ["business-1"],
      confirmation: "ARCHIVE acme",
      confirm: true,
    });

    expect(result.data).toMatchObject({ ok: false, error: "batch_not_supported" });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: "failed", errorCode: "batch_not_supported" }),
      }),
    );
  });

  it("returns the service's stable refusal code and audits it as failed", async () => {
    mocks.getBusiness.mockResolvedValue(business());
    mocks.apply.mockRejectedValue(
      new mocks.BusinessLifecycleMutationError("stale_state", {
        from: "suspended",
        expectedFrom: "active",
        to: "archived",
      }),
    );

    const result = await callPlatformMcpTool(connection(), "archive_business", {
      ...archiveArguments,
      confirmation: "ARCHIVE acme",
      confirm: true,
    });

    expect(result.data).toMatchObject({
      ok: false,
      error: "stale_state",
      from: "suspended",
      expectedFrom: "active",
      to: "archived",
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: "failed", errorCode: "stale_state" }),
      }),
    );
  });

  it("requires the archived source state for restore", async () => {
    const result = await callPlatformMcpTool(connection(), "restore_archived_business", {
      businessId: "business-1",
      expectedStatus: "active",
      idempotencyKey: "restore-1",
    });
    expect(result.data).toMatchObject({
      ok: false,
      error: "invalid_expected_status",
      allowed: ["archived"],
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("refuses the protected platform-internal tenant even in the preview", async () => {
    mocks.getBusiness.mockResolvedValue(
      business({ ownershipKind: "platform_internal" }),
    );
    const result = await callPlatformMcpTool(connection(), "archive_business", archiveArguments);
    expect(result.data).toMatchObject({
      ok: false,
      error: "protected_internal_business",
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("refuses an out-of-scope business before any mutation", async () => {
    const scoped = connection({ businessIds: ["another-business"] });
    const result = await callPlatformMcpTool(scoped, "archive_business", {
      ...archiveArguments,
      confirmation: "ARCHIVE acme",
      confirm: true,
    });
    expect(result.text).toContain("outside this credential's bridge list");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: "denied_scope" }),
      }),
    );
  });
});

describe("set_business_status keeps suspend/reactivate and closes the archive bypass", () => {
  it("suspends and reactivates through the conditional console setter", async () => {
    const suspendOnly = connection({ capabilities: ["business.suspend"] });

    mocks.getBusiness.mockResolvedValue(business({ status: "active" }));
    mocks.setStatus.mockResolvedValue(business({ status: "suspended" }));
    const suspended = await callPlatformMcpTool(suspendOnly, "set_business_status", {
      businessId: "business-1",
      status: "suspended",
    });
    expect((suspended.data as { perBusiness: Record<string, unknown> }).perBusiness["business-1"])
      .toMatchObject({ ok: true, status: "suspended" });
    expect(mocks.setStatus).toHaveBeenCalledWith("business-1", "suspended", {
      expectFrom: "active",
    });

    mocks.getBusiness.mockResolvedValue(business({ status: "suspended" }));
    mocks.setStatus.mockResolvedValue(business({ status: "active" }));
    const active = await callPlatformMcpTool(suspendOnly, "set_business_status", {
      businessId: "business-1",
      status: "active",
    });
    expect((active.data as { perBusiness: Record<string, unknown> }).perBusiness["business-1"])
      .toMatchObject({ ok: true, status: "active" });
    expect(mocks.setStatus).toHaveBeenCalledWith("business-1", "active", {
      expectFrom: "suspended",
    });
  });

  it("keeps the historical same-status no-op conditional", async () => {
    const suspendOnly = connection({ capabilities: ["business.suspend"] });
    mocks.getBusiness.mockResolvedValue(business({ status: "suspended" }));
    mocks.setStatus.mockResolvedValue(business({ status: "suspended" }));

    const result = await callPlatformMcpTool(suspendOnly, "set_business_status", {
      businessId: "business-1",
      status: "suspended",
    });
    expect((result.data as { perBusiness: Record<string, unknown> }).perBusiness["business-1"])
      .toMatchObject({ ok: true, status: "suspended", unchanged: true });
    expect(mocks.setStatus).toHaveBeenCalledWith("business-1", "suspended", {
      expectFrom: "suspended",
    });
  });

  it("does not let business.suspend reactivate an archived tenant", async () => {
    const suspendOnly = connection({ capabilities: ["business.suspend"] });
    mocks.getBusiness.mockResolvedValue(business({ status: "archived", archivedAt: "2026-02-01" }));

    const result = await callPlatformMcpTool(suspendOnly, "set_business_status", {
      businessId: "business-1",
      status: "active",
    });
    expect((result.data as { perBusiness: Record<string, unknown> }).perBusiness["business-1"])
      .toMatchObject({
        ok: false,
        error: "use_restore_archived_business",
        requiredCapability: "business.archive",
      });
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("refuses the protected platform-internal tenant for suspend too", async () => {
    const suspendOnly = connection({ capabilities: ["business.suspend"] });
    mocks.getBusiness.mockResolvedValue(
      business({ status: "active", ownershipKind: "platform_internal" }),
    );

    const result = await callPlatformMcpTool(suspendOnly, "set_business_status", {
      businessId: "business-1",
      status: "suspended",
    });
    expect((result.data as { perBusiness: Record<string, unknown> }).perBusiness["business-1"])
      .toMatchObject({ ok: false, error: "protected_internal_business" });
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
});
