import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-operations-service";
import { PATCH } from "./route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["branch"]) }));
vi.mock("@/lib/marketing-operations-service", () => ({ transitionOwnAssignment: vi.fn() }));
const id = "123e4567-e89b-42d3-a456-426614174000";
beforeEach(() => vi.clearAllMocks());
it("does not allow the self-service endpoint to change priority", async () => {
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "tenant", sub: "actor" }, membership: {}, error: null } as never);
  const request = new NextRequest(`http://localhost/api/growth/my-marketing-assignments/${id}`, { method: "PATCH", body: JSON.stringify({ action: "priority", expectedRevision: 0, priority: "urgent" }) });
  expect((await PATCH(request, { params: Promise.resolve({ id }) })).status).toBe(400);
  expect(service.transitionOwnAssignment).not.toHaveBeenCalled();
});
