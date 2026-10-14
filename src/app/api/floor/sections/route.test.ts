import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/floor", () => ({ validWaiterId: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({
    session: null,
    error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
  } as never);
});

describe("POST /api/floor/sections", () => {
  it("requires structural floor-edit permission, not the operational tables.manage permission", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/floor/sections", {
        method: "POST",
        body: JSON.stringify({ name: "Terrace" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesEdit);
  });
});
