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
  ownershipKind: "customer" as "customer" | "platform_internal",
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
    ownershipKind: state.ownershipKind,
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
const resetBusiness = vi.hoisted(() => vi.fn());
const changeBusinessIndustry = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@/lib/platform-service", () => ({
  getBusiness: vi.fn(async () => summary(state.status)),
  setBusinessStatus,
  hardDeleteBusiness,
  resetBusiness,
  updateBusiness: vi.fn(async () => summary(state.status)),
  renameBusinessSubdomain: vi.fn(async () => ({ ok: false, error: "not_found" })),
  changeBusinessIndustry,
  industryDataCounts: vi.fn(async () => null),
  BusinessNotFoundError: class BusinessNotFoundError extends Error {},
  ResetBusinessNotPossibleError: class ResetBusinessNotPossibleError extends Error {},
  ProtectedInternalBusinessError: class ProtectedInternalBusinessError extends Error {},
  BusinessDeleteBlockedError: class BusinessDeleteBlockedError extends Error {
    constructor(readonly reference: string) {
      super("delete_blocked");
    }
  },
}));

vi.mock("@/lib/host", () => ({ rootDomain: () => "example.test" }));
vi.mock("@/lib/host-resolution", () => ({ listSubdomainAliases: vi.fn(async () => []) }));

const { PATCH, POST, DELETE } = await import("./route");
const service = await import("@/lib/platform-service");

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
  state.ownershipKind = "customer";
  state.audit = [];
  setBusinessStatus.mockReset();
  setBusinessStatus.mockImplementation(async (_id: string, next: string) => summary(next));
  hardDeleteBusiness.mockReset();
  hardDeleteBusiness.mockResolvedValue({ detachedCustomerTenantMappings: 0 });
  resetBusiness.mockReset();
  resetBusiness.mockResolvedValue(undefined);
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

describe("POST reset — requested/completed/failed lifecycle (issue #822)", () => {
  function reset(confirmation: string): Promise<Response> {
    return POST(
      new NextRequest("http://localhost:3000/api/platform/businesses/biz-1", {
        method: "POST",
        body: JSON.stringify({ confirmation }),
      }),
      ctx,
    ) as Promise<Response>;
  }

  it("accepts only the target-specific phrase `RESET {slug}`", async () => {
    for (const wrong of ["", "delete-me", "RESET alpha ", "DELETE alpha", "reset alpha", "RESET beta"]) {
      // (the route trims, so "RESET alpha " is the one near-miss that passes;
      // keep it out of the rejection set)
      if (wrong.trim() === "RESET alpha") continue;
      const res = await reset(wrong);
      expect(res.status, wrong).toBe(400);
      expect(await res.json(), wrong).toMatchObject({ error: "reset_confirmation_required" });
    }
    expect(state.audit).toHaveLength(0);
    expect(resetBusiness).not.toHaveBeenCalled();

    expect((await reset("RESET alpha")).status).toBe(200);
  });

  it("writes requested then completed — completed only after the reset committed", async () => {
    const res = await reset("RESET alpha");
    expect(res.status).toBe(200);
    expect(state.audit.map((a) => a.action)).toEqual([
      "business.reset.requested",
      "business.reset.completed",
    ]);
    // The business row survives a reset, so both events keep its business_id
    // (unlike hard delete's completion).
    for (const event of state.audit) expect(event.businessId).toBe("biz-1");
    expect(state.audit[0].payload).toMatchObject({ name: "کافه الفبا", slug: "alpha", plan: "pro" });
  });

  it("writes requested then failed when the service throws — with an audit-safe reason, never the raw error", async () => {
    resetBusiness.mockRejectedValueOnce(new Error("deadlock detected"));
    const res = await reset("RESET alpha");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "reset_failed" });
    expect(state.audit.map((a) => a.action)).toEqual([
      "business.reset.requested",
      "business.reset.failed",
    ]);
    expect(state.audit[1].payload).toMatchObject({ reason: "reset_unexpected_error" });
    expect(JSON.stringify(state.audit[1].payload)).not.toContain("deadlock");
  });

  it("maps reset_not_possible to a 409 and still records the failure", async () => {
    resetBusiness.mockRejectedValueOnce(new service.ResetBusinessNotPossibleError());
    const res = await reset("RESET alpha");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "reset_not_possible" });
    expect(state.audit.map((a) => a.action)).toEqual([
      "business.reset.requested",
      "business.reset.failed",
    ]);
    expect(state.audit[1].payload).toMatchObject({ reason: "reset_not_possible" });
  });

  it("needs the business.reset capability — an engineer cannot reset", async () => {
    state.role = "engineer";
    const res = await reset("RESET alpha");
    expect(res.status).toBe(403);
    expect(state.audit).toHaveLength(0);
    expect(resetBusiness).not.toHaveBeenCalled();
  });
});

