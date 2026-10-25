import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  deploymentRole: vi.fn(),
  getMasterKey: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/lib/deployment-role", () => ({ deploymentRole: mocks.deploymentRole }));
vi.mock("@/lib/master-key", () => ({ getMasterKey: mocks.getMasterKey }));

import { GET } from "./route";

const originalDesktopInstance = process.env.DESKTOP_INSTANCE_ID;
afterEach(() => {
  if (originalDesktopInstance === undefined) delete process.env.DESKTOP_INSTANCE_ID;
  else process.env.DESKTOP_INSTANCE_ID = originalDesktopInstance;
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requirePermission.mockResolvedValue({ session: { businessId: "business-1" }, error: null });
  mocks.deploymentRole.mockReturnValue("site");
  process.env.DESKTOP_INSTANCE_ID = "desktop-1";
});

describe("Owner Desktop recovery kit", () => {
  it("does not resolve key material for an unauthorized caller", async () => {
    mocks.requirePermission.mockResolvedValue({ error: new Response("forbidden", { status: 403 }) });
    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocks.getMasterKey).not.toHaveBeenCalled();
  });

  it("never exposes a central installation key to a tenant", async () => {
    mocks.deploymentRole.mockReturnValue("central");
    const response = await GET();
    expect(response.status).toBe(404);
    expect(mocks.getMasterKey).not.toHaveBeenCalled();
  });

  it("returns only the master key with no-store semantics on Desktop", async () => {
    const key = Buffer.alloc(32, 7);
    mocks.getMasterKey.mockReturnValue(key);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      recoveryKit: { format: "POS_MASTER_KEY/base64", masterKey: key.toString("base64") },
    });
  });
});
