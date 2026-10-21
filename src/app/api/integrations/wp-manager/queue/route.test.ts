import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as connectionsService from "@/lib/integrations/connections-service";
import * as wpManagerService from "@/lib/integrations/wp-manager-service";
import { GET, POST } from "./route";

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
  wpQueuePage: vi.fn(),
  wpQueueSummary: vi.fn(),
  wpQueueMaxAttempts: (mode: string) => (mode === "plugin" ? 6 : 8),
  retryWpQueueRow: vi.fn(),
  resolveWpQueueReview: vi.fn(),
  verifyWpQueueReview: vi.fn(),
  retryAllFailedWpQueue: vi.fn(),
  flushWpOutbox: vi.fn(),
}));

const SESSION = {
  businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
  role: "owner",
};

const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";

const MOCK_CONNECTION = {
  id: CONNECTION_ID,
  business_id: SESSION.businessId,
  provider: "woocommerce",
  status: "active",
  link_mode: "plugin",
};

beforeEach(() => {
  vi.clearAllMocks();
  // The queue's GET reads on `website.view` and its writes on `website.manage`
  // (it retries and cancels jobs that push stock and prices to the live shop).
  // The mock grants both; wp-routes.ts is where the split itself is pinned.
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionsService.getConnection).mockResolvedValue(MOCK_CONNECTION as never);
});

describe("GET /api/integrations/wp-manager/queue", () => {
  it("returns 400 when connectionId is missing", async () => {
    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "missing_connection" });
  });

  it("returns 404 when connection is not found or not woocommerce", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValueOnce(null as never);
    const req = new Request(`http://localhost:3000/api/integrations/wp-manager/queue?connectionId=${CONNECTION_ID}`);
    const res = await GET(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
  });

  it("returns rows and summary for valid connection and passes filters", async () => {
    const mockRows = [
      {
        id: "job-1",
        direction: "out",
        kind: "stock",
        status: "pending",
        remoteId: "5001",
        error: null,
        attempts: 0,
        createdAt: "2026-09-18T10:00:00Z",
      },
    ];

    const mockSummary = {
      total: 1,
      open: 1,
      pending: 1,
      processing: 0,
      failed: 0,
      dead: 0,
      needsReview: 0,
      skipped: 0,
      sent: 0,
      deferred: 0,
      inboundFailed: 0,
      outboundFailed: 0,
      oldestOpenAt: null,
      nextRetryAt: null,
    };

    vi.mocked(wpManagerService.wpQueuePage).mockResolvedValueOnce({
      rows: mockRows,
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    } as never);
    vi.mocked(wpManagerService.wpQueueSummary).mockResolvedValueOnce(mockSummary as never);

    const req = new Request(
      `http://localhost:3000/api/integrations/wp-manager/queue?connectionId=${CONNECTION_ID}&status=pending&direction=out&search=5001`,
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.summary).toEqual(mockSummary);
    // Issue #942 (F17/F16): the filtered total, page count and the attempt
    // cap of the connection's actual mode ride along with the rows.
    expect(body.total).toBe(1);
    expect(body.totalPages).toBe(1);
    expect(body.maxAttempts).toBe(6); // MOCK_CONNECTION is plugin mode
    expect(body.mode).toBe("plugin");
    expect(wpManagerService.wpQueuePage).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, {
      status: "pending",
      direction: "out",
      search: "5001",
      limit: undefined,
      page: 1,
      pageSize: 25,
    });
  });

  it("forwards server-side pagination parameters and reports the clamped page", async () => {
    vi.mocked(wpManagerService.wpQueuePage).mockResolvedValueOnce({
      rows: [],
      total: 40,
      page: 1, // the service clamped page 3 of an empty filter back to 1
      pageSize: 50,
      totalPages: 1,
    } as never);
    vi.mocked(wpManagerService.wpQueueSummary).mockResolvedValueOnce({
      total: 0,
      open: 0,
      pending: 0,
      processing: 0,
      failed: 0,
      dead: 0,
      needsReview: 0,
      skipped: 0,
      sent: 0,
      deferred: 0,
      inboundFailed: 0,
      outboundFailed: 0,
      oldestOpenAt: null,
      nextRetryAt: null,
    } as never);

    const req = new Request(
      `http://localhost:3000/api/integrations/wp-manager/queue?connectionId=${CONNECTION_ID}&page=3&pageSize=50`,
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.total).toBe(40);
    expect(wpManagerService.wpQueuePage).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, expect.objectContaining({
      page: 3,
      pageSize: 50,
    }));
  });
});

