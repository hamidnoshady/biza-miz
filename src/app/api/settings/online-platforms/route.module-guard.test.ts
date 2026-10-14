import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  verifySession: vi.fn(),
  query: vi.fn(),
  requirePermission: vi.fn(),
  isAppAvailable: vi.fn(),
  isFeatureEnabled: vi.fn(),
  getOnlinePlatformsConfig: vi.fn(),
  listPaymentMethods: vi.fn(),
  industry: "food_service" as string,
}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth-edge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-edge")>();
  return { ...actual, verifySession: mocks.verifySession };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: mocks.requirePermission };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    query: mocks.query,
    withTenant: (_businessId: string, work: () => unknown) => work(),
  };
});
vi.mock("@/lib/app-availability-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-availability-service")>();
  return { ...actual, isAppAvailable: mocks.isAppAvailable };
});
vi.mock("@/lib/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/features")>();
  return { ...actual, isFeatureEnabled: mocks.isFeatureEnabled };
});
vi.mock("@/lib/online-platforms-service", () => ({
  getOnlinePlatformsConfig: mocks.getOnlinePlatformsConfig,
  setOnlinePlatformsConfig: vi.fn(),
}));
vi.mock("@/lib/payment-methods-service", () => ({ listPaymentMethods: mocks.listPaymentMethods }));

const session = {
  businessId: "business-1",
  locationId: "location-1",
  sub: "owner-1",
  role: "owner",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.industry = "food_service";
  mocks.cookies.mockResolvedValue({ get: () => ({ value: "tenant-session" }) });
  mocks.verifySession.mockResolvedValue(session);
  mocks.query.mockImplementation(async () => ({ rows: [{ industry: mocks.industry }] }));
  mocks.requirePermission.mockResolvedValue({ session, error: null });
  mocks.isAppAvailable.mockResolvedValue(true);
  mocks.isFeatureEnabled.mockResolvedValue(true);
  mocks.getOnlinePlatformsConfig.mockResolvedValue({ snappfood: null });
  mocks.listPaymentMethods.mockResolvedValue([]);
});

function request() {
  return new NextRequest("https://tenant.example/api/settings/online-platforms");
}

// GET's tenant wrapper has a no-argument handler type, but Next still supplies
// the request at runtime and the wrapper consumes it for centralized gates.
const directGet = GET as unknown as (request: NextRequest) => Promise<Response>;

describe("direct GET /api/settings/online-platforms module gate", () => {
  it("reaches the handler for an F&B business with the delivery module", async () => {
    const response = await directGet(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ onlinePlatforms: { snappfood: null } });
    expect(mocks.requirePermission).toHaveBeenCalledOnce();
    expect(mocks.getOnlinePlatformsConfig).toHaveBeenCalledOnce();
  });

  it("refuses a direct URL for a non-F&B business before running the settings handler", async () => {
    mocks.industry = "jewelry";
    const response = await directGet(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "module_unavailable", module: "delivery" });
    expect(mocks.requirePermission).not.toHaveBeenCalled();
    expect(mocks.getOnlinePlatformsConfig).not.toHaveBeenCalled();
  });
});
