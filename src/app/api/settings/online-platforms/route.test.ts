import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as platforms from "@/lib/online-platforms-service";
import * as paymentMethods from "@/lib/payment-methods-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: () => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/online-platforms-service", () => ({
  getOnlinePlatformsConfig: vi.fn(),
  setOnlinePlatformsConfig: vi.fn(),
}));
vi.mock("@/lib/payment-methods-service", () => ({ listPaymentMethods: vi.fn() }));

const session = { businessId: "business-1", sub: "owner-1", role: "owner" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(platforms.getOnlinePlatformsConfig).mockResolvedValue({ snappfood: null } as never);
  vi.mocked(paymentMethods.listPaymentMethods).mockResolvedValue([
    { id: "snap", name: "اسنپ‌فود", settlement: "snappfood", isActive: true },
  ] as never);
});

describe("GET /api/settings/online-platforms", () => {
  it("remains available to an F&B settings manager through its delivery module", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.settingsManage);
    expect(platforms.getOnlinePlatformsConfig).toHaveBeenCalledWith("business-1");
    expect(await response.json()).toMatchObject({
      paymentMethod: { name: "اسنپ‌فود", isActive: true },
    });
  });
});
