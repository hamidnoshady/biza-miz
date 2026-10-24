import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #910 — what DELETE /api/menu/modifier-groups/[id] actually answers.
 *
 * The service refuses to cascade configuration (menu-service.ts
 * `deleteModifierGroup`): a group that an item carries, that still has options,
 * whose options have recipes, or that has been sold is *deactivated*; only a
 * truly empty, unreferenced group is deleted. The manager's confirmation dialog
 * reads the affected counts out of this response and says "kept, switched off"
 * rather than "deleted" — so the route's payload is the contract between the
 * safety rule and the screen, and it is asserted here at the status-code level.
 */
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as menuService from "@/lib/menu-service";
import { DELETE } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));

vi.mock("@/lib/db", () => ({
  // The ownership predicate is the row lookup: one row means "this branch's
  // group". A foreign id is the 404 case, exercised below by zero rows.
  query: vi.fn(async () => ({ rows: [{ id: "group-1" }], rowCount: 1 })),
}));

vi.mock("@/lib/menu-service", () => ({ deleteModifierGroup: vi.fn() }));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };
const BRANCH = "11111111-1111-4111-8111-111111111111";
const GROUP = "33333333-3333-4333-8333-333333333333";

function del(id: string) {
  return [
    new NextRequest(`http://localhost/api/menu/modifier-groups/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: BRANCH } as never);
});

describe("DELETE /api/menu/modifier-groups/[id] — safe deletion semantics", () => {
  it("reports a deactivation with the counts the dialog shows", async () => {
    vi.mocked(menuService.deleteModifierGroup).mockResolvedValue({
      ok: true,
      deactivated: true,
      affected: { items: 3, options: 2 },
    });

    const response = await DELETE(...del(GROUP));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      deactivated: true,
      affected: { items: 3, options: 2 },
    });
    expect(menuService.deleteModifierGroup).toHaveBeenCalledWith(BRANCH, GROUP);
  });

  it("reports a real delete only when the service deleted", async () => {
    vi.mocked(menuService.deleteModifierGroup).mockResolvedValue({
      ok: true,
      deactivated: false,
      affected: { items: 0, options: 0 },
    });

    const response = await DELETE(...del(GROUP));
    expect(await response.json()).toEqual({
      ok: true,
      deactivated: false,
      affected: { items: 0, options: 0 },
    });
  });

  it("never assumes a missing flag means a delete", async () => {
    // A service result that predates the flag (or a future refactor) must read
    // as "not deleted", so the UI cannot claim a cascade it did not verify.
    vi.mocked(menuService.deleteModifierGroup).mockResolvedValue({ ok: true });

    const response = await DELETE(...del(GROUP));
    expect(await response.json()).toEqual({
      ok: true,
      deactivated: false,
      affected: { items: 0, options: 0 },
    });
  });

  it("answers a group from another branch with 404 and deletes nothing", async () => {
    const db = await import("@/lib/db");
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const response = await DELETE(...del(GROUP));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "group_not_found" });
    expect(menuService.deleteModifierGroup).not.toHaveBeenCalled();
  });

  it("passes a service refusal through with its status", async () => {
    vi.mocked(menuService.deleteModifierGroup).mockResolvedValue({
      ok: false,
      error: "group_not_found",
      status: 404,
    });

    const response = await DELETE(...del(GROUP));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "group_not_found" });
  });

  it("refuses a caller without menu.edit before touching a row", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    } as never);

    const response = await DELETE(...del(GROUP));

    expect(response.status).toBe(403);
    expect(menuService.deleteModifierGroup).not.toHaveBeenCalled();
  });
});
