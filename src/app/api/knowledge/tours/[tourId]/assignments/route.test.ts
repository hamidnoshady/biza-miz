/**
 * Issue #972, item 9 — staff assignments for tours. These tests pin the
 * assignment boundary: only `team.manage` can assign, an unknown/ineligible
 * tour is 404, and the assignment count is returned.
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
  assignTourToStaff: vi.fn(),
  listTourAssignments: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/tours-service", () => ({
  eligibleTourById: mocks.eligibleTourById,
  assignTourToStaff: mocks.assignTourToStaff,
  listTourAssignments: mocks.listTourAssignments,
}));

import { POST as assign, GET as list } from "./route";

const TOUR = "accounting.products.list";

function member(permissions: string[]) {
  return {
    session: { businessId: "biz-1", sub: "user-1" },
    membership: { permissions: new Set(permissions) },
    error: null,
  };
}
const DENIED = { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };

const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(`https://biz.example.test${url}`, init);
const ctx = (tourId: string) => ({ params: Promise.resolve({ tourId }) });

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
  mocks.assignTourToStaff.mockResolvedValue(true);
  mocks.listTourAssignments.mockResolvedValue([
    { userId: "user-2", fullName: "Alice", assignedAt: "2026-01-01T00:00:00.000Z" },
  ]);
});

describe("POST /api/knowledge/tours/[tourId]/assignments", () => {
  it("requires team.manage", async () => {
    mocks.requirePermission.mockResolvedValue(DENIED);
    const res = await assign(
      req(`/api/knowledge/tours/${TOUR}/assignments`, {
        method: "POST",
        body: JSON.stringify({ userId: "user-2" }),
      }),
      ctx(TOUR),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown tour", async () => {
    mocks.eligibleTourById.mockResolvedValue(null);
    const res = await assign(
      req(`/api/knowledge/tours/${TOUR}/assignments`, {
        method: "POST",
        body: JSON.stringify({ userId: "user-2" }),
      }),
      ctx(TOUR),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a missing userId", async () => {
    const res = await assign(
      req(`/api/knowledge/tours/${TOUR}/assignments`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      ctx(TOUR),
    );
    expect(res.status).toBe(400);
  });

  it("assigns the tour and returns created=true", async () => {
    const res = await assign(
      req(`/api/knowledge/tours/${TOUR}/assignments`, {
        method: "POST",
        body: JSON.stringify({ userId: "user-2" }),
      }),
      ctx(TOUR),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ created: true });
    expect(mocks.assignTourToStaff).toHaveBeenCalledWith("biz-1", TOUR, "user-2", "user-1");
  });
});

describe("GET /api/knowledge/tours/[tourId]/assignments", () => {
  it("requires team.manage", async () => {
    mocks.requirePermission.mockResolvedValue(DENIED);
    const res = await list(req(`/api/knowledge/tours/${TOUR}/assignments`), ctx(TOUR));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown tour", async () => {
    mocks.eligibleTourById.mockResolvedValue(null);
    const res = await list(req(`/api/knowledge/tours/${TOUR}/assignments`), ctx(TOUR));
    expect(res.status).toBe(404);
  });

  it("lists assigned staff", async () => {
    const res = await list(req(`/api/knowledge/tours/${TOUR}/assignments`), ctx(TOUR));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toEqual({
      userId: "user-2",
      fullName: "Alice",
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
