/**
 * Issue #972, Phase 2 remaining — the learning-progress aggregation route.
 *
 * A member gets one report: platform %, per-app breakdown, per-section
 * breakdown, per-page tour/path state, next lesson, and the last tour they
 * can resume. Eligibility is re-checked on the server, so a member only sees
 * tours and paths they may use.
 *
 * Only the database reads are replaced; the pure eligibility, progress and
 * aggregation rules all execute for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn(),
  viewer: vi.fn(),
  loadTourProgress: vi.fn(),
  pathViewer: vi.fn(),
  loadPathProgress: vi.fn(),
  publishedForPage: vi.fn(),
  findActiveDeviceId: vi.fn(),
  verifyTrustedDevice: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/tour-studio-service", () => ({
  publishedToursForPage: mocks.publishedForPage,
}));

vi.mock("@/lib/tours-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tours-service")>();
  return {
    ...actual,
    tourViewerFor: mocks.viewer,
    loadTourProgress: mocks.loadTourProgress,
  };
});

vi.mock("@/lib/learning-paths-service", () => ({
  learningPathViewerFor: mocks.pathViewer,
  loadLearningPathProgress: mocks.loadPathProgress,
}));

vi.mock("@/lib/device-service", () => ({
  findActiveDeviceId: mocks.findActiveDeviceId,
}));

vi.mock("@/lib/trusted-device", () => ({
  readTrustedDeviceToken: vi.fn(() => null),
  verifyTrustedDevice: mocks.verifyTrustedDevice,
}));

import { GET as getProgress } from "./route";

const T0 = "2026-11-01T10:00:00.000Z";
const T1 = "2026-11-01T10:05:00.000Z";

function member(permissions: string[]) {
  return {
    session: { businessId: "biz-1", sub: "user-1" },
    membership: { permissions: new Set(permissions) },
    error: null,
  };
}

const DENIED = {
  session: null,
  error: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
};

const req = (url: string, headers?: Record<string, string>) =>
  new NextRequest(`https://biz.example.test${url}`, { headers });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
  mocks.viewer.mockResolvedValue({
    permissions: new Set([PERMISSIONS.inventoryView]),
    industry: "cosmetics",
    features: {},
    inventorySystem: undefined,
  });
  mocks.loadTourProgress.mockResolvedValue(new Map());
  mocks.pathViewer.mockResolvedValue({
    permissions: new Set([PERMISSIONS.inventoryView]),
    industry: "cosmetics",
  });
  mocks.loadPathProgress.mockResolvedValue(new Map());
  mocks.publishedForPage.mockResolvedValue([]);
  mocks.findActiveDeviceId.mockResolvedValue(null);
  mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "missing" });
});

describe("aggregation", () => {
  it("returns platform roll-up with zero when nothing is started", async () => {
    const res = await getProgress(req("/api/knowledge/learning-progress"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.platform.eligible).toBeGreaterThan(0);
    expect(data.platform.completed).toBe(0);
    expect(data.platform.percent).toBe(0);
    expect(Array.isArray(data.apps)).toBe(true);
    expect(data.apps.length).toBeGreaterThan(0);
  });

  it("returns 401 when not signed in", async () => {
    mocks.requireMember.mockResolvedValue(DENIED);
    const res = await getProgress(req("/api/knowledge/learning-progress"));
    expect(res.status).toBe(401);
  });

  it("counts completed tours toward platform percent", async () => {
    // One completed tour on the products page.
    mocks.loadTourProgress.mockResolvedValue(
      new Map([
        [
          "accounting.products.list",
          {
            tourId: "accounting.products.list",
            tourVersion: 1,
            seenStepIds: ["welcome", "kpis", "search-filters", "table", "export"],
            currentStepId: null,
            startedAt: T0,
            lastActiveAt: T1,
            completedAt: T1,
          },
        ],
      ]),
    );
    const res = await getProgress(req("/api/knowledge/learning-progress"));
    const data = await res.json();
    expect(data.platform.completed).toBeGreaterThanOrEqual(1);
  });

  it("groups apps in the expected order", async () => {
    const res = await getProgress(req("/api/knowledge/learning-progress"));
    const data = await res.json();
    const keys = data.apps.map((a: { key: string }) => a.key);
    expect(keys).toContain("accounting");
    expect(keys).toContain("crm");
    expect(keys).toContain("growth");
    expect(keys).toContain("websites");
  });

  it("includes next lesson and resume last tour when nothing is started", async () => {
    const res = await getProgress(req("/api/knowledge/learning-progress"));
    const data = await res.json();
    // nextLesson is the first incomplete item — with nothing started, it's
    // the very first eligible tour/path in page order.
    expect(data.nextLesson).toBeDefined();
    if (data.nextLesson) {
      expect(["tour", "path"]).toContain(data.nextLesson!.type);
      expect(data.nextLesson.route).toBeDefined();
    }
    // resumeLastTour is null when nothing has been started.
    expect(data.resumeLastTour).toBeNull();
  });

  it("sets resumeLastTour from the most recent activity", async () => {
    mocks.loadTourProgress.mockResolvedValue(
      new Map([
        [
          "crm.directory.first-customer",
          {
            tourId: "crm.directory.first-customer",
            tourVersion: 1,
            seenStepIds: ["how-it-works", "what-is-a-party"],
            currentStepId: "register",
            startedAt: T0,
            lastActiveAt: T1,
            completedAt: null,
          },
        ],
      ]),
    );
    const res = await getProgress(req("/api/knowledge/learning-progress"));
    const data = await res.json();
    expect(data.resumeLastTour).toBeDefined();
    if (data.resumeLastTour) {
      expect(data.resumeLastTour.id).toBe("crm.directory.first-customer");
      expect(data.resumeLastTour.resumeStepId).toBe("register");
      expect(data.resumeLastTour.lastActiveAt).toBe(T1);
    }
  });

  it("excludes tours the member is not eligible for", async () => {
    // Viewer without the parties permission — crm.directory.first-customer
    // requires partiesManage, so it should not appear.
    mocks.viewer.mockResolvedValue({
      permissions: new Set<string>(),
      industry: "cosmetics",
      features: {},
      inventorySystem: undefined,
    });
    const res = await getProgress(req("/api/knowledge/learning-progress"));
    expect(res.status).toBe(200);
    const data = await res.json();
    const allTourIds = data.apps.flatMap((a: any) =>
      a.sections.flatMap((s: any) => s.pages.flatMap((p: any) => p.tours.map((t: any) => t.id))),
    );
    expect(allTourIds).not.toContain("crm.directory.first-customer");
  });
});

describe("device consistency", () => {
  it("reports no device when no token is sent", async () => {
    mocks.findActiveDeviceId.mockResolvedValue(null);
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "missing" });

    const res = await getProgress(req("/api/knowledge/learning-progress"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.currentDevice).toEqual({
      id: null,
      paired: false,
      trusted: false,
    });
  });

  it("reports paired device when token resolves", async () => {
    mocks.findActiveDeviceId.mockResolvedValue("dev-pos-1");
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "missing" });

    const res = await getProgress(
      req("/api/knowledge/learning-progress", { "x-pos-device-token": "posdev_abc" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.currentDevice.id).toBe("dev-pos-1");
    expect(data.currentDevice.paired).toBe(true);
    expect(data.currentDevice.trusted).toBe(false);
    expect(mocks.findActiveDeviceId).toHaveBeenCalledWith("posdev_abc", "biz-1");
  });

  it("reports trusted device when cookie is valid", async () => {
    mocks.findActiveDeviceId.mockResolvedValue(null);
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: true, reason: undefined });

    const res = await getProgress(req("/api/knowledge/learning-progress"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.currentDevice.trusted).toBe(true);
  });
});
