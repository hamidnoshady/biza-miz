/**
 * Issue #972, item 9 — unassigning a tour from a staff member.
 *
 * Only the service boundary is mocked; the route and permission checks run
 * for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  eligibleTourById: vi.fn(),
  unassignTourFromStaff: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/tours-service", () => ({
  eligibleTourById: mocks.eligibleTourById,
  unassignTourFromStaff: mocks.unassignTourFromStaff,
}));

import { DELETE } from "./route";

const TOUR = "accounting.products.list";
const USER = "user-2";

function member(permissions: string[]) {
  return {
    session: { businessId: "biz-1", sub: "user-1" },
    membership: { permissions: new Set(permissions) },
    error: null,
  };
}
const DENIED = { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };

const req = (url: string) => new NextRequest(`https://biz.example.test${url}`, { method: "DELETE" });
const ctx = (tourId: string, userId: string) => ({ params: Promise.resolve({ tourId, userId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue(member([PERMISSIONS.teamManage]));
  mocks.eligibleTourById.mockResolvedValue({
    id: TOUR,
    version: 1,
    pageKey: "page:/accounting/products",
    route: "/accounting/products",
    title: "Product list",
    description: "Browse products.",
    eligibility: {},
    steps: [],
  });
  mocks.unassignTourFromStaff.mockResolvedValue(true);
});

describe("DELETE /api/knowledge/tours/[tourId]/assignments/[userId]", () => {
  it("requires team.manage", async () => {
    mocks.requirePermission.mockResolvedValue(DENIED);
    const res = await DELETE(req(`/api/knowledge/tours/${TOUR}/assignments/${USER}`), ctx(TOUR, USER));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown tour", async () => {
    mocks.eligibleTourById.mockResolvedValue(null);
    const res = await DELETE(req(`/api/knowledge/tours/${TOUR}/assignments/${USER}`), ctx(TOUR, USER));
    expect(res.status).toBe(404);
  });

  it("unassigns the tour and returns removed=true", async () => {
    const res = await DELETE(req(`/api/knowledge/tours/${TOUR}/assignments/${USER}`), ctx(TOUR, USER));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ removed: true });
    expect(mocks.unassignTourFromStaff).toHaveBeenCalledWith("biz-1", TOUR, USER);
  });

  it("returns removed=false when no assignment existed", async () => {
    mocks.unassignTourFromStaff.mockResolvedValue(false);
    const res = await DELETE(req(`/api/knowledge/tours/${TOUR}/assignments/${USER}`), ctx(TOUR, USER));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ removed: false });
  });
});
