import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #911 — the category endpoints' path id.
 *
 * `PATCH`/`DELETE /api/menu/categories/:id` put the raw path segment straight
 * into `menu_categories WHERE id = $1`, so an id that is not a uuid made the
 * database answer «invalid input syntax for type uuid» — a 500 for what is
 * simply a client mistake. The shape is checked before the query now, and the
 * request is refused with the same structured 400 the item endpoints use.
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
vi.mock("@/lib/menu-service", () => ({ updateCategory: vi.fn() }));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function patchRequest(body: unknown, raw?: string) {
  return new NextRequest(`http://localhost/api/menu/categories/${CATEGORY_ID}`, {
    method: "PATCH",
    body: raw ?? JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: SESSION,
    error: null,
  } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [{ id: CATEGORY_ID }] } as never);
  vi.mocked(menuService.updateCategory).mockResolvedValue({ ok: true } as never);
});

describe("PATCH /api/menu/categories/:id", () => {
  it("refuses an id that cannot be a uuid, without asking the database", async () => {
    for (const id of ["not-a-uuid", "1", "", "22222222-2222-4222-8222-22222222222z", "../etc"]) {
      vi.mocked(db.query).mockClear();
      const response = await PATCH(patchRequest({ name: "نوشیدنی" }) as never, ctx(id) as never);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "bad_request" });
      // The whole point: no uuid column ever sees this string.
      expect(db.query).not.toHaveBeenCalled();
      expect(menuService.updateCategory).not.toHaveBeenCalled();
    }
  });

  it("still reports a well-formed id that is not this branch's as 404", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
    const response = await PATCH(
      patchRequest({ name: "نوشیدنی" }) as never,
      ctx(CATEGORY_ID) as never,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "category_not_found" });
    expect(menuService.updateCategory).not.toHaveBeenCalled();
  });

  it("patches a real category", async () => {
    const response = await PATCH(
      patchRequest({ name: "نوشیدنی گرم" }) as never,
      ctx(CATEGORY_ID) as never,
    );
    expect(response.status).toBe(200);
    expect(menuService.updateCategory).toHaveBeenCalledWith(
      "loc-1",
      CATEGORY_ID,
      expect.objectContaining({ name: "نوشیدنی گرم" }),
    );
  });
});

describe("DELETE /api/menu/categories/:id", () => {
  it("refuses an id that cannot be a uuid", async () => {
    vi.mocked(db.query).mockClear();
    const response = await DELETE(
      new NextRequest("http://localhost/api/menu/categories/not-a-uuid", { method: "DELETE" }) as never,
      ctx("not-a-uuid") as never,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "bad_request" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("deletes an empty category and reports the outcome", async () => {
    // No items reference it → the row goes; the items query answers empty.
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: CATEGORY_ID }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValue({ rows: [] } as never);

    const response = await DELETE(
      new NextRequest(`http://localhost/api/menu/categories/${CATEGORY_ID}`, {
        method: "DELETE",
      }) as never,
      ctx(CATEGORY_ID) as never,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deactivated: false });
  });
});
