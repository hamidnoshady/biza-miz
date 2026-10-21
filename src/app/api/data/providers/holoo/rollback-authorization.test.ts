import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { POST } from "./route";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { rollbackImportRun } from "@/lib/integrations/holoo/rollback-service";
import { getConnection } from "@/lib/integrations/connections-service";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/integrations/connections-service", () => ({ getConnection: vi.fn(), listConnections: vi.fn() }));
vi.mock("@/lib/integrations/holoo/rollback-service", () => ({ rollbackImportRun: vi.fn() }));
vi.mock("./guard", () => ({
  holooTransferOwner: vi.fn(async () => ({ owner: { businessId: "tenant-a", actorUserId: "manager" }, error: null })),
  holooLocationAccess: vi.fn(async () => ({ locationIds: new Set(["a1"]) })),
  canAccessHolooConnectionLocation: vi.fn(() => true),
}));
const id = "00000000-0000-4000-8000-000000000001";
const request = (confirmed: boolean) => new NextRequest("https://biza.example/api/data/providers/holoo", {
  method: "POST", body: JSON.stringify({ action: "rollback", connectionId: id, runId: id, confirmRollback: confirmed }),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getConnection).mockResolvedValue({ provider: "holoo", location_id: "a1" } as never);
});
it("does not let connectivity/import authority substitute for financial approval", async () => {
  vi.mocked(requirePermission).mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
  expect((await POST(request(true))).status).toBe(403);
  expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.ledgerApprove);
  expect(rollbackImportRun).not.toHaveBeenCalled();
});
it("requires explicit impact acknowledgement even from a financially authorized caller", async () => {
  vi.mocked(requirePermission).mockResolvedValue({ error: null, session: { businessId: "tenant-a" } } as never);
  const response = await POST(request(false));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "rollback_confirmation_required" });
  expect(rollbackImportRun).not.toHaveBeenCalled();
});
it("never invokes financial rollback on the wrong provider", async () => {
  vi.mocked(getConnection).mockResolvedValue({ provider: "woocommerce" } as never);
  expect((await POST(request(true))).status).toBe(404);
  expect(rollbackImportRun).not.toHaveBeenCalled();
});