describe("POST /api/integrations/wp-manager/queue", () => {
  it("returns 400 on invalid JSON body", async () => {
    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid_json" });
  });

  it("refuses retry/flush data movement while the connection is paused", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValueOnce({ ...MOCK_CONNECTION, status: "paused" } as never);
    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({ action: "flush", connectionId: CONNECTION_ID }),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "connection_paused" });
    expect(wpManagerService.flushWpOutbox).not.toHaveBeenCalled();
  });

  it("retries a single queue row when action is retry", async () => {
    vi.mocked(wpManagerService.retryWpQueueRow).mockResolvedValueOnce({ ok: true, status: "pending" });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({
        action: "retry",
        connectionId: CONNECTION_ID,
        id: "row-123",
        direction: "out",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: "pending" });
    // The acting user rides along so the audit trail can name them (#942).
    expect(wpManagerService.retryWpQueueRow).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, "row-123", "out", SESSION.sub);
  });

  it("answers 409 with the row's real status when a retry is refused by state", async () => {
    vi.mocked(wpManagerService.retryWpQueueRow).mockResolvedValueOnce({
      ok: false,
      error: "not_retryable",
      status: "needs_review",
    });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({ action: "retry", connectionId: CONNECTION_ID, id: "row-9", direction: "out" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "not_retryable", status: "needs_review" });
  });

  it("resolves a needs_review row through the explicit resolution action", async () => {
    vi.mocked(wpManagerService.resolveWpQueueReview).mockResolvedValueOnce({ ok: true, status: "sent" });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({
        action: "resolve_review",
        connectionId: CONNECTION_ID,
        id: "row-7",
        resolution: "mark_sent",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "sent" });
    expect(wpManagerService.resolveWpQueueReview).toHaveBeenCalledWith(
      SESSION.businessId,
      CONNECTION_ID,
      "row-7",
      "mark_sent",
      SESSION.sub,
    );
  });

  it("runs the F11 verify probe for a needs_review row", async () => {
    vi.mocked(wpManagerService.verifyWpQueueReview).mockResolvedValueOnce({
      ok: true,
      verdict: "landed",
      detail: "بازپرداخت در فروشگاه ثبت شده است.",
    });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({ action: "verify_review", connectionId: CONNECTION_ID, id: "row-7" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, verdict: "landed", detail: "بازپرداخت در فروشگاه ثبت شده است." });
    expect(wpManagerService.verifyWpQueueReview).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, "row-7", SESSION.sub);
  });

  it("allows the read-only verify probe on a paused connection (F11)", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValueOnce({ ...MOCK_CONNECTION, status: "paused" } as never);
    vi.mocked(wpManagerService.verifyWpQueueReview).mockResolvedValueOnce({ ok: true, verdict: "unknown", detail: "…" });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({ action: "verify_review", connectionId: CONNECTION_ID, id: "row-7" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(wpManagerService.verifyWpQueueReview).toHaveBeenCalled();
  });

  it("answers 409 for a verify target that is not in review", async () => {
    vi.mocked(wpManagerService.verifyWpQueueReview).mockResolvedValueOnce({
      ok: false,
      error: "not_in_review",
      status: "sent",
    });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({ action: "verify_review", connectionId: CONNECTION_ID, id: "row-7" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "not_in_review", status: "sent" });
  });

  it("rejects a resolve_review without a known resolution", async () => {
    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({ action: "resolve_review", connectionId: CONNECTION_ID, id: "row-7", resolution: "whatever" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_resolution" });
    expect(wpManagerService.resolveWpQueueReview).not.toHaveBeenCalled();
  });

  it("retries one bounded batch and reports the partial outcome when action is retry_all", async () => {
    vi.mocked(wpManagerService.retryAllFailedWpQueue).mockResolvedValueOnce({
      ok: true,
      outboxRetried: 3,
      inboxRetried: 1,
      inboxFailed: 2,
      remaining: 40,
      hasMore: true,
    });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({
        action: "retry_all",
        connectionId: CONNECTION_ID,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, outboxRetried: 3, inboxRetried: 1, inboxFailed: 2, remaining: 40, hasMore: true });
    expect(wpManagerService.retryAllFailedWpQueue).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID);
  });

  it("flushes outbox queue when action is flush", async () => {
    vi.mocked(wpManagerService.flushWpOutbox).mockResolvedValueOnce({
      ok: true,
      mode: "plugin",
      message: "در حالت افزونه، کارهای در انتظار در درخواست بعدی ارسال می‌شوند.",
    });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({
        action: "flush",
        connectionId: CONNECTION_ID,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("plugin");
    expect(wpManagerService.flushWpOutbox).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID);
  });
});
