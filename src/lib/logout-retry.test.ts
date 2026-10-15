/**
 * Issue #854 follow-up — the sign-out retry ticket: it names only what the
 * signed session named, it cannot pass for a session, and it expires with the
 * session it names.
 */
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { signSession, verifySession } from "./auth-edge";
import { getRealmSecret } from "./jwt-secret";
import {
  logoutRetryCookieOptions,
  normalizePending,
  pendingRevocationKey,
  readLogoutRetryTicket,
  signLogoutRetryTicket,
  type PendingSessionRevocation,
  type PendingSupportRevocation,
} from "./logout-retry";

beforeAll(() => {
  process.env.JWT_SECRET ??= "unit-test-secret-0123456789abcdef0123456789abcdef";
});

const now = () => Math.floor(Date.now() / 1000);

function entry(overrides: Partial<PendingSessionRevocation> = {}): PendingSessionRevocation {
  return {
    kind: "employee_session",
    sessionId: randomUUID(),
    businessId: randomUUID(),
    employeeId: randomUUID(),
    expiresAt: now() + 3600,
    ...overrides,
  };
}

function grant(overrides: Partial<PendingSupportRevocation> = {}): PendingSupportRevocation {
  return {
    kind: "support_grant",
    grantId: randomUUID(),
    businessId: randomUUID(),
    adminId: randomUUID(),
    expiresAt: now() + 3600,
    ...overrides,
  };
}

describe("signLogoutRetryTicket / readLogoutRetryTicket", () => {
  it("round-trips the pending sessions and expires with the latest of them", async () => {
    const a = entry({ expiresAt: now() + 600 });
    const b = entry({ expiresAt: now() + 7200 });
    const ticket = await signLogoutRetryTicket([a, b]);
    expect(ticket).not.toBeNull();
    expect(ticket!.maxAgeSeconds).toBeGreaterThan(7000);
    expect(ticket!.maxAgeSeconds).toBeLessThanOrEqual(7200);
    await expect(readLogoutRetryTicket(ticket!.token)).resolves.toEqual([a, b]);
  });

  it("carries a pending support close next to a pending session", async () => {
    const a = entry();
    const b = grant();
    const ticket = await signLogoutRetryTicket([a, b]);
    await expect(readLogoutRetryTicket(ticket!.token)).resolves.toEqual([a, b]);
  });

  it("issues nothing when nothing is pending", async () => {
    await expect(signLogoutRetryTicket([])).resolves.toBeNull();
    await expect(signLogoutRetryTicket([entry({ expiresAt: now() - 1 })])).resolves.toBeNull();
  });

  it("a ticket is never a session: verifySession refuses it", async () => {
    const ticket = await signLogoutRetryTicket([entry()]);
    await expect(verifySession(ticket!.token)).resolves.toBeNull();
  });

  it("a session token is never a ticket", async () => {
    const token = await signSession({
      sub: randomUUID(),
      role: "cashier",
      businessId: randomUUID(),
      locationId: null,
      fullName: "x",
      employeeSessionId: randomUUID(),
    });
    await expect(readLogoutRetryTicket(token)).resolves.toEqual([]);
  });

  it("refuses a forged, tampered, malformed or missing ticket", async () => {
    const forged = await new SignJWT({ realm: "tenant.logout_retry", pending: [entry()] })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("not-the-real-secret-0123456789abcdef0123456789"));
    await expect(readLogoutRetryTicket(forged)).resolves.toEqual([]);

    const real = await signLogoutRetryTicket([entry()]);
    const [header, payload, signature] = real!.token.split(".");
    const tampered = `${header}.${payload.slice(0, -2)}AA.${signature}`;
    await expect(readLogoutRetryTicket(tampered)).resolves.toEqual([]);
    await expect(readLogoutRetryTicket("not-a-jwt")).resolves.toEqual([]);
    await expect(readLogoutRetryTicket(undefined)).resolves.toEqual([]);
  });

  it("drops entries that are not well-formed even inside a correctly signed ticket", async () => {
    const good = entry();
    const goodGrant = grant();
    const token = await new SignJWT({
      realm: "tenant.logout_retry",
      pending: [
        good,
        { ...good, sessionId: "not-a-uuid" },
        { sessionId: randomUUID() },
        // No kind: an entry must say what it ends.
        { sessionId: randomUUID(), businessId: randomUUID(), employeeId: randomUUID(), expiresAt: now() + 60 },
        // A kind with the other kind's fields.
        { ...goodGrant, kind: "employee_session" },
        { ...goodGrant, adminId: "not-a-uuid" },
        { ...goodGrant, kind: "something_else" },
        goodGrant,
      ],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(await getRealmSecret("tenant"));
    await expect(readLogoutRetryTicket(token)).resolves.toEqual([good, goodGrant]);
  });
});

describe("normalizePending", () => {
  it("drops expired entries, de-duplicates by session and keeps the newest five", () => {
    const sessionId = randomUUID();
    const older = entry({ sessionId, expiresAt: now() + 100 });
    const newer = entry({ sessionId, expiresAt: now() + 200 });
    const many = Array.from({ length: 7 }, () => entry());
    const result = normalizePending([entry({ expiresAt: now() - 5 }), older, newer, ...many]);
    expect(result).toHaveLength(5);
    expect(result.some((p) => p.kind === "employee_session" && p.sessionId === sessionId)).toBe(false);
    expect(result).toEqual(many.slice(-5));
  });

  it("de-duplicates by what an entry ends, so a session and a grant with the same id are both kept", () => {
    const id = randomUUID();
    const session = entry({ sessionId: id });
    const support = grant({ grantId: id });
    expect(normalizePending([session, support])).toEqual([session, support]);
    expect(pendingRevocationKey(session)).not.toBe(pendingRevocationKey(support));
  });

  it("a repeated entry counts as the newest", () => {
    const repeated = grant();
    const others = Array.from({ length: 5 }, () => entry());
    const result = normalizePending([repeated, ...others, { ...repeated, expiresAt: now() + 9000 }]);
    expect(result).toHaveLength(5);
    expect(result.at(-1)).toEqual({ ...repeated, expiresAt: expect.any(Number) });
    expect(result.at(-1)!.expiresAt).toBeGreaterThan(now() + 8000);
  });
});

describe("logoutRetryCookieOptions", () => {
  it("is httpOnly, SameSite=Strict and scoped to the sign-out routes", () => {
    expect(logoutRetryCookieOptions(120)).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      path: "/api/auth/logout",
      maxAge: 120,
    });
  });
});
