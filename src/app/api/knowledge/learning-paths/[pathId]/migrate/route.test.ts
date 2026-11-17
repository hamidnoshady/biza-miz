/**
 * Issue #972, item 8 — version migrations. The migrate route bumps every
 * member's stored progress for a learning path to the path's current revision.
 * Only the database read/write boundary is mocked here; the pure migration
 * rules are covered by the unit suite in learning-paths.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn(),
  learningPathById: vi.fn(),
  learningPathViewerFor: vi.fn(),
  pathsForViewer: vi.fn(),
  migrateLearningPathProgress: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/learning-paths-service", () => ({
  learningPathViewerFor: mocks.learningPathViewerFor,
  migrateLearningPathProgressForPath: mocks.migrateLearningPathProgress,
}));

vi.mock("@/lib/learning-paths", () => ({
  learningPathById: mocks.learningPathById,
  pathsForViewer: mocks.pathsForViewer,
}));

import { POST } from "./route";

const PATH = "cafe.first-day";

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
const ctx = (pathId: string) => ({ params: Promise.resolve({ pathId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
  mocks.learningPathById.mockReturnValue({
    id: PATH,
    version: 2,
    pageKey: "page:/cafe/first-day",
    route: "/cafe/first-day",
    title: "First day",
    description: "Learn the basics.",
    eligibility: {},
    steps: [],
  });
  mocks.learningPathViewerFor.mockResolvedValue({ permissions: new Set([PERMISSIONS.inventoryView]), industry: "food_service" });
  mocks.pathsForViewer.mockReturnValue([{ id: PATH, version: 2 }]);
  mocks.migrateLearningPathProgress.mockResolvedValue({ changed: 2, migrated: 4 });
});

describe("POST /api/knowledge/learning-paths/[pathId]/migrate", () => {
  it("requires a signed-in member", async () => {
    mocks.requireMember.mockResolvedValue(DENIED);
    const res = await POST(req(`/api/knowledge/learning-paths/${PATH}/migrate`, { method: "POST" }), ctx(PATH));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown path", async () => {
    mocks.learningPathById.mockReturnValue(null);
    const res = await POST(req(`/api/knowledge/learning-paths/${PATH}/migrate`, { method: "POST" }), ctx(PATH));
    expect(res.status).toBe(404);
  });

  it("migrates progress and returns changed and migrated counts", async () => {
    const res = await POST(req(`/api/knowledge/learning-paths/${PATH}/migrate`, { method: "POST" }), ctx(PATH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ changed: 2, migrated: 4 });
    expect(mocks.migrateLearningPathProgress).toHaveBeenCalledWith("biz-1", PATH, expect.objectContaining({ id: PATH, version: 2 }));
  });
});
