import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  bulkAssign: vi.fn(),
  PartyValidationError: class PartyValidationError extends Error {
    code = "party_validation_error";
    field?: string;
    constructor(code: string, field?: string) {
      super(code);
      this.code = code;
      this.field = field;
    }
  },
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
}));

vi.mock("@/lib/parties-service", () => ({
  bulkAssignMissingStaffAccountingCodes: mocks.bulkAssign,
  PartyValidationError: mocks.PartyValidationError,
}));

import * as auth from "@/lib/auth";
import { POST } from "./route";

const SESSION = { businessId: "biz-1", sub: "actor-1", role: "member" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ session: SESSION, error: null } as never);
  mocks.bulkAssign.mockResolvedValue({ assigned: [], skipped: [], failed: [] });
});

describe("POST /api/parties/assign-codes", () => {
  it("calls requirePermission with PERMISSIONS.partiesManage", async () => {
    await POST();
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.partiesManage);
  });

  it("returns 403 without invoking bulkAssign when the caller lacks partiesManage", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);

    const res = await POST();

    expect(res.status).toBe(403);
    expect(mocks.bulkAssign).not.toHaveBeenCalled();
  });

  it("delegates to bulkAssignMissingStaffAccountingCodes with the session business and actor", async () => {
    mocks.bulkAssign.mockResolvedValue({
      assigned: [{ id: "p-1", code: "300001" }],
      skipped: [{ id: "p-2", reason: "already_has_code" as const }],
      failed: [],
    });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mocks.bulkAssign).toHaveBeenCalledWith(SESSION.businessId, { actorId: SESSION.sub });
    const body = await res.json();
    expect(body.assigned).toHaveLength(1);
  });

  it("maps PartyValidationError to 409 Conflict", async () => {
    mocks.bulkAssign.mockRejectedValue(new mocks.PartyValidationError("accounting_code_namespace_full"));
    const res = await POST();
    expect(res.status).toBe(409);
  });
});
