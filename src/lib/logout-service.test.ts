/**
 * Issue #854 follow-up — the server half of the sign-out contract, without a
 * database: what each revocation result maps to, and what the one response
 * shape sets on the wire. The database behaviour (atomic audit, retained
 * tokens, the retry ticket against real rows) is pinned in
 * `integration/profile-security-854.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const revoke = vi.hoisted(() => ({ revokeSession: vi.fn() }));
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

import { EmployeeError } from "./employee-service";
import { endSignedOutSession, logoutResponse } from "./logout-service";
import { readLogoutRetryTicket, type PendingRevocation } from "./logout-retry";

beforeAll(() => {
  process.env.JWT_SECRET ??= "unit-test-secret-0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  revoke.revokeSession.mockReset();
  vi.restoreAllMocks();
});

function entry(): PendingRevocation {
  return {
    sessionId: randomUUID(),
    businessId: randomUUID(),
    employeeId: randomUUID(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("endSignedOutSession", () => {
  it("revokes the caller's own row only, naming the path it came from", async () => {
    const e = entry();
    revoke.revokeSession.mockResolvedValue(undefined);
    await expect(endSignedOutSession(e, "sign_out")).resolves.toBe("revoked");
    expect(revoke.revokeSession).toHaveBeenCalledWith(e.sessionId, e.businessId, e.employeeId, {
      ownedBy: e.employeeId,
      via: "sign_out",
    });
  });

  it("reads a missing or already-revoked row as already ended", async () => {
    revoke.revokeSession.mockRejectedValue(new EmployeeError("employee_session_not_found", 404));
    await expect(endSignedOutSession(entry(), "sign_out_retry")).resolves.toBe("already_ended");
  });

  it("reads anything else as failed, and logs the message only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    revoke.revokeSession.mockRejectedValue(new Error("connection terminated"));
    await expect(endSignedOutSession(entry(), "sign_out")).resolves.toBe("failed");
    expect(log).toHaveBeenCalledWith("sign-out could not end the session:", "connection terminated");
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

  it("the retry route never touches the session cookie, and deletes a ticket it has finished", async () => {
    const res = await logoutResponse({ outcome: "revoked", stillPending: [], clearSessionCookie: false, hadTicket: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionCookieCleared: false });
    expect(res.cookies.get("pos_session")).toBeUndefined();
    expect(res.cookies.get("pos_logout_retry")).toMatchObject({ value: "", maxAge: 0, path: "/api/auth/logout" });
  });
});
