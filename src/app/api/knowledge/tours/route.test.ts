/**
 * Issue #972 — the tour routes at the boundary a reviewer cares about: a
 * member is only told about tours they are eligible for, an ineligible and a
 * non-existent tour are indistinguishable, a progress write re-checks
 * eligibility and refuses anything but the five known events, and the
 * client can never name a step it was not given.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn(),
  industry: vi.fn(),
  loadProgress: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: mocks.industry }));

// Real eligibility and tour logic; only the database reads/writes are replaced.
vi.mock("@/lib/tours-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tours-service")>();
  return { ...actual, loadTourProgress: mocks.loadProgress, recordTourEvent: mocks.record };
});

import { GET as listTours } from "./route";
import { GET as getTour } from "./[tourId]/route";
import { POST as postProgress } from "./[tourId]/progress/route";

const PAGE = "page:/accounting/products";
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
});

describe("GET /api/knowledge/tours/[tourId]", () => {
  it("returns the steps and the resume point to an eligible member", async () => {
    const res = await getTour(req(`/api/knowledge/tours/${TOUR}`), ctx(TOUR));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tour.steps.length).toBe(5);
    expect(body.progress.status).toBe("not_started");
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
