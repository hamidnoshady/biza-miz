import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1386 — recovery redemption must not mint a session, and every failure that
 * could describe account state collapses to `invalid_code`.
 */
const mocks = vi.hoisted(() => ({
  verifyPhonePasswordRecovery: vi.fn(),
}));

vi.mock("@/lib/password-recovery", () => ({
  verifyPhonePasswordRecovery: mocks.verifyPhonePasswordRecovery,
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://test.local/api/auth/password-recovery/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const BODY = {
  phone: "09120000001",
  code: "123456",
  newPassword: "a-new-password",
  confirmPassword: "a-new-password",
};

beforeEach(() => {
  mocks.verifyPhonePasswordRecovery.mockReset();
});

describe("password-recovery verify", () => {
  it("changes the password without issuing a session cookie", async () => {
    mocks.verifyPhonePasswordRecovery.mockResolvedValue({
      ok: true,
      tokenVersion: 4,
      revokedSessions: 3,
    });

    const res = await POST(request(BODY));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      passwordChanged: true,
      tokenVersion: 4,
      revokedSessions: 3,
    });
    expect(res.headers.getSetCookie?.() ?? []).toHaveLength(0);
  });

  it("answers a wrong code and a vanished identity identically", async () => {
    mocks.verifyPhonePasswordRecovery.mockResolvedValue({
      ok: false,
      error: "invalid_code",
    });
    const wrongCode = await POST(request(BODY));

    mocks.verifyPhonePasswordRecovery.mockResolvedValue({
      ok: false,
      error: "invalid_identity",
    });
    const vanished = await POST(request(BODY));

    expect(wrongCode.status).toBe(401);
    expect(vanished.status).toBe(401);
    expect(await wrongCode.json()).toEqual({ error: "invalid_code" });
    expect(await vanished.json()).toEqual({ error: "invalid_code" });
  });

  it("reports a weak password because the caller can act on it", async () => {
    mocks.verifyPhonePasswordRecovery.mockResolvedValue({
      ok: false,
      error: "password_too_short",
    });
    const res = await POST(request({ ...BODY, newPassword: "short", confirmPassword: "short" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "password_too_short" });
  });

  it("refuses a malformed phone as the caller's own error", async () => {
    mocks.verifyPhonePasswordRecovery.mockResolvedValue({
      ok: false,
      error: "invalid_phone",
    });
    const res = await POST(request({ ...BODY, phone: "x" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_phone" });
  });

  it("refuses a malformed body rather than throwing", async () => {
    const res = await POST(request("{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });
});
