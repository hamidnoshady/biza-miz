/**
 * Issue #972, Phase F — the contextual recommendation endpoint.
 *
 * The feed is built and ranked server-side; this test pins the two things a
 * client must be able to rely on: an unknown page is rejected, and the
 * response is the server's eligible list, never a client-supplied id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn(),
  recommend: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/learning-recommendation-service", () => ({
  learningRecommendationsFor: mocks.recommend,
}));

import { GET } from "./route";

const guard = {
  session: { businessId: "biz-1", sub: "user-1" },
  membership: { permissions: new Set([PERMISSIONS.inventoryView]) },
  error: null,
};

const req = (url: string) => new NextRequest(`https://biz.example.test${url}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMember.mockResolvedValue(guard);
  mocks.recommend.mockResolvedValue([
    {
      kind: "tour",
      id: "accounting.products.list",
      title: "فهرست محصولات",
      route: "/accounting/products",
      percent: 0,
      reason: "همین حالا در همین صفحه می‌توانید شروعش کنید.",
    },
  ]);
});

describe("GET /api/knowledge/recommendations", () => {
  it("requires a member", async () => {
    mocks.requireMember.mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const response = await GET(req("/api/knowledge/recommendations"));
    expect(response.status).toBe(401);
    expect(mocks.recommend).not.toHaveBeenCalled();
  });

  it("rejects an unregistered page instead of treating it as a hint", async () => {
    const response = await GET(req("/api/knowledge/recommendations?page=page:/nope"));
    expect(response.status).toBe(400);
    expect(mocks.recommend).not.toHaveBeenCalled();
  });

  it("passes the current page's route and the caller's permissions to the resolver", async () => {
    const response = await GET(
      req("/api/knowledge/recommendations?page=page%3A%2Faccounting%2Fproducts"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recommendations[0]).toMatchObject({ kind: "tour", id: "accounting.products.list" });
    expect(mocks.recommend).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        userId: "user-1",
        route: "/accounting/products",
        permissions: guard.membership.permissions,
      }),
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
