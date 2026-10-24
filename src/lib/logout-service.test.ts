/**
 * Issue #854 follow-up — the server half of the sign-out contract, without a
 * database: what each revocation result maps to, and what the one response
 * shape sets on the wire. The database behaviour (atomic audit, retained
 * tokens, the retry ticket against real rows) is pinned in
 * `integration/profile-security-854.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const revoke = vi.hoisted(() => ({ revokeSession: vi.fn(), closeSupportSession: vi.fn() }));
vi.mock("./db", () => ({ withTenant: async (_businessId: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("./employee-service", () => {
  class EmployeeError extends Error {
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.status = status;
    }
  }
  return { EmployeeError, revokeSession: revoke.revokeSession };
});
vi.mock("./platform-service", () => ({ closeSupportSession: revoke.closeSupportSession }));

import type { SessionPayload } from "./auth-edge";
import { EmployeeError } from "./employee-service";
import { endPendingRevocation, logoutResponse, pendingRevocationFor } from "./logout-service";
import {
  readLogoutRetryTicket,
  type PendingSessionRevocation,
  type PendingSupportRevocation,
} from "./logout-retry";

beforeAll(() => {
  process.env.JWT_SECRET ??= "unit-test-secret-0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  revoke.revokeSession.mockReset();
  revoke.closeSupportSession.mockReset();
  vi.restoreAllMocks();
});

function entry(): PendingSessionRevocation {
  return {
    kind: "employee_session",
    sessionId: randomUUID(),
    businessId: randomUUID(),
    employeeId: randomUUID(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function grantEntry(): PendingSupportRevocation {
  return {
    kind: "support_grant",
    grantId: randomUUID(),
    businessId: randomUUID(),
    adminId: randomUUID(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

const headers = () =>
  new Headers({ "user-agent": "Vitest Browser", "x-forwarded-for": "203.0.113.7" });

function payload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sub: randomUUID(),
    role: "cashier",
    businessId: randomUUID(),
    locationId: null,
    fullName: "x",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

describe("pendingRevocationFor", () => {
  it("binds a member session to its own row, from the signed token only", () => {
    const session = payload({ employeeSessionId: randomUUID() });
    expect(pendingRevocationFor(session)).toEqual({
      kind: "employee_session",
      sessionId: session.employeeSessionId,
      businessId: session.businessId,
      employeeId: session.sub,
      expiresAt: session.exp,
    });
  });

  it("binds a support session to its grant and operator, never a row", () => {
    const grantId = randomUUID();
    const adminId = randomUUID();
    const session = payload({
      role: "owner",
      // A support token never carries a row id; if one were present the grant still wins.
      employeeSessionId: randomUUID(),
      imp: { grantId, adminId, mode: "read_only" } as SessionPayload["imp"],
    });
    expect(pendingRevocationFor(session)).toEqual({
      kind: "support_grant",
      grantId,
      businessId: session.businessId,
      adminId,
      expiresAt: session.exp,
    });
  });

  it("a legacy token bound to neither has nothing left to end", () => {
    expect(pendingRevocationFor(payload())).toBeNull();
  });

  it("falls back to a full session lifetime when the token carries no expiry", () => {
    const before = Math.floor(Date.now() / 1000);
    const result = pendingRevocationFor(payload({ exp: undefined, employeeSessionId: randomUUID() }));
    expect(result?.expiresAt).toBeGreaterThanOrEqual(before + 60 * 60);
  });
});

describe("endPendingRevocation", () => {
  it("revokes the caller's own row only, naming the path it came from", async () => {
    const e = entry();
    revoke.revokeSession.mockResolvedValue(undefined);
    await expect(endPendingRevocation(e, "sign_out", headers())).resolves.toBe("revoked");
    expect(revoke.revokeSession).toHaveBeenCalledWith(e.sessionId, e.businessId, e.employeeId, {
      ownedBy: e.employeeId,
      via: "sign_out",
    });
    expect(revoke.closeSupportSession).not.toHaveBeenCalled();
  });

  it("records a business switch as its own reason", async () => {
    const e = entry();
    revoke.revokeSession.mockResolvedValue(undefined);
    await expect(endPendingRevocation(e, "business_switch", headers())).resolves.toBe("revoked");
    expect(revoke.revokeSession).toHaveBeenCalledWith(e.sessionId, e.businessId, e.employeeId, {
      ownedBy: e.employeeId,
      via: "business_switch",
    });
  });

  it("reads a missing or already-revoked row as already ended", async () => {
    revoke.revokeSession.mockRejectedValue(new EmployeeError("employee_session_not_found", 404));
    await expect(endPendingRevocation(entry(), "sign_out_retry", headers())).resolves.toBe("already_ended");
  });

  it("reads anything else as failed, and logs the message only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    revoke.revokeSession.mockRejectedValue(new Error("connection terminated"));
    await expect(endPendingRevocation(entry(), "sign_out", headers())).resolves.toBe("failed");
    expect(log).toHaveBeenCalledWith("sign-out could not end the session:", "connection terminated");
  });

  it("closes a support grant as its own operator, inside its own business, through the banner's service", async () => {
    const g = grantEntry();
    revoke.closeSupportSession.mockResolvedValue({ status: "ended" });
    await expect(endPendingRevocation(g, "sign_out", headers())).resolves.toBe("revoked");
    expect(revoke.closeSupportSession).toHaveBeenCalledWith(
      g.grantId,
      { type: "operator", adminId: g.adminId, businessId: g.businessId },
      expect.objectContaining({ channel: "tenant_sign_out", userAgent: "Vitest Browser" }),
    );
    expect(revoke.revokeSession).not.toHaveBeenCalled();
  });

  it("names the retry channel on a retried support close", async () => {
    const g = grantEntry();
    revoke.closeSupportSession.mockResolvedValue({ status: "ended" });
    await endPendingRevocation(g, "sign_out_retry", headers());
    expect(revoke.closeSupportSession.mock.calls[0][2]).toMatchObject({ channel: "tenant_sign_out_retry" });
  });

  it.each(["expired", "not_active", "revoked"] as const)(
    "a grant that was already over (%s) is already ended",
    async (status) => {
      revoke.closeSupportSession.mockResolvedValue({ status });
      await expect(endPendingRevocation(grantEntry(), "sign_out", headers())).resolves.toBe("already_ended");
    },
  );

  it("a support close that throws (database, audit) is failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    revoke.closeSupportSession.mockRejectedValue(new Error("audit insert failed"));
    await expect(endPendingRevocation(grantEntry(), "sign_out", headers())).resolves.toBe("failed");
  });
});

describe("logoutResponse", () => {
  it("a confirmed sign-out: 200, the contract, the cookie cleared, nothing pending", async () => {
    const res = await logoutResponse({ outcome: "revoked", stillPending: [], clearSessionCookie: true, hadTicket: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "revoked", sessionCookieCleared: true, pendingRevocations: 0 });
    expect(res.cookies.get("pos_session")).toMatchObject({ value: "", maxAge: 0, httpOnly: true, path: "/" });
    expect(res.cookies.get("pos_logout_retry")).toBeUndefined();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("clears Telegram sessions with the same partitioned cookie attributes used at login", async () => {
    const res = await logoutResponse({
      outcome: "revoked",
      stillPending: [],
      clearSessionCookie: true,
      hadTicket: false,
      session: {
        telegramIdentityLinkId: randomUUID(),
        telegramIdentityGeneration: 1,
      },
    });
    expect(res.cookies.get("pos_session")).toMatchObject({
      value: "",
      maxAge: 0,
      secure: true,
      sameSite: "none",
      partitioned: true,
      path: "/",
    });
  });

  it("an unconfirmed sign-out: 503 with the Persian reason, and a retry ticket naming exactly the pending session", async () => {
    const pending = entry();
    const res = await logoutResponse({
      outcome: "unconfirmed",
      stillPending: [pending],
      clearSessionCookie: true,
      hadTicket: false,
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      outcome: "unconfirmed",
      sessionCookieCleared: true,
      pendingRevocations: 1,
      error: "logout_unconfirmed",
    });
    expect(body.message).toMatch(/از این دستگاه خارج شدید/);
    // The cookie still goes — the route's one unconditional job.
    expect(res.cookies.get("pos_session")?.value).toBe("");
    const ticket = res.cookies.get("pos_logout_retry");
    expect(ticket).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/api/auth/logout" });
    await expect(readLogoutRetryTicket(ticket?.value)).resolves.toEqual([pending]);
  });

  it("an earlier sign-out still pending makes a confirmed one unconfirmed too", async () => {
    const res = await logoutResponse({
      outcome: "revoked",
      stillPending: [entry()],
      clearSessionCookie: true,
      hadTicket: true,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, outcome: "unconfirmed", pendingRevocations: 1 });
  });

  it("carries a destination when the route names one, and only then", async () => {
    const res = await logoutResponse({
      outcome: "revoked",
      stillPending: [],
      clearSessionCookie: true,
      hadTicket: false,
      redirectTo: "/platform/businesses/abc/support",
    });
    expect(await res.json()).toMatchObject({ ok: true, redirectTo: "/platform/businesses/abc/support" });
    const plain = await logoutResponse({ outcome: "revoked", stillPending: [], clearSessionCookie: true, hadTicket: false });
    expect(await plain.json()).not.toHaveProperty("redirectTo");
  });

  it("a pending support close rides in the ticket like a pending session", async () => {
    const pending = grantEntry();
    const res = await logoutResponse({
      outcome: "unconfirmed",
      stillPending: [pending],
      clearSessionCookie: true,
      hadTicket: false,
    });
    expect(res.status).toBe(503);
    await expect(readLogoutRetryTicket(res.cookies.get("pos_logout_retry")?.value)).resolves.toEqual([pending]);
  });

  it("the retry route never touches the session cookie, and deletes a ticket it has finished", async () => {
    const res = await logoutResponse({ outcome: "revoked", stillPending: [], clearSessionCookie: false, hadTicket: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionCookieCleared: false });
    expect(res.cookies.get("pos_session")).toBeUndefined();
    expect(res.cookies.get("pos_logout_retry")).toMatchObject({ value: "", maxAge: 0, path: "/api/auth/logout" });
  });
});
