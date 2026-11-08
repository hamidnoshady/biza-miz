/**
 * Issue #972 — the tour routes at the boundary a reviewer cares about: a
 * member is only told about tours they are eligible for, an ineligible and a
 * non-existent tour are indistinguishable, a progress write re-checks
 * eligibility and refuses anything but the five known events, and the
 * client can never name a step it was not given.
 *
 * The automatic baseline tours are exercised here too: a registered page with
 * no authored tour answers with its baseline tour through the same two routes,
 * and a baseline id for a page the authored catalogue owns is unknown.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn(),
  industry: vi.fn(),
  loadProgress: vi.fn(),
  record: vi.fn(),
  publishedForPage: vi.fn(),
  publishedById: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: mocks.industry }));

// The super-admin catalogue (migration 0288) is a database read; the routes are
// exercised here with it replaced, so the HTTP contract is tested without a
// database and the pure merge/validation rules are covered by the unit suite.
vi.mock("@/lib/tour-studio-service", () => ({
  publishedToursForPage: mocks.publishedForPage,
  publishedTourById: mocks.publishedById,
}));

// Real eligibility and tour logic; only the database reads/writes are replaced.
vi.mock("@/lib/tours-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tours-service")>();
  return { ...actual, loadTourProgress: mocks.loadProgress, recordTourEvent: mocks.record };
});

import { baselineTourIdForRoute } from "@/lib/tour-baseline";
import { GET as listTours } from "./route";
import { GET as getTour } from "./[tourId]/route";
import { POST as postProgress } from "./[tourId]/progress/route";

const PAGE = "page:/accounting/products";
const TOUR = "accounting.products.list";
// A registered page nobody has authored a tour for.
const BASELINE_PAGE = "page:/crm/audit";
const BASELINE_TOUR = baselineTourIdForRoute("/crm/audit");

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
const post = (body: unknown) =>
  req(`/api/knowledge/tours/${TOUR}/progress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
  mocks.industry.mockResolvedValue("cosmetics");
  mocks.loadProgress.mockResolvedValue(new Map());
  mocks.record.mockResolvedValue({ ok: true, progress: null });
  mocks.publishedForPage.mockResolvedValue([]);
  mocks.publishedById.mockResolvedValue(null);
});

describe("GET /api/knowledge/tours", () => {
  it("requires a signed-in member", async () => {
    mocks.requireMember.mockResolvedValue(DENIED);
    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(PAGE)}`));
    expect(res.status).toBe(401);
  });

  it("rejects a page the server does not know", async () => {
    const res = await listTours(req("/api/knowledge/tours?page=page:/nope"));
    expect(res.status).toBe(400);
  });

  it("lists the eligible tour with counts and progress, but no step copy or anchors", async () => {
    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(PAGE)}`));
    const body = await res.json();
    expect(body.tours).toHaveLength(1);
    expect(body.tours[0]).toMatchObject({ id: TOUR, stepCount: 5, progress: { status: "not_started" } });
    expect(JSON.stringify(body)).not.toContain("tour-id");
    expect(body.tours[0].steps).toBeUndefined();
  });

  it("says nothing about a tour the member's permissions or trade rule out", async () => {
    mocks.requireMember.mockResolvedValue(member([]));
    expect((await (await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(PAGE)}`))).json()).tours).toEqual([]);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
    mocks.industry.mockResolvedValue("food_service");
    expect((await (await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(PAGE)}`))).json()).tours).toEqual([]);
  });

  it("offers the automatic baseline tour on a page with no authored tour", async () => {
    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(BASELINE_PAGE)}`));
    const body = await res.json();
    expect(body.tours).toHaveLength(1);
    expect(body.tours[0]).toMatchObject({
      id: BASELINE_TOUR,
      route: "/crm/audit",
      stepCount: 4,
      progress: { status: "not_started" },
    });
    expect(JSON.stringify(body)).not.toContain("tour-id");
    expect(body.tours[0].steps).toBeUndefined();
  });
});

describe("published Studio tours", () => {
  const STUDIO_ID = "studio.crm.audit";
  const studio = {
    id: STUDIO_ID,
    version: 4,
    pageKey: BASELINE_PAGE,
    route: "/crm/audit",
    title: "سابقهٔ تصمیم‌ها",
    description: "تور منتشرشده از استودیو",
    eligibility: {},
    steps: [
      { id: "intro", kind: "explain" as const, title: "شروع", body: "." },
      { id: "header", kind: "spotlight" as const, anchor: "page.header", title: "سرصفحه", body: "." },
    ],
  };

  it("offers the published tour instead of the automatic baseline", async () => {
    mocks.publishedForPage.mockResolvedValue([studio]);
    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(BASELINE_PAGE)}`));
    const body = await res.json();
    expect(body.tours).toHaveLength(1);
    expect(body.tours[0]).toMatchObject({ id: STUDIO_ID, title: "سابقهٔ تصمیم‌ها", stepCount: 2 });
    expect(mocks.publishedForPage).toHaveBeenCalledWith(BASELINE_PAGE);
  });

  it("plays a published tour back and records its progress", async () => {
    mocks.publishedById.mockResolvedValue(studio);
    const res = await getTour(req(`/api/knowledge/tours/${STUDIO_ID}`), ctx(STUDIO_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tour.id).toBe(STUDIO_ID);
    expect(body.tour.steps).toHaveLength(2);

    const write = await postProgress(
      req(`/api/knowledge/tours/${STUDIO_ID}/progress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "start" }),
      }),
      ctx(STUDIO_ID),
    );
    expect(write.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith("biz-1", "user-1", expect.objectContaining({ id: STUDIO_ID }), {
      type: "start",
    });
  });

  it("still answers when the console catalogue cannot be read", async () => {
    // The button must not break because the database is unavailable: the code
    // catalogue and the baseline are the fallback.
    mocks.publishedForPage.mockRejectedValue(new Error("database down"));
    mocks.publishedById.mockRejectedValue(new Error("database down"));
    const list = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(PAGE)}`));
    expect((await list.json()).tours).toHaveLength(1);
    const play = await getTour(req(`/api/knowledge/tours/${TOUR}`), ctx(TOUR));
    expect(play.status).toBe(200);
  });

  it("never serves a draft: an unpublished id is indistinguishable from an unknown one", async () => {
    mocks.publishedById.mockResolvedValue(null);
    const res = await getTour(req(`/api/knowledge/tours/${STUDIO_ID}`), ctx(STUDIO_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("GET /api/knowledge/tours/[tourId]", () => {
  it("returns the steps and the resume point to an eligible member", async () => {
    const res = await getTour(req(`/api/knowledge/tours/${TOUR}`), ctx(TOUR));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tour.steps.length).toBe(5);
    expect(body.progress.status).toBe("not_started");
  });

  it("plays back a baseline tour, and refuses one for a page the authored catalogue owns", async () => {
    const res = await getTour(req(`/api/knowledge/tours/${BASELINE_TOUR}`), ctx(BASELINE_TOUR));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tour.id).toBe(BASELINE_TOUR);
    expect(body.tour.steps.length).toBe(4);
    expect(body.progress.status).toBe("not_started");

    const shadowed = baselineTourIdForRoute("/accounting/products");
    const refused = await getTour(req(`/api/knowledge/tours/${shadowed}`), ctx(shadowed));
    expect(refused.status).toBe(404);
  });

  it("answers an ineligible and an unknown tour identically", async () => {
    mocks.requireMember.mockResolvedValue(member([]));
    const ineligible = await getTour(req(`/api/knowledge/tours/${TOUR}`), ctx(TOUR));
    const unknown = await getTour(req("/api/knowledge/tours/nope"), ctx("nope"));
    expect(ineligible.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await ineligible.json()).toEqual(await unknown.json());
  });
});

describe("POST /api/knowledge/tours/[tourId]/progress", () => {
  it("records a known event for the caller's own row", async () => {
    const res = await postProgress(post({ event: "step_seen", stepId: "welcome" }), ctx(TOUR));
    expect(res.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith("biz-1", "user-1", expect.objectContaining({ id: TOUR }), {
      type: "step_seen",
      stepId: "welcome",
    });
  });

  it("re-checks eligibility on every write", async () => {
    mocks.requireMember.mockResolvedValue(member([]));
    const res = await postProgress(post({ event: "start" }), ctx(TOUR));
    expect(res.status).toBe(404);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses any event it does not know, and any claim of business success", async () => {
    for (const body of [{ event: "verified" }, { event: "action_succeeded", stepId: "table" }, {}, "not json", { event: 7 }]) {
      const res = await postProgress(post(body), ctx(TOUR));
      expect(res.status).toBe(400);
    }
    expect((await postProgress(post({ event: "step_seen" }), ctx(TOUR))).status).toBe(400);
    expect((await postProgress(post({ event: "pause", stepId: "x".repeat(65) }), ctx(TOUR))).status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("passes only the typed event on, never extra client fields", async () => {
    await postProgress(post({ event: "start", completed: true, stepId: "table" }), ctx(TOUR));
    expect(mocks.record.mock.calls[0][3]).toEqual({ type: "start" });
  });

  it("maps a service refusal to a status the client can act on", async () => {
    mocks.record.mockResolvedValueOnce({ ok: false, error: "unknown_step" });
    expect((await postProgress(post({ event: "step_seen", stepId: "zzz" }), ctx(TOUR))).status).toBe(400);
    mocks.record.mockResolvedValueOnce({ ok: false, error: "steps_unseen" });
    expect((await postProgress(post({ event: "complete" }), ctx(TOUR))).status).toBe(409);
  });
});
