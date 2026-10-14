/**
 * Issue #808 — "skipping a step" is a narrowed write, and this is the endpoint
 * that performs it.
 *
 * The wizard's optional steps (users / hardware / backup / opening) may be
 * marked done without any domain data behind them: an owner who sells from
 * zero stock and pairs no printer is not doing anything wrong. Required steps
 * may **not** — `business`, `accounts`, `costing`, `tax` and `menu` are only
 * ever marked by the endpoint that actually writes their data, which is what
 * keeps a marker from ever getting ahead of reality.
 *
 * That rule is load-bearing for the whole issue: readiness and reconciliation
 * would ignore a forged `menu` marker on the next read, but the write itself
 * must be refused, not merely corrected later — a client that can mark any
 * step through this route can make the wizard's own sidebar claim a step is
 * done, which is exactly the class of confusion #808 is about.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as settings from "@/lib/settings";
import { OPTIONAL_STEPS, requiredStepsForIndustry } from "@/lib/wizard-steps";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return { ...actual, markStepDone: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1" };

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(settings.markStepDone).mockResolvedValue({
    steps: {},
    completedAt: null,
  } as never);
});

describe("POST /api/setup/progress — skipping a step", () => {
  it.each([...OPTIONAL_STEPS])("marks the optional step %s", async (step) => {
    const response = await POST(request({ step }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(settings.markStepDone).toHaveBeenCalledWith(SESSION.businessId, step);
  });

  it("refuses to mark a required step, whatever its data says", async () => {
    // Every required step of every industry shape — a forged marker here is
    // what would let the wizard claim work the business has not done.
    const required = new Set([
      ...requiredStepsForIndustry("food_service"),
      ...requiredStepsForIndustry("jewelry"),
    ]);
    expect(required.size).toBeGreaterThan(0);

    for (const step of required) {
      const response = await POST(request({ step }));
      expect(response.status, step).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_step" });
    }
    expect(settings.markStepDone).not.toHaveBeenCalled();
  });

  it("refuses an unknown, missing or non-string step", async () => {
    for (const body of [{ step: "not_a_step" }, {}, { step: 42 }, { step: null }]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_step" });
    }
    expect(settings.markStepDone).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON at all", async () => {
    const broken = { json: async () => { throw new Error("bad json"); } } as unknown as NextRequest;
    const response = await POST(broken);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(settings.markStepDone).not.toHaveBeenCalled();
  });
});
