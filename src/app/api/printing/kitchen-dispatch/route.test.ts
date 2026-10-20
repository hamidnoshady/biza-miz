import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH } from "./route";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  withTenantScope: (handler: (request?: NextRequest) => Promise<Response>) => handler,
}));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: vi.fn() }));
vi.mock("@/lib/deployment-role", () => ({ deploymentRole: vi.fn() }));

const queryMock = vi.mocked(query);
const authMock = vi.mocked(requirePermission);
const locationMock = vi.mocked(resolveActiveLocation);
const profileMock = vi.mocked(readDeploymentProfile);
const roleMock = vi.mocked(deploymentRole);
const session = { businessId: "biz-1", sub: "member-1", role: "cashier" };

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ session, error: null } as never);
  locationMock.mockResolvedValue({ id: "loc-1" } as never);
  profileMock.mockResolvedValue({ profile: "cloud" } as never);
  roleMock.mockReturnValue("central");
});

describe("GET /api/printing/kitchen-dispatch", () => {
  it("claims durable intents exclusively for the configured physical owner", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{
        id: "dispatch-1",
        order_id: "order-1",
        item_ids: ["line-1"],
        idempotency_key: "kitchen:order-1:digest",
        claim_token: "claim-1",
      }] } as never);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobs: [{
      dispatchId: "dispatch-1",
      claimToken: "claim-1",
      orderId: "order-1",
      itemIds: ["line-1"],
      requestId: "kitchen-dispatch:dispatch-1",
    }] });
    expect(String(queryMock.mock.calls[1][0])).toContain("FOR UPDATE SKIP LOCKED");
    expect(queryMock.mock.calls[1][1]).toEqual(["loc-1", "cloud_station", 10, "member-1"]);
  });

  it("does not claim cloud-owned printing on a hybrid central runtime", async () => {
    profileMock.mockResolvedValue({ profile: "hybrid" } as never);
    const response = await GET();
    expect(await response.json()).toEqual({ jobs: [] });
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/printing/kitchen-dispatch", () => {
  it("acknowledges by lease token and schedules only classified safe retries", async () => {
    queryMock.mockResolvedValue({ rows: [{ id: "dispatch-1" }], rowCount: 1 } as never);
    const response = await PATCH(new NextRequest("http://local/api/printing/kitchen-dispatch", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchId: "11111111-1111-4111-8111-111111111111", claimToken: "22222222-2222-4222-8222-222222222222", handedOff: false, errorCode: "printer_offline" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, outcome: "not_delivered", retryable: true });
    expect(String(queryMock.mock.calls[0][0])).toContain("claim_until>now()");
    expect(queryMock.mock.calls[0][1]).toContain("pending");
  });

  it("quarantines ambiguous delivery rather than resending it", async () => {
    queryMock.mockResolvedValue({ rows: [{ id: "dispatch-1" }], rowCount: 1 } as never);
    const response = await PATCH(new NextRequest("http://local/api/printing/kitchen-dispatch", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchId: "11111111-1111-4111-8111-111111111111", claimToken: "22222222-2222-4222-8222-222222222222", handedOff: false, errorCode: "job_timeout", ambiguous: true }),
    }));
    expect(await response.json()).toMatchObject({ ok: true, outcome: "ambiguous", retryable: false });
    expect(queryMock.mock.calls[0][1]).toContain("ambiguous");
  });
});
