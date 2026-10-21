import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET, POST } from "./route";

/**
 * Issue #984 — the customer's own ticket diagnostics. These tests pin the two
 * things this route must never lose: scope (the ticket and installation are
 * always resolved server-side from the member's session) and truthfulness
 * (a request the customer files is recorded as member-initiated, and a Stop
 * cancels only that ticket's own row).
 */

const mocks = vi.hoisted(() => {
  class TicketAccessError extends Error {}
  return {
  TicketAccessError,
  requireMember: vi.fn(),
  getMemberTicket: vi.fn(),
  listTicketDiagnosticRequests: vi.fn(),
  listTicketDiagnosticRuns: vi.fn(),
  getDiagnosticRequest: vi.fn(),
  transitionDiagnosticRequest: vi.fn(),
  createDiagnosticRequest: vi.fn(),
  listInstallations: vi.fn(),
  listTicketAssistanceSessions: vi.fn(),
  getAssistanceSession: vi.fn(),
  revokeAssistanceSession: vi.fn(),
  recordConsentEvent: vi.fn(),
  };
});

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requireMember: mocks.requireMember,
}));

vi.mock("@/lib/support-service", () => ({
  TicketAccessError: mocks.TicketAccessError,
  getMemberTicket: mocks.getMemberTicket,
}));

vi.mock("@/lib/support-companion/diagnostics", () => ({
  listTicketDiagnosticRequests: mocks.listTicketDiagnosticRequests,
  listTicketDiagnosticRuns: mocks.listTicketDiagnosticRuns,
  getDiagnosticRequest: mocks.getDiagnosticRequest,
  transitionDiagnosticRequest: mocks.transitionDiagnosticRequest,
  createDiagnosticRequest: mocks.createDiagnosticRequest,
}));

vi.mock("@/lib/support-companion/installations", () => ({
  listInstallations: mocks.listInstallations,
}));

vi.mock("@/lib/support-companion/assistance", () => ({
  listTicketAssistanceSessions: mocks.listTicketAssistanceSessions,
  getAssistanceSession: mocks.getAssistanceSession,
  revokeAssistanceSession: mocks.revokeAssistanceSession,
}));

vi.mock("@/lib/support-companion/consent", () => ({
  recordConsentEvent: mocks.recordConsentEvent,
}));

const ticketId = "550e8400-e29b-41d4-a716-446655440000";
const installationId = "6f3f0f7e-6a1a-4f3d-9d3e-2c1c0a1b2c3d";
const requestId = "1c9a1c9a-2b2b-4c4c-8d8d-3e3e3e3e3e3e";
const sessionId = "9d9d9d9d-8c8c-4b4b-8a8a-7f7f7f7f7f7f";

const session = { businessId: "business-1", sub: "member-1", role: "owner" as const };
const context = { params: Promise.resolve({ id: ticketId }) };

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/support/tickets/${ticketId}/diagnostics`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMember.mockResolvedValue({ session, error: null });
  mocks.getMemberTicket.mockResolvedValue({ id: ticketId, businessId: "business-1" });
  mocks.listTicketDiagnosticRequests.mockResolvedValue([]);
  mocks.listTicketDiagnosticRuns.mockResolvedValue([]);
  mocks.listTicketAssistanceSessions.mockResolvedValue([]);
  mocks.listInstallations.mockResolvedValue([]);
});

describe("GET /api/support/tickets/[id]/diagnostics", () => {
  it("returns the ticket's own history with only the customer-facing installation fields", async () => {
    mocks.listInstallations.mockResolvedValue([
      {
        id: installationId,
        businessId: "business-1",
        displayName: "صندوق فروش ۱",
        locationName: "شعبه مرکزی",
        enrollmentState: "active",
        generation: 4,
        mainVersion: "1.0.60",
        companionVersion: "1.0.2",
        lastContactAt: "2026-10-20T08:00:00.000Z",
        siteDeviceId: "device-1",
        meshNodeId: "node-7",
        schemaCompat: "0236",
        capabilities: { meshAgentPresent: true },
        platform: "windows",
        osBuild: "26100",
        locationId: "location-1",
        revokedAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-20T08:00:00.000Z",
      },
    ]);

    const response = (await GET(
      new NextRequest(`http://localhost/api/support/tickets/${ticketId}/diagnostics`),
      context,
    )) as Response;

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      installations: Record<string, unknown>[];
    };
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]).toMatchObject({
      id: installationId,
      displayName: "صندوق فروش ۱",
      enrollmentState: "active",
    });
    // Credentials, provider wiring and tenant ids stay server-side.
    expect(body.installations[0]).not.toHaveProperty("meshNodeId");
    expect(body.installations[0]).not.toHaveProperty("siteDeviceId");
    expect(body.installations[0]).not.toHaveProperty("capabilities");
    expect(body.installations[0]).not.toHaveProperty("businessId");
  });

  it("answers 404 for a ticket the member may not read", async () => {
    mocks.getMemberTicket.mockRejectedValue(new mocks.TicketAccessError("nope"));

    const response = (await GET(
      new NextRequest(`http://localhost/api/support/tickets/${ticketId}/diagnostics`),
      context,
    )) as Response;

    expect(response.status).toBe(404);
    expect(mocks.listInstallations).not.toHaveBeenCalled();
  });
});