describe("DELETE — the audit trail cannot imply a delete that did not happen", () => {
  function del(confirmation = "DELETE alpha"): Promise<Response> {
    return DELETE(
      new NextRequest("http://localhost:3000/api/platform/businesses/biz-1", {
        method: "DELETE",
        body: JSON.stringify({ confirmation }),
      }),
      ctx,
    ) as Promise<Response>;
  }

  it("writes requested then completed, and only after the delete committed", async () => {
    hardDeleteBusiness.mockResolvedValueOnce({ detachedCustomerTenantMappings: 1 });
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
    expect(completed.payload).toMatchObject({
      name: "کافه الفبا",
      slug: "alpha",
      detachedCustomerTenantMappings: 1,
    });
  });

  it("writes requested then failed — and never completed — when the delete throws", async () => {
    hardDeleteBusiness.mockRejectedValueOnce(new Error("deadlock detected"));
    const res = await del();
    expect(res.status).toBe(500);
    expect(state.audit.map((a) => a.action)).toEqual([
      "business.delete.requested",
      "business.delete.failed",
    ]);
    // The failure payload is audit-safe: a stable token, never raw DB text.
    expect(state.audit[1].payload).toMatchObject({ reason: "delete_unexpected_error" });
    expect(JSON.stringify(state.audit[1].payload)).not.toContain("deadlock");
  });

  it("surfaces a live reference as a specific operator-facing blocker, not a raw FK error", async () => {
    hardDeleteBusiness.mockRejectedValueOnce(new service.BusinessDeleteBlockedError("some_fk"));
    const res = await del();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "delete_blocked", reference: "some_fk" });
    expect(state.audit.map((a) => a.action)).toEqual([
      "business.delete.requested",
      "business.delete.failed",
    ]);
    expect(state.audit[1].payload).toMatchObject({ reason: "reference_blocked" });
  });

  it("closes the trail with a not_found failure when the row vanishes between request and lock", async () => {
    hardDeleteBusiness.mockRejectedValueOnce(new service.BusinessNotFoundError());
    const res = await del();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    // `requested` must never dangle without a terminal event — the failed
    // record is what proves nothing was deleted by this attempt.
    expect(state.audit.map((a) => a.action)).toEqual([
      "business.delete.requested",
      "business.delete.failed",
    ]);
    expect(state.audit[1].payload).toMatchObject({ reason: "not_found" });
  });

  it("maps the service's deeper platform-internal refusal to the same operator-facing 409", async () => {
    hardDeleteBusiness.mockRejectedValueOnce(new service.ProtectedInternalBusinessError());
    const res = await del();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "protected_internal_business" });
    expect(state.audit.map((a) => a.action)).toEqual([
      "business.delete.requested",
      "business.delete.failed",
    ]);
    expect(state.audit[1].payload).toMatchObject({ reason: "protected_internal_business" });
  });

  it("requires the target-specific typed phrase — the old shared phrase and the reset phrase are both rejected", async () => {
    for (const wrong of ["nope", "delete-me", "RESET alpha", "DELETE beta"]) {
      const res = await del(wrong);
      expect(res.status, wrong).toBe(400);
      expect(await res.json(), wrong).toMatchObject({ error: "delete_confirmation_required" });
    }
    expect(state.audit).toHaveLength(0);
    expect(hardDeleteBusiness).not.toHaveBeenCalled();
  });

  it("needs the business.delete capability — an engineer cannot delete", async () => {
    state.role = "engineer";
    const res = await del();
    expect(res.status).toBe(403);
    expect(state.audit).toHaveLength(0);
    expect(hardDeleteBusiness).not.toHaveBeenCalled();
  });
});

describe("the protected platform-internal business", () => {
  beforeEach(() => {
    state.ownershipKind = "platform_internal";
  });

  it("is refused by every destructive route before any audit or service call", async () => {
    const patchRes = await patch({ name: "X", timezone: "Asia/Tehran" });
    expect(patchRes.status).toBe(409);
    expect(await patchRes.json()).toMatchObject({ error: "protected_internal_business" });

    const resetRes = await POST(
      new NextRequest("http://localhost:3000/api/platform/businesses/biz-1", {
        method: "POST",
        body: JSON.stringify({ confirmation: "RESET alpha" }),
      }),
      ctx,
    );
    expect(resetRes.status).toBe(409);
    expect(await resetRes.json()).toMatchObject({ error: "protected_internal_business" });

    const deleteRes = await DELETE(
      new NextRequest("http://localhost:3000/api/platform/businesses/biz-1", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "DELETE alpha" }),
      }),
      ctx,
    );
    expect(deleteRes.status).toBe(409);
    expect(await deleteRes.json()).toMatchObject({ error: "protected_internal_business" });

    expect(state.audit).toHaveLength(0);
    expect(resetBusiness).not.toHaveBeenCalled();
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

describe("PATCH industry — a live-chart conflict is reported as itself (issue #824 finding 2)", () => {
  beforeEach(() => {
    state.role = "owner";
    state.status = "active";
    changeBusinessIndustry.mockReset();
  });

  it("answers 409 with the typed code when the seed refuses, and the change is not reported as done", async () => {
    const { AccountsError } = await import("@/lib/accounts-error");
    changeBusinessIndustry.mockRejectedValueOnce(new AccountsError("parent_archived", 409));
    const res = await patch({ industry: "jewelry" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "parent_archived" });
  });

  it("answers 500 for an error that is not a typed conflict, rather than inventing a code", async () => {
    changeBusinessIndustry.mockRejectedValueOnce(new Error("connection reset"));
    await expect(patch({ industry: "jewelry" })).rejects.toThrow("connection reset");
  });

  it("returns the seeded codes on success", async () => {
    changeBusinessIndustry.mockResolvedValueOnce({
      business: summary("active"),
      seededAccountCodes: ["1110"],
    } as never);
    const res = await patch({ industry: "jewelry" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ seededAccountCodes: ["1110"] });
  });
});
