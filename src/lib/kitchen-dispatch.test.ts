import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { readDeploymentProfile } from "./deployment-mode";
import { deploymentRole } from "./deployment-role";
import { enqueueKitchenDispatch, kitchenDispatchOwner } from "./kitchen-dispatch";

vi.mock("./deployment-mode", () => ({ readDeploymentProfile: vi.fn() }));
vi.mock("./deployment-role", () => ({ deploymentRole: vi.fn() }));

const profileMock = vi.mocked(readDeploymentProfile);
const roleMock = vi.mocked(deploymentRole);
const client = { query: vi.fn() } as unknown as PoolClient;

beforeEach(() => {
  vi.clearAllMocks();
  profileMock.mockResolvedValue({ profile: "hybrid" } as never);
  roleMock.mockReturnValue("site");
  vi.mocked(client.query).mockResolvedValue({ rows: [{ id: "dispatch-1" }] } as never);
});

describe("kitchen print ownership", () => {
  it("assigns one physical owner for each deployment profile", () => {
    expect(kitchenDispatchOwner("local", "central")).toBe("local_runtime");
    expect(kitchenDispatchOwner("hybrid", "site")).toBe("hybrid_site");
    expect(kitchenDispatchOwner("hybrid", "central")).toBeNull();
    expect(kitchenDispatchOwner("cloud", "central")).toBe("cloud_station");
    expect(kitchenDispatchOwner("cloud", "site")).toBeNull();
  });

  it("stores one intent for the exact order and sorted item-id set", async () => {
    await expect(enqueueKitchenDispatch(client, {
      businessId: "biz-1",
      locationId: "loc-1",
      orderId: "order-1",
      itemIds: ["line-b", "line-a"],
    })).resolves.toBe("dispatch-1");

    const [sql, params] = vi.mocked(client.query).mock.calls[0];
    expect(String(sql)).toContain("ON CONFLICT (location_id,idempotency_key)");
    expect(params).toEqual([
      "biz-1", "loc-1", "order-1", ["line-a", "line-b"], expect.stringMatching(/^kitchen:order-1:/), "hybrid_site",
    ]);
  });

  it("never creates a second physical queue on the hybrid cloud", async () => {
    roleMock.mockReturnValue("central");
    await expect(enqueueKitchenDispatch(client, {
      businessId: "biz-1",
      locationId: "loc-1",
      orderId: "order-1",
      itemIds: ["line-a"],
    })).resolves.toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });
});
