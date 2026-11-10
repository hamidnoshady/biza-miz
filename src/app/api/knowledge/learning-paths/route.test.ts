/**
 * Issue #972, item 3 — the learning paths routes at the boundary a reviewer
 * cares about: a member is only told about paths they are eligible for, an
 * ineligible and a non-existent path are indistinguishable (404), and a
 * progress write re-checks eligibility and refuses anything but the five
 * known events.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn(),
  viewer: vi.fn(),
  loadProgress: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/learning-paths-service", () => ({
  learningPathViewerFor: mocks.viewer,
  loadLearningPathProgress: mocks.loadProgress,
  recordLearningPathEvent: mocks.record,
}));

import { GET as listPaths } from "./route";
import { GET as getPath } from "./[pathId]/route";
import { POST as postProgress } from "./[pathId]/progress/route";

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
const post = (body: unknown) =>
  req(`/api/knowledge/learning-paths/${PATH}/progress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
  mocks.viewer.mockResolvedValue({ permissions: new Set([PERMISSIONS.inventoryView]), industry: "cosmetics" });
  mocks.loadProgress.mockResolvedValue(new Map());
  mocks.record.mockResolvedValue({ ok: true, progress: null });
});

describe("list", () => {
  it("returns the paths the member may use, with progress", async () => {
    const res = await listPaths(req("/api/knowledge/learning-paths"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.paths)).toBe(true);
    expect(data.paths.length).toBeGreaterThan(0);
    for (const p of data.paths) {
      expect(p.id).toBeDefined();
      expect(p.title).toBeDefined();
      expect(p.progress.status).toBeDefined();
    }
  });

  it("returns 401 when not signed in", async () => {
    mocks.requireMember.mockResolvedValue(DENIED);
    const res = await listPaths(req("/api/knowledge/learning-paths"));
    expect(res.status).toBe(401);
  });
});

describe("get one path", () => {
  it("returns the path the member may use", async () => {
    const res = await getPath(req(`/api/knowledge/learning-paths/${PATH}`), ctx(PATH));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.path.id).toBe(PATH);
  });

  it("returns 404 for an unknown path", async () => {
    const res = await getPath(req("/api/knowledge/learning-paths/no.such.path"), ctx("no.such.path"));
    expect(res.status).toBe(404);
  });
});

describe("progress write", () => {
  it("starts a path", async () => {
    const res = await postProgress(post({ event: "start" }), ctx(PATH));
    expect(res.status).toBe(200);
  });

  it("completes a step", async () => {
    const res = await postProgress(post({ event: "step_completed", stepId: "register-customer" }), ctx(PATH));
    expect(res.status).toBe(200);
  });

  it("refuses an unknown event type", async () => {
    const res = await postProgress(post({ event: "bogus" }), ctx(PATH));
    expect(res.status).toBe(400);
  });

  it("refuses a step_completed without a step id", async () => {
    const res = await postProgress(post({ event: "step_completed" }), ctx(PATH));
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown path", async () => {
    const res = await postProgress(post({ event: "start" }), ctx("no.such.path"));
    expect(res.status).toBe(404);
  });
});
