import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: vi.fn() }));
vi.mock("@/lib/integrations/mapping-service", () => ({ localIdForRemote: vi.fn() }));
vi.mock("@/lib/integrations/woo-ops-service", () => ({ retryProductQueue: vi.fn() }));

import * as connectionAccess from "@/lib/integrations/connection-access";
import * as mappingService from "@/lib/integrations/mapping-service";
import * as opsService from "@/lib/integrations/woo-ops-service";
import { POST } from "./route";

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };
const CONNECTION_ID = "conn-woo-1";

function wooConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    business_id: SESSION.businessId,
    provider: "woocommerce",
    status: "active",
    link_mode: "rest_api",
    currency_unit: "toman",
    push_stock: true,
    push_prices: true,
    ...overrides,
  };
}

function post(body: unknown, rawBody?: string) {
  return POST(
    new Request(`http://localhost/api/integrations/connections/${CONNECTION_ID}/store/products/retry`, {
      method: "POST",
      body: rawBody ?? JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: CONNECTION_ID }) } as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection() as never);
  vi.mocked(mappingService.localIdForRemote).mockResolvedValue("local-uuid");
  vi.mocked(opsService.retryProductQueue).mockResolvedValue(2);
});

describe("POST store/products/retry — the role matrix around the one resurrection path", () => {
  it("gates on woocommerce.manage — the shopfront capability, not the connection-config one", async () => {
    await post({ remoteId: "55" });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceManage);
    expect(connectionAccess.getAccessibleConnection).toHaveBeenCalledWith(SESSION, CONNECTION_ID);
  });

  it("passes a denial straight through — a viewer role never reaches the queue", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const res = await post({ remoteId: "55" });
    expect(res.status).toBe(403);
    expect(opsService.retryProductQueue).not.toHaveBeenCalled();
  });

  it("404s another tenant's session and a non-WooCommerce connection alike", async () => {
    // The cross-tenant leg: getAccessibleConnection resolves by session, so
    // another business's id comes back null — a 404 that leaks nothing.
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(null);
    expect((await post({ remoteId: "55" })).status).toBe(404);
    expect(opsService.retryProductQueue).not.toHaveBeenCalled();

    // The cross-connection leg: a Holoo id on this WooCommerce route.
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(
      wooConnection({ provider: "holoo" }) as never,
    );
    expect((await post({ remoteId: "55" })).status).toBe(404);

    // Another store's product on THIS connection: mapped-or-404, same rule
    // as the edit route — a retry cannot be queued under an id this
    // connection never synced.
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection() as never);
    vi.mocked(mappingService.localIdForRemote).mockResolvedValue(null);
    const res = await post({ remoteId: "55" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "product_not_mapped" });
    expect(opsService.retryProductQueue).not.toHaveBeenCalled();
  });

  it("refuses a paused connection, a malformed body and a non-numeric remote id", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(
      wooConnection({ status: "paused" }) as never,
    );
    expect((await post({ remoteId: "55" })).status).toBe(409);
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection() as never);

    expect((await post(null, "not json")).status).toBe(400);
    expect((await post([1, 2])).status).toBe(400);
    expect((await post({})).status).toBe(400);
    for (const remoteId of ["abc", "55; DROP", "", "  ", "123456789012345678901"]) {
      const res = await post({ remoteId });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_remote_id" });
    }
    expect(opsService.retryProductQueue).not.toHaveBeenCalled();
  });

  it("requeues through the ops service and reports the honest count — including zero", async () => {
    const res = await post({ remoteId: "55" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, retried: 2 });
    expect(opsService.retryProductQueue).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, "55");

    // Nothing parked is a truthful zero, not an error: the button must not
    // invent a failure where the queue is simply clean.
    vi.mocked(opsService.retryProductQueue).mockResolvedValue(0);
    expect(await (await post({ remoteId: "55" })).json()).toEqual({ ok: true, retried: 0 });
  });

  it("answers an unexpected failure with a stable code, never the raw message", async () => {
    vi.mocked(opsService.retryProductQueue).mockRejectedValue(new Error("ECONNREFUSED secret-host:5432"));
    const res = await post({ remoteId: "55" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});
