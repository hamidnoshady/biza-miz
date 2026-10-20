import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as connectionsService from "@/lib/integrations/connections-service";
import * as audit from "@/lib/integrations/audit";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/integrations/connections-service", () => ({
  getConnection: vi.fn(),
}));

vi.mock("@/lib/integrations/audit", () => ({
  writeIntegrationAudit: vi.fn(),
}));

const SESSION = {
  businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
  role: "owner",
};

const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";

const PLUGIN_CONNECTION = {
  id: CONNECTION_ID,
  business_id: SESSION.businessId,
  provider: "woocommerce",
  status: "active",
  link_mode: "plugin",
  plugin_capabilities: { jobTypes: ["stock", "price", "media_create"] },
};

function mediaRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/integrations/wp-manager/media", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionsService.getConnection).mockResolvedValue(PLUGIN_CONNECTION as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
});

describe("POST /api/integrations/wp-manager/media", () => {
  it("returns 400 when connectionId is missing", async () => {
    const res = await POST(mediaRequest({ url: "https://cdn.example.com/a.jpg" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_connection" });
  });

  it("rejects a non-http(s) or credentialed URL before touching the connection", async () => {
    for (const url of ["javascript:alert(1)", "ftp://x/y.jpg", "https://user:pw@host/a.jpg", "not a url"]) {
      const res = await POST(mediaRequest({ connectionId: CONNECTION_ID, url }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_media_url" });
    }
    expect(connectionsService.getConnection).not.toHaveBeenCalled();
  });

  it("returns 404 for a connection outside the tenant or of another provider", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValue(null as never);
    const res = await POST(mediaRequest({ connectionId: CONNECTION_ID, url: "https://cdn.example.com/a.jpg" }));
    expect(res.status).toBe(404);
  });

  it("answers 409 connection_paused for a paused connection", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValue({ ...PLUGIN_CONNECTION, status: "paused" } as never);
    const res = await POST(mediaRequest({ connectionId: CONNECTION_ID, url: "https://cdn.example.com/a.jpg" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "connection_paused" });
  });

  it("refuses REST connections — wp/v2 has no sideload-by-URL and this server must not proxy fetches", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValue({ ...PLUGIN_CONNECTION, link_mode: "rest_api" } as never);
    const res = await POST(mediaRequest({ connectionId: CONNECTION_ID, url: "https://cdn.example.com/a.jpg" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "media_rest_unsupported" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses a plugin whose handshake never advertised media_create (legacy capability set)", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValue({ ...PLUGIN_CONNECTION, plugin_capabilities: null } as never);
    const res = await POST(mediaRequest({ connectionId: CONNECTION_ID, url: "https://cdn.example.com/a.jpg" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "plugin_media_unsupported" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("enqueues one media_create outbox job with a stable operation id and audits it", async () => {
    const res = await POST(
      mediaRequest({ connectionId: CONNECTION_ID, url: "https://cdn.example.com/a.jpg", title: "  بنر تخفیف  " }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: true });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("integration_outbox_events");
    expect(sql).toContain("'media_create'");
    expect(params[0]).toBe(SESSION.businessId);
    expect(params[1]).toBe(CONNECTION_ID);
    const remoteId = params[2] as string;
    expect(remoteId).toMatch(/^new-/);
    const payload = JSON.parse(params[3] as string) as Record<string, unknown>;
    expect(payload.url).toBe("https://cdn.example.com/a.jpg");
    expect(payload.title).toBe("بنر تخفیف");
    // The operation id is what makes a retried lease idempotent on the store.
    expect(payload.__operationId).toBe(`wp-media:${CONNECTION_ID}:${remoteId}`);
    expect(params[4]).toBe(payload.__operationId);

    expect(audit.writeIntegrationAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "content.media_create_queued", entityType: "media_create" }),
    );
  });
});

it("checks the granular WooCommerce manage permission before queuing", async () => {
  vi.mocked(auth.requirePermission).mockResolvedValueOnce({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
  const res = await POST(mediaRequest({ connectionId: CONNECTION_ID, url: "https://cdn.example.com/a.jpg" }));
  expect(res.status).toBe(403);
  expect(auth.requirePermission).toHaveBeenCalledWith("woocommerce.manage");
  expect(db.query).not.toHaveBeenCalled();
});
