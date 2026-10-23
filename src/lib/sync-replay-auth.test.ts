import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorize } from "./authorize";
import { query } from "./db";
import { authorizeSyncReplay } from "./sync-replay-auth";

vi.mock("./authorize", () => ({ authorize: vi.fn() }));
vi.mock("./db", () => ({
  query: vi.fn(),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
}));

const authorizeMock = vi.mocked(authorize);
const queryMock = vi.mocked(query);

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [{ business_id: "biz-current", role: "cashier" }] } as never);
});

describe("authorizeSyncReplay", () => {
  it("delegates live membership, effective permissions, and branch scope to authorize()", async () => {
    authorizeMock.mockResolvedValue({
      ok: true,
      session: { sub: "member-1", role: "admin" },
      membership: { permissions: new Set(["orders.create"]) },
    } as never);

    const result = await authorizeSyncReplay({
      locationId: "branch-1",
      userId: "member-1",
      permissions: ["orders.create"],
    });

    expect(authorizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "member-1", businessId: "biz-current" }),
      { anyPermission: ["orders.create"], locationId: "branch-1" },
    );
    expect(result).toEqual({
      ok: true,
      businessId: "biz-current",
      role: "admin",
      permissions: new Set(["orders.create"]),
    });
  });

  it("fails closed when a live membership is revoked or the branch is out of scope", async () => {
    authorizeMock.mockResolvedValue({ ok: false, code: "LOCATION_FORBIDDEN", status: 403 } as never);
    await expect(authorizeSyncReplay({
      locationId: "branch-1",
      userId: "member-1",
      permissions: ["orders.create"],
    })).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("refuses an inactive or nonexistent branch before authorizing the user", async () => {
    queryMock.mockResolvedValue({ rows: [] } as never);
    await expect(authorizeSyncReplay({
      locationId: "branch-1",
      userId: "member-1",
      permissions: ["orders.create"],
    })).resolves.toEqual({ ok: false, error: "unknown_location" });
    expect(authorizeMock).not.toHaveBeenCalled();
  });
});
