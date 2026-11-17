/**
 * Issue #972, item 8 — version migrations. The migrate route bumps every
 * member's stored progress for a tour to the tour's current revision.
 * Only the database read/write boundary is mocked here; the pure migration
 * rules are covered by the unit suite in tours.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn(),
  eligibleTourById: vi.fn(),
  migrateTourProgress: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/tours-service", () => ({
  eligibleTourById: mocks.eligibleTourById,
  migrateTourProgressForTour: mocks.migrateTourProgress,
}));

import { POST } from "./route";

const TOUR = "accounting.products.list";

function member(permissions: string[]) {
  return {
    session: { businessId: "biz-1", sub: "user-1" },
    membership: { permissions: new Set(permissions) },
    error: null,
  };
}
const DENIED = { session: null, error: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }) };

const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(`https://biz.example.test${url}`, init);
const ctx = (tourId: string) => ({ params: Promise.resolve({ tourId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
  mocks.eligibleTourById.mockResolvedValue({
    id: TOUR,
    version: 2,
    pageKey: "page:/accounting/products",
    route: "/accounting/products",
    title: "Product list",
    description: "Browse products.",
    eligibility: {},
    steps: [
      { id: "a", kind: "explain", title: "A", body: "." },
      { id: "b", kind: "explain", title: "B", body: "." },
    ],
  });
  mocks.migrateTourProgress.mockResolvedValue({ changed: 3, migrated: 5 });
});

describe("POST /api/knowledge/tours/[tourId]/migrate", () => {
  it("requires a signed-in member", async () => {
    mocks.requireMember.mockResolvedValue(DENIED);
    const res = await POST(req(`/api/knowledge/tours/${TOUR}/migrate`, { method: "POST" }), ctx(TOUR));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown or ineligible tour", async () => {
    mocks.eligibleTourById.mockResolvedValue(null);
    const res = await POST(req(`/api/knowledge/tours/${TOUR}/migrate`, { method: "POST" }), ctx(TOUR));
    expect(res.status).toBe(404);
  });

  it("migrates progress and returns changed and migrated counts", async () => {
    const res = await POST(req(`/api/knowledge/tours/${TOUR}/migrate`, { method: "POST" }), ctx(TOUR));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ changed: 3, migrated: 5 });
    expect(mocks.eligibleTourById).toHaveBeenCalledWith(TOUR, "biz-1", expect.any(Set));
    expect(mocks.migrateTourProgress).toHaveBeenCalledWith("biz-1", TOUR, expect.objectContaining({ id: TOUR, version: 2 }));
  });
});
