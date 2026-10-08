import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PATCH, DELETE } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/floor", () => ({ validWaiterId: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));

const ctx = { params: Promise.resolve({ id: "section-1" }) };
const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({ session: null, error: forbidden() } as never);
});

describe("/api/floor/sections/[id] structural mutations", () => {
  it.each([
    ["PATCH", () => PATCH(new NextRequest("http://localhost/api/floor/sections/section-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New name" }),
    }), ctx)],
    ["DELETE", () => DELETE(new NextRequest("http://localhost/api/floor/sections/section-1", { method: "DELETE" }), ctx)],
  ])("requires tables.edit for %s", async (_method, call) => {
    const response = await call();
    expect(response.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesEdit);
  });
});
