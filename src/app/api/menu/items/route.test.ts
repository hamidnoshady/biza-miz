import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #911 — a save that is sent twice creates the item once.
 *
 * The client-side guard stops a click that lands while a save is in flight,
 * but not a save whose answer the browser never received: the operator is
 * entitled to press «ذخیره» again, and the server is the only place that can
 * tell a retry from a second, deliberate save. So a create carries an optional
 * key, and this route is where the key is accepted — from the body the editor
 * sends, or from the standard `Idempotency-Key` header any other client uses.
 *
 * What must stay true: a key is optional (every importer and sync path omits
 * it and must keep working), a bad key is a 400 rather than a stored value,
 * and a replay is answered as a success — the item exists, that is what the
 * caller asked for — never as an error, and never as a second item.
 */
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as menuService from "@/lib/menu-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/menu-service", () => ({ createMenuItem: vi.fn() }));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const CATEGORY_ID = "11111111-1111-4111-8111-111111111111";

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/menu/items", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** The input the service actually received. */
function sentInput(): Record<string, unknown> {
  return vi.mocked(menuService.createMenuItem).mock.calls[0][2] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(menuService.createMenuItem).mockResolvedValue({ ok: true, id: "item-1" } as never);
});

describe("POST /api/menu/items — create key", () => {
  it("creates without a key, exactly as the importers and syncs do", async () => {
    const response = await POST(post({ categoryId: CATEGORY_ID, name: "لاته", price: 40_000 }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, id: "item-1", duplicate: false });
    expect(sentInput().idempotencyKey).toBeUndefined();
  });

  it("forwards the editor's body key to the service", async () => {
    const response = await POST(
      post({ categoryId: CATEGORY_ID, name: "لاته", price: 40_000, idempotencyKey: "draft-7" }),
    );

    expect(response.status).toBe(200);
    expect(sentInput().idempotencyKey).toBe("draft-7");
  });

  it("accepts the standard Idempotency-Key header when the body has none", async () => {
    const response = await POST(
      post({ categoryId: CATEGORY_ID, name: "لاته", price: 40_000 }, { "Idempotency-Key": "header-1" }),
    );

    expect(response.status).toBe(200);
    expect(sentInput().idempotencyKey).toBe("header-1");
  });

  it("lets an explicit body key win over the header", async () => {
    await POST(
      post(
        { categoryId: CATEGORY_ID, name: "لاته", price: 40_000, idempotencyKey: "body-1" },
        { "Idempotency-Key": "header-1" },
      ),
    );

    expect(sentInput().idempotencyKey).toBe("body-1");
  });

  it("trims a key instead of storing the whitespace with it", async () => {
    await POST(post({ categoryId: CATEGORY_ID, name: "لاته", price: 40_000, idempotencyKey: "  k-1  " }));

    expect(sentInput().idempotencyKey).toBe("k-1");
  });

  it("answers a replay as a success, with the item the first attempt made", async () => {
    vi.mocked(menuService.createMenuItem).mockResolvedValue({
      ok: true,
      id: "item-1",
      duplicate: true,
    } as never);

    const response = await POST(
      post({ categoryId: CATEGORY_ID, name: "لاته", price: 40_000, idempotencyKey: "draft-7" }),
    );
    const body = await response.json();

    // A retry is not a failure: the item this save asked for already exists.
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, id: "item-1", duplicate: true });
  });

  it("refuses a key that is not a usable string", async () => {
    for (const idempotencyKey of [42, true, {}, "", "   "]) {
      const response = await POST(
        post({ categoryId: CATEGORY_ID, name: "لاته", price: 40_000, idempotencyKey }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
    }
    expect(menuService.createMenuItem).not.toHaveBeenCalled();
  });

  it("refuses a key too long for the column it is indexed on", async () => {
    const response = await POST(
      post({
        categoryId: CATEGORY_ID,
        name: "لاته",
        price: 40_000,
        idempotencyKey: "k".repeat(101),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "too_long" });
    expect(menuService.createMenuItem).not.toHaveBeenCalled();
  });

  it("keeps refusing a create that is invalid for its own reasons", async () => {
    const response = await POST(post({ categoryId: CATEGORY_ID, name: "لاته", price: -1 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_price" });
    expect(menuService.createMenuItem).not.toHaveBeenCalled();
  });
});
