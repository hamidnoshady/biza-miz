import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #911 — the item endpoints' path id.
 *
 * PATCH and DELETE resolved the branch and *then* asked the database whether
 * the item belonged to it, passing the raw path segment to a uuid column. An
 * id that is not a uuid therefore produced «invalid input syntax for type
 * uuid» — a 500 — instead of a refusal. The shape is checked first now, so
 * neither the database nor the service sees a string that cannot be an id.
 */
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import * as menuService from "@/lib/menu-service";
import { DELETE, PATCH } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/menu-service", () => ({ updateMenuItem: vi.fn(), deleteMenuItem: vi.fn() }));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const ITEM_ID = "11111111-1111-4111-8111-111111111111";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function patchRequest(body: unknown) {
  return new NextRequest(`http://localhost/api/menu/items/${ITEM_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function deleteRequest(id: string) {
  return new NextRequest(`http://localhost/api/menu/items/${id}`, { method: "DELETE" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: SESSION,
    error: null,
  } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [{ id: ITEM_ID }] } as never);
  vi.mocked(menuService.updateMenuItem).mockResolvedValue({ ok: true } as never);
  vi.mocked(menuService.deleteMenuItem).mockResolvedValue({
    ok: true,
    deactivated: false,
  } as never);
});

describe("PATCH /api/menu/items/:id", () => {
  it("refuses an id that cannot be a uuid, without asking the database", async () => {
    for (const id of ["not-a-uuid", "7", "", "11111111-1111-4111-8111-11111111111z"]) {
      vi.mocked(db.query).mockClear();
      const response = await PATCH(patchRequest({ name: "لاته" }) as never, ctx(id) as never);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "bad_request" });
      expect(db.query).not.toHaveBeenCalled();
      expect(menuService.updateMenuItem).not.toHaveBeenCalled();
    }
  });

  it("reports a well-formed id that is not this branch's as 404", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
    const response = await PATCH(patchRequest({ name: "لاته" }) as never, ctx(ITEM_ID) as never);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "item_not_found" });
  });

  it("patches a real item and names the actor", async () => {
    const response = await PATCH(patchRequest({ name: "لاته" }) as never, ctx(ITEM_ID) as never);
    expect(response.status).toBe(200);
    expect(menuService.updateMenuItem).toHaveBeenCalledWith(
      "loc-1",
      ITEM_ID,
      expect.objectContaining({ name: "لاته" }),
      "biz-1",
      expect.objectContaining({ changedBy: "user-1" }),
    );
  });
});

describe("DELETE /api/menu/items/:id", () => {
  it("refuses an id that cannot be a uuid", async () => {
    vi.mocked(db.query).mockClear();
    const response = await DELETE(deleteRequest("not-a-uuid") as never, ctx("not-a-uuid") as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "bad_request" });
    expect(db.query).not.toHaveBeenCalled();
    expect(menuService.deleteMenuItem).not.toHaveBeenCalled();
  });

  it("deletes through the service and reports which outcome happened", async () => {
    const response = await DELETE(deleteRequest(ITEM_ID) as never, ctx(ITEM_ID) as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deactivated: false });
    expect(menuService.deleteMenuItem).toHaveBeenCalledWith(
      "loc-1",
      ITEM_ID,
      "biz-1",
      expect.objectContaining({ changedBy: "user-1" }),
    );
  });

  it("surfaces the service's «deactivated instead of deleted» outcome", async () => {
    vi.mocked(menuService.deleteMenuItem).mockResolvedValue({
      ok: true,
      deactivated: true,
    } as never);
    const response = await DELETE(deleteRequest(ITEM_ID) as never, ctx(ITEM_ID) as never);
    await expect(response.json()).resolves.toEqual({ ok: true, deactivated: true });
  });
});
