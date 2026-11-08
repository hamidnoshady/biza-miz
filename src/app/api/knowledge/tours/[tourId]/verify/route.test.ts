/**
 * Issue #972 phase 2 — the verified-action boundary.
 *
 * The promise the epic makes is narrow and testable: a step that asks the
 * member to do something real completes on the server's evidence, never on a
 * click. These tests pin that from the outside — the client can only send a
 * step id, an unevidenced step is a 409 (not a success and not a 500), a step
 * that asks for nothing real cannot be verified at all, and an ineligible or
 * unknown tour stays indistinguishable from a missing one.
 *
 * Only the database is replaced (`@/lib/db`) and the evidence lookup is stubbed
 * at its own boundary; the route, the real service and the real progress rules
 * all execute, so what is asserted is the behaviour a member gets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn(),
  evidence: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));
vi.mock("@/lib/db", () => ({
  query: mocks.query,
  withTenantTransaction: async (_businessId: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: async () => "café" }));
vi.mock("@/lib/features", () => ({ effectiveFeatures: async () => ({}) }));
vi.mock("@/lib/tour-studio-service", () => ({ publishedTourById: async () => null }));
vi.mock("@/lib/tour-evidence-service", () => ({ hasTourEvidence: mocks.evidence }));

import { POST as verify } from "./route";

const TASK_TOUR = "crm.directory.first-customer";
const STEP = "register";

const event = (body: unknown) =>
  new NextRequest(`https://biz.example.test/api/knowledge/tours/${TASK_TOUR}/verify`, {
    method: "POST",
    body: JSON.stringify(body),
  });
const ctx = (tourId = TASK_TOUR) => ({ params: Promise.resolve({ tourId }) });

function member(permissions: string[] = [PERMISSIONS.partiesManage]) {
  return {
    session: { businessId: "biz-1", sub: "user-1" },
    membership: { permissions: new Set(permissions) },
    error: null,
  };
}

/** A stored progress row, as `loadTourProgress` and the row lock read it. */
const storedRow = {
  tour_id: TASK_TOUR,
  tour_version: 1,
  seen_step_ids: ["how-it-works", "what-is-a-party"],
  current_step_id: STEP,
  started_at: new Date("2026-11-01T00:00:00.000Z"),
  last_active_at: new Date("2026-11-01T00:05:00.000Z"),
  completed_at: null,
};

/** The SQL the service actually issues, answered without a database. */
function answerQueries({ existing = true }: { existing?: boolean } = {}) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (/FROM tour_member_progress/.test(sql)) return { rows: existing ? [storedRow] : [] };
    return { rows: [] };
  });
}

function writes(): string[] {
  return mocks.query.mock.calls
    .map(([sql]) => String(sql).replace(/\s+/g, " ").trim())
    .filter((sql) => !sql.startsWith("SELECT"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMember.mockResolvedValue(member());
  mocks.evidence.mockResolvedValue(null);
  answerQueries();
});

describe("verified action steps", () => {
  it("answers 409 while the member has not done the work, and writes nothing", async () => {
    const response = await verify(event({ stepId: STEP }), ctx());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "evidence_missing" });
    expect(writes()).toEqual([]);
  });

  it("marks the step seen only after the server finds evidence", async () => {
    mocks.evidence.mockResolvedValue({
      verifier: "party.created",
      lastAt: "2026-11-01T00:04:00.000Z",
      count: 1,
    });
    const response = await verify(event({ stepId: STEP }), ctx());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ verified: true, evidenceBeforeTour: false });
    // Every step is now seen — but, exactly like an explained step, "seen" is
    // not "completed": the overlay still sends `complete`, and only that stamps
    // `completedAt`. Until then the bar stays capped at 99 on purpose, so a
    // member is never told they finished something the server has not closed.
    expect(body.progress).toMatchObject({
      status: "in_progress",
      seenCount: 3,
      totalSteps: 3,
      percent: 99,
    });
    expect(mocks.evidence).toHaveBeenCalledWith("biz-1", "user-1", "party.created");
  });

  it("is never a plain `step_seen` — the row is written with the verified event only", async () => {
    mocks.evidence.mockResolvedValue({
      verifier: "party.created",
      lastAt: "2026-11-01T00:04:00.000Z",
      count: 1,
    });
    await verify(event({ stepId: STEP }), ctx());
    const update = writes().find((sql) => sql.startsWith("UPDATE tour_member_progress"));
    expect(update).toBeTruthy();
    // The seen array now holds the action step, and the row stays scoped to the caller.
    const params = mocks.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE tour_member_progress"))![1];
    expect(params[4]).toEqual(expect.arrayContaining([STEP]));
    expect(params.slice(0, 3)).toEqual(["biz-1", "user-1", TASK_TOUR]);
  });

  it("says so when the evidence predates this tour run", async () => {
    mocks.evidence.mockResolvedValue({
      verifier: "party.created",
      lastAt: "2026-01-01T00:00:00.000Z",
      count: 4,
    });
    const body = await (await verify(event({ stepId: STEP }), ctx())).json();
    expect(body).toMatchObject({ verified: true, evidenceBeforeTour: true });
  });

  it("does not require the member to repeat work when the tour just started", async () => {
    answerQueries({ existing: false });
    mocks.evidence.mockResolvedValue({
      verifier: "party.created",
      lastAt: "2026-01-01T00:00:00.000Z",
      count: 9,
    });
    const body = await (await verify(event({ stepId: STEP }), ctx())).json();
    expect(body.evidenceBeforeTour).toBe(true);
    expect(body.progress.status).toBe("in_progress");
  });

  it("refuses a step that asks for nothing real", async () => {
    const response = await verify(event({ stepId: "how-it-works" }), ctx());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "not_verifiable" });
    expect(mocks.evidence).not.toHaveBeenCalled();
  });

  it("refuses an unknown step of the revision, and a body that names none", async () => {
    expect((await verify(event({ stepId: "nope" }), ctx())).status).toBe(400);
    expect(await (await verify(event({}), ctx())).json()).toEqual({ error: "bad_request" });
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("hides a tour the member is not eligible for, exactly like a missing one", async () => {
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.partiesView]));
    const response = await verify(event({ stepId: STEP }), ctx());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("requires a session", async () => {
    mocks.requireMember.mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    expect((await verify(event({ stepId: STEP }), ctx())).status).toBe(401);
  });
});
