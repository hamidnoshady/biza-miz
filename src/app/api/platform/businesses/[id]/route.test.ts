/**
 * The business workspace's write API — the three regressions issue #755 names.
 *
 *   1. Lifecycle authorization used to depend on the *target* status, so an
 *      engineer (who cannot archive) could reactivate an archived business
 *      through `business.suspend`. Authorization is now per transition, and
 *      these tests drive the real route handler for every role × transition.
 *   2. `PATCH { plan }` was a second plan-change write path guarded by
 *      `features.write`; it is gone and every caller gets a pointer instead.
 *   3. Hard-delete audit used to be written before the delete ran, so a failed
 *      delete still read as a successful one in the audit trail.
 *
 * The capability table is the real one (`CAPABILITIES_FOR`), not a hand-written
 * stand-in — a role whose capabilities change must change these expectations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CAPABILITIES_FOR, type PlatformAdminRole } from "@/lib/platform-admin";
import type { BusinessSummary } from "@/lib/platform-service";

const state = vi.hoisted(() => ({
  role: "owner" as PlatformAdminRole,
  status: "active" as "active" | "suspended" | "archived",
  audit: [] as { action: string; businessId?: string | null; payload?: Record<string, unknown> | null }[],
}));

vi.mock("@/lib/platform-auth", async () => {
  const { CAPABILITIES_FOR: caps } = await vi.importActual<typeof import("@/lib/platform-admin")>(
    "@/lib/platform-admin",
  );
  const session = { session: { padmin: "admin-1", role: "owner" }, error: null };
  return {
    requirePlatformAdmin: vi.fn(async () => session),
    requirePlatformCapability: vi.fn(async (cap: string) =>
      (caps(state.role) as string[]).includes(cap)
        ? session
        : { session: null, error: Response.json({ error: "forbidden", capability: cap }, { status: 403 }) },
    ),
    withPlatformScope: (fn: (req: NextRequest, ctx: unknown) => Promise<Response>) => fn,
    platformAudit: vi.fn(async (entry: { action: string; businessId?: string | null; payload?: Record<string, unknown> | null }) => {
      state.audit.push(entry);
    }),
  };
});

function summary(status: string): BusinessSummary {
  return {
    id: "biz-1",
    name: "کافه الفبا",
    slug: "alpha",
    subdomain: "alpha",
    status: status as BusinessSummary["status"],
    plan: "pro",
    timezone: "Asia/Tehran",
    industry: "food_service",
    createdAt: "2026-01-01T00:00:00.000Z",
    suspendedAt: null,
    archivedAt: status === "archived" ? "2026-02-01T00:00:00.000Z" : null,
    locationCount: 1,
    memberCount: 2,
    orderCount: 3,
    lastActivityAt: null,
  };
}

const setBusinessStatus = vi.hoisted(() => vi.fn());
const hardDeleteBusiness = vi.hoisted(() => vi.fn());

vi.mock("@/lib/platform-service", () => ({
  getBusiness: vi.fn(async () => summary(state.status)),
  setBusinessStatus,
  hardDeleteBusiness,
  updateBusiness: vi.fn(async () => summary(state.status)),
  renameBusinessSubdomain: vi.fn(async () => ({ ok: false, error: "not_found" })),
  changeBusinessIndustry: vi.fn(async () => null),
  industryDataCounts: vi.fn(async () => null),
  resetBusiness: vi.fn(async () => {}),
  BusinessNotFoundError: class BusinessNotFoundError extends Error {},
  ResetBusinessNotPossibleError: class ResetBusinessNotPossibleError extends Error {},
}));

vi.mock("@/lib/host", () => ({ rootDomain: () => "example.test" }));
vi.mock("@/lib/host-resolution", () => ({ listSubdomainAliases: vi.fn(async () => []) }));

const { PATCH, DELETE } = await import("./route");

const ctx = { params: Promise.resolve({ id: "biz-1" }) };

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new NextRequest("http://localhost:3000/api/platform/businesses/biz-1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    ctx,
  ) as Promise<Response>;
}

beforeEach(() => {
  state.role = "owner";
  state.status = "active";
  state.audit = [];
  setBusinessStatus.mockReset();
  setBusinessStatus.mockImplementation(async (_id: string, next: string) => summary(next));
  hardDeleteBusiness.mockReset();
  hardDeleteBusiness.mockResolvedValue(undefined);
});

describe("PATCH lifecycle — authorization follows the transition, not the target", () => {
  it("support may not change any lifecycle state", async () => {
    state.role = "support";
    for (const [from, to] of [
      ["active", "suspended"],
      ["suspended", "active"],
      ["active", "archived"],
      ["archived", "active"],
    ] as const) {
      state.status = from;
      const res = await patch({ status: to });
      expect(res.status, `${from} -> ${to}`).toBe(403);
      expect(setBusinessStatus).not.toHaveBeenCalled();
    }
  });

  it("engineer may suspend and reactivate", async () => {
    state.role = "engineer";
    state.status = "active";
    expect((await patch({ status: "suspended" })).status).toBe(200);
    expect(setBusinessStatus).toHaveBeenCalledWith("biz-1", "suspended", { expectFrom: "active" });

    state.status = "suspended";
    expect((await patch({ status: "active" })).status).toBe(200);
  });

  it("the archived regression: an engineer cannot reactivate an archived business", async () => {
    state.role = "engineer";
    state.status = "archived";
    const res = await patch({ status: "active" });
    expect(res.status).toBe(403);
    expect(setBusinessStatus).not.toHaveBeenCalled();
  });

  it("an owner can reactivate an archived business, and it is audited as the transition", async () => {
    state.status = "archived";
    const res = await patch({ status: "active" });
    expect(res.status).toBe(200);
    expect(state.audit[0]).toMatchObject({
      action: "business.active",
      payload: { from: "archived", to: "active", capability: "business.archive" },
    });
  });

  it("archiving needs business.archive in both directions", async () => {
    state.role = "engineer";
    state.status = "active";
    expect((await patch({ status: "archived" })).status).toBe(403);

    state.role = "owner";
    expect((await patch({ status: "archived" })).status).toBe(200);
    expect(state.audit[0]).toMatchObject({ action: "business.archived" });
  });

  it("rejects an invalid transition explicitly instead of writing it", async () => {
    state.status = "archived";
    const res = await patch({ status: "suspended" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "invalid_transition", from: "archived", to: "suspended" });
    expect(setBusinessStatus).not.toHaveBeenCalled();
  });

  it("treats a no-op as a stale screen, not a lifecycle change", async () => {
    state.status = "active";
    const res = await patch({ status: "active" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "same_status" });
    expect(setBusinessStatus).not.toHaveBeenCalled();
  });

  it("refuses a concurrent writer rather than silently overwriting the new state", async () => {
    // Someone else moved the business between our read and our write: the
    // service's `expectFrom` guard matches no row, so nothing is written.
    setBusinessStatus.mockResolvedValueOnce(null);
    const res = await patch({ status: "suspended" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "transition_conflict" });
    expect(state.audit).toHaveLength(0);
  });

  it("never accepts an unknown status", async () => {
    expect((await patch({ status: "deleted" })).status).toBe(400);
    expect((await patch({ status: 7 })).status).toBe(400);
  });
});

describe("PATCH { plan } — the second plan-change path is gone", () => {
  it("refuses a plan change with a pointer to the billing service, even for an owner", async () => {
    const res = await patch({ plan: "business" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "plan_change_moved_to_billing" });
  });

  it("refuses it for a features.write holder too — the old permission cannot change a plan", async () => {
    state.role = "engineer"; // holds features.write
    expect((await patch({ plan: "business" })).status).toBe(400);
  });

  it("does not treat a plan key as a mixable field", async () => {
    state.status = "active";
    const res = await patch({ plan: "business", status: "suspended" });
    expect(res.status).toBe(400);
    expect(setBusinessStatus).not.toHaveBeenCalled();
  });
});

describe("DELETE — the audit trail cannot imply a delete that did not happen", () => {
  function del(): Promise<Response> {
    return DELETE(
      new NextRequest("http://localhost:3000/api/platform/businesses/biz-1", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "delete-me" }),
      }),
      ctx,
    ) as Promise<Response>;
  }

  it("writes requested then completed, and only after the delete committed", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(state.audit.map((a) => a.action)).toEqual([
      "business.delete.requested",
      "business.delete.completed",
    ]);
    // The business row is gone by then, so the completion carries no business_id
    // (the FK would reject it) — identity lives in the payload.
    const completed = state.audit[1];
    expect(completed.businessId).toBeNull();
    expect(completed.payload).toMatchObject({ name: "کافه الفبا", slug: "alpha" });
  });

  it("writes requested then failed — and never completed — when the delete throws", async () => {
    hardDeleteBusiness.mockRejectedValueOnce(new Error("deadlock detected"));
    const res = await del();
    expect(res.status).toBe(500);
    expect(state.audit.map((a) => a.action)).toEqual([
      "business.delete.requested",
      "business.delete.failed",
    ]);
    expect(state.audit[1].payload).toMatchObject({ reason: "deadlock detected" });
  });

  it("still requires the typed confirmation phrase", async () => {
    const res = await DELETE(
      new NextRequest("http://localhost:3000/api/platform/businesses/biz-1", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "nope" }),
      }),
      ctx,
    ) as Response;
    expect(res.status).toBe(400);
    expect(state.audit).toHaveLength(0);
    expect(hardDeleteBusiness).not.toHaveBeenCalled();
  });
});

/** A guard so the shared capability table can never silently drop a role. */
describe("the capability table the tests rely on", () => {
  it("keeps the archive capability owner-only and suspend operator-level", () => {
    expect(CAPABILITIES_FOR("owner")).toContain("business.archive");
    expect(CAPABILITIES_FOR("engineer")).toContain("business.suspend");
    expect(CAPABILITIES_FOR("engineer")).not.toContain("business.archive");
    expect(CAPABILITIES_FOR("support")).not.toContain("business.suspend");
  });
});
