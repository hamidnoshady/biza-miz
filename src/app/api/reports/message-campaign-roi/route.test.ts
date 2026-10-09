import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as campaigns from "@/lib/message-campaigns-service";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});
vi.mock("@/lib/message-campaigns-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/message-campaigns-service")>();
  return { ...actual, listMessageCampaignRoiReport: vi.fn(async () => []) };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
});

describe("GET /api/reports/message-campaign-roi", () => {
  it("uses the consolidated capability because campaigns and their ledger spend are business-level", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.business_wide");
    expect(campaigns.listMessageCampaignRoiReport).toHaveBeenCalledWith("biz-1");
  });

  it("refuses a branch-only viewer before reading campaign data", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(campaigns.listMessageCampaignRoiReport).not.toHaveBeenCalled();
  });
});
