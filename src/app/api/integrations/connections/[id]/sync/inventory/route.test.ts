import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as connectionAccess from "@/lib/integrations/connection-access";
import * as outbox from "@/lib/integrations/outbox-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAnyPermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: vi.fn() }));
vi.mock("@/lib/integrations/outbox-service", () => ({ refreshOutboxForConnection: vi.fn(), drainOutbox: vi.fn() }));

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12" };
const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const CONNECTION = { id: CONNECTION_ID, provider: "woocommerce", status: "active", link_mode: "plugin" };
const call = () =>
  POST(new Request(`http://localhost/api/integrations/connections/${CONNECTION_ID}/sync/inventory`, { method: "POST" }), {
    params: Promise.resolve({ id: CONNECTION_ID }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(CONNECTION as never);
});

describe("POST /api/integrations/connections/[id]/sync/inventory (#944 / OVR-08)", () => {
  it("is granted by woocommerce.sync, with integrations.manage keeping its old access", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceSync, PERMISSIONS.integrationsManage);
    expect(outbox.refreshOutboxForConnection).toHaveBeenCalledWith(CONNECTION);
  });

  it("stops at «queued» in plugin mode and drains in REST mode", async () => {
    await expect((await call()).json()).resolves.toEqual({ ok: true, queued: true });
    expect(outbox.drainOutbox).not.toHaveBeenCalled();
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce({ ...CONNECTION, link_mode: "rest_api" } as never);
    await expect((await call()).json()).resolves.toEqual({ ok: true });
    expect(outbox.drainOutbox).toHaveBeenCalledTimes(1);
  });

  it("refuses a member without either permission before reading the connection", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requireAnyPermission).mockResolvedValueOnce({ session: null, error: denied } as never);
    expect((await call()).status).toBe(403);
    expect(connectionAccess.getAccessibleConnection).not.toHaveBeenCalled();
  });
});
