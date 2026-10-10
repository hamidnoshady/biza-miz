import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as projects from "@/lib/ai-projects";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});
vi.mock("@/lib/ai-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-projects")>();
  return { ...actual, listProjectCostReport: vi.fn(async () => []) };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
});

describe("GET /api/reports/project-costs", () => {
  it("uses the consolidated capability because project costs include unassigned ledger entries", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.business_wide");
    expect(projects.listProjectCostReport).toHaveBeenCalledWith({
      businessId: "biz-1",
      actorUserId: "user-1",
    });
  });

  it("refuses a branch-only viewer before reading project costs", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(projects.listProjectCostReport).not.toHaveBeenCalled();
  });
});
