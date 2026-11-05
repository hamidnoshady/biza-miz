import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import * as connectionAccess from "@/lib/integrations/connection-access";
import * as db from "@/lib/db";
import * as audit from "@/lib/integrations/audit";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/integrations/audit", () => ({ writeIntegrationAudit: vi.fn() }));

const SESSION = { businessId: "biz", sub: "user", role: "owner" };
const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";

const capable = {
  id: CONNECTION_ID,
  provider: "woocommerce",
  link_mode: "plugin",
  status: "active",
  plugin_capabilities: { localQueuePaging: true, jobTypes: ["stock"] },
};

const url = `http://localhost/api/integrations/wp-manager/queue/local?connectionId=${CONNECTION_ID}`;
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/integrations/wp-manager/queue/local", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(capable as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [{ request: null, answer: null }] } as never);
});

describe("#1076 plugin-local queue paging route", () => {
  it("is sync-tier on both verbs — the same permission the row diagnostics use", async () => {
    await GET(new Request(url));
    await post({ connectionId: CONNECTION_ID, after: 0, limit: 10 });
    expect(auth.requirePermission).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(auth.requirePermission).mock.calls) {
      expect(call[0]).toBe(PERMISSIONS.woocommerceSync);
    }
  });

  it("answers an older plugin honestly instead of pretending the page is empty", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue({
      ...capable,
      plugin_capabilities: { jobTypes: ["stock"] },
    } as never);
    const response = await GET(new Request(url));
    expect(await response.json()).toEqual({ supported: false, reason: "plugin_too_old" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("never offers plugin-local paging on a REST connection", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue({ ...capable, link_mode: "rest_api" } as never);
    expect(await (await GET(new Request(url))).json()).toEqual({ supported: false, reason: "rest_mode" });
  });

  it("returns the pending request and the last answer", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [
        {
          request: { after: 40, limit: 10, requestedAt: "2026-11-05T10:00:00.000Z" },
          answer: { after: 30, limit: 10, rows: [], next: null, answeredAt: "2026-11-05T09:55:00.000Z" },
        },
      ],
    } as never);
    const body = await (await GET(new Request(url))).json();
    expect(body.supported).toBe(true);
    expect(body.request).toEqual({ after: 40, limit: 10, requestedAt: "2026-11-05T10:00:00.000Z" });
    expect(body.answer.next).toBeNull();
    expect(body.maxPageSize).toBe(25);
  });

  it("records one page request and audits it without touching the plugin", async () => {
    const response = await post({ connectionId: CONNECTION_ID, after: 20, limit: 500 });
    expect(response.status).toBe(200);
    const body = await response.json();
    // The ceiling is the plugin's: the app never asks for more than it sends.
    expect(body.request).toMatchObject({ after: 20, limit: 25 });
    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(String(sql)).toContain("plugin_local_queue_request");
    expect(JSON.parse(String((params as unknown[])[2]))).toMatchObject({ after: 20, limit: 25 });
    expect(audit.writeIntegrationAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "plugin.local_queue_page_requested", connectionId: CONNECTION_ID }),
    );
  });

  it("refuses an impossible cursor or page size", async () => {
    const response = await post({ connectionId: CONNECTION_ID, after: -5, limit: 10 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_page_request" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses a request while the connection is paused", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue({ ...capable, status: "paused" } as never);
    const response = await post({ connectionId: CONNECTION_ID, after: 0, limit: 10 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "connection_paused" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("hides a connection outside the caller's scope", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(null as never);
    expect((await GET(new Request(url))).status).toBe(404);
    expect((await post({ connectionId: CONNECTION_ID, after: 0, limit: 10 })).status).toBe(404);
  });

  it("requires a connection id", async () => {
    const response = await GET(new Request("http://localhost/api/integrations/wp-manager/queue/local"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "missing_connection" });
  });
});