describe("POST /api/support/tickets/[id]/diagnostics", () => {
  it("records a customer-filed request as member-initiated with a bounded operation set", async () => {
    mocks.createDiagnosticRequest.mockResolvedValue({
      ok: true,
      duplicate: false,
      request: { id: requestId, state: "pending" },
    });

    const response = (await POST(
      post({
        action: "request_diagnostics",
        installationId,
        reason: "برنامه باز نمی‌شود",
        modules: ["database", "startup"],
      }),
      context,
    )) as Response;

    expect(response.status).toBe(201);
    expect(mocks.createDiagnosticRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "business-1",
        ticketId,
        installationId,
        initiatedBy: "member",
        memberUserId: "member-1",
        reason: "برنامه باز نمی‌شود",
        allowedOperations: ["diagnostics.run", "report.upload"],
      }),
    );
  });

  it("refuses a request without a written reason", async () => {
    const response = (await POST(
      post({ action: "request_diagnostics", installationId, reason: "   " }),
      context,
    )) as Response;

    expect(response.status).toBe(400);
    expect(mocks.createDiagnosticRequest).not.toHaveBeenCalled();
  });

  it("reports an inactive installation as a conflict instead of a silent success", async () => {
    mocks.createDiagnosticRequest.mockResolvedValue({
      ok: false,
      error: "installation_not_active",
    });

    const response = (await POST(
      post({ action: "request_diagnostics", installationId, reason: "بررسی کن" }),
      context,
    )) as Response;

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "installation_not_active" });
  });

  it("stops only a request that belongs to this ticket", async () => {
    mocks.getDiagnosticRequest.mockResolvedValue({
      id: requestId,
      ticketId: "another-ticket",
      installationId,
    });

    const foreign = (await POST(
      post({ action: "stop_request", requestId }),
      context,
    )) as Response;
    expect(foreign.status).toBe(404);
    expect(mocks.transitionDiagnosticRequest).not.toHaveBeenCalled();
    expect(mocks.recordConsentEvent).not.toHaveBeenCalled();

    mocks.getDiagnosticRequest.mockResolvedValue({
      id: requestId,
      ticketId,
      installationId,
    });
    mocks.transitionDiagnosticRequest.mockResolvedValue({
      ok: true,
      request: { id: requestId, state: "cancelled" },
    });
    mocks.recordConsentEvent.mockResolvedValue({ ok: true, event: { id: "consent-1" } });

    const own = (await POST(post({ action: "stop_request", requestId }), context)) as Response;
    expect(own.status).toBe(200);
    expect(mocks.transitionDiagnosticRequest).toHaveBeenCalledWith(
      "business-1",
      requestId,
      "cancelled",
    );
    expect(mocks.recordConsentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "business-1", ticketId, subject: "diagnostics" }),
    );
  });

  it("stops a live assistance session from the customer's side", async () => {
    mocks.getAssistanceSession.mockResolvedValue({ id: sessionId, ticketId });
    mocks.revokeAssistanceSession.mockResolvedValue({
      ok: true,
      session: { id: sessionId, state: "revoked" },
    });

    const response = (await POST(
      post({ action: "stop_session", sessionId }),
      context,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.revokeAssistanceSession).toHaveBeenCalledWith(
      "business-1",
      sessionId,
      "customer",
      "customer_stop",
    );
  });

  it("rejects an unknown action without touching any service", async () => {
    const response = (await POST(post({ action: "run_shell" }), context)) as Response;

    expect(response.status).toBe(400);
    expect(mocks.createDiagnosticRequest).not.toHaveBeenCalled();
    expect(mocks.revokeAssistanceSession).not.toHaveBeenCalled();
  });

  it("returns the member guard's response before reading the ticket", async () => {
    const denied = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    mocks.requireMember.mockResolvedValue({ session: null, error: denied });

    const response = (await POST(
      post({ action: "request_diagnostics", installationId, reason: "بررسی" }),
      context,
    )) as Response;

    expect(response.status).toBe(401);
    expect(mocks.getMemberTicket).not.toHaveBeenCalled();
  });
});
