import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as connectionsService from "@/lib/integrations/connections-service";
import * as wpManagerService from "@/lib/integrations/wp-manager-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/integrations/connections-service", () => ({
  getConnection: vi.fn(),
}));

vi.mock("@/lib/integrations/wp-manager-service", () => ({
  retryWpQueueRow: vi.fn(),
}));

const SESSION = {
  businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
  role: "owner",
};
const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const ROW_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";

function request(): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new Request(`http://localhost:3000/api/integrations/wp-manager/queue/${ROW_ID}/retry?connectionId=${CONNECTION_ID}`, {
      method: "POST",
    }),
    ctx: { params: Promise.resolve({ id: ROW_ID }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionsService.getConnection).mockResolvedValue({
    id: CONNECTION_ID,
    business_id: SESSION.businessId,
    provider: "woocommerce",
    status: "active",
    link_mode: "plugin",
  } as never);
});

describe("POST /api/integrations/wp-manager/queue/[id]/retry", () => {
  it("retries an eligible row and names the actor", async () => {
    vi.mocked(wpManagerService.retryWpQueueRow).mockResolvedValueOnce({ ok: true, status: "pending" });
    const { req, ctx } = request();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "pending" });
    expect(wpManagerService.retryWpQueueRow).toHaveBeenCalledWith(
      SESSION.businessId,
      CONNECTION_ID,
      ROW_ID,
      undefined,
      SESSION.sub,
    );
  });

  // Issue #942 (F06): this endpoint used to move data for paused connections
  // while its sibling route refused. The guard now lives in the service and
  // must surface here as the same 409.
  it("refuses with 409 while the connection is paused", async () => {
    vi.mocked(wpManagerService.retryWpQueueRow).mockResolvedValueOnce({
      ok: false,
      error: "connection_paused",
      status: "paused",
    });
    const { req, ctx } = request();
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "connection_paused", status: "paused" });
  });

  // Issue #942 (F05): a sent/processing/needs_review row is a state
  // conflict, not a client error.
  it("answers 409 with the current status for a non-retryable row", async () => {
    vi.mocked(wpManagerService.retryWpQueueRow).mockResolvedValueOnce({
      ok: false,
      error: "not_retryable",
      status: "processing",
    });
    const { req, ctx } = request();
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "not_retryable", status: "processing" });
  });

  it("answers 404 for a row that is not this tenant's", async () => {
    vi.mocked(wpManagerService.retryWpQueueRow).mockResolvedValueOnce({ ok: false, error: "not_found" });
    const { req, ctx } = request();
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });
});
