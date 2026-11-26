import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1386 — removing a passkey is an MFA downgrade, so it uses the sensitive
 * guard: an OTP-only session (SMS possession alone) cannot remove one while
 * the account holds a TOTP. The guard and policy are the real ones; only the
 * factor read and the revocation are mocked.
 */
type AnyFn = ReturnType<typeof vi.fn>;

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn() as AnyFn,
  revokeCredential: vi.fn(async () => undefined) as AnyFn,
  getAccountMfaEnrolments: vi.fn() as AnyFn,
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/employee-service", () => ({
  EmployeeError: class EmployeeError extends Error {
    status = 400;
  },
  revokeCredential: mocks.revokeCredential,
}));
vi.mock("@/lib/webauthn-access", () => ({
  resolveWebauthnPolicy: async () => ({}),
  webauthnPolicyDenial: () => null,
}));
vi.mock("@/lib/mfa-service", async () => {
  const { isActiveMfaEnrolment } = await vi.importActual<typeof import("@/lib/mfa")>("@/lib/mfa");
  return {
    getAccountMfaEnrolments: mocks.getAccountMfaEnrolments,
    filterActiveMfaEnrolments: (rows: unknown[]) =>
      rows.filter((row) => isActiveMfaEnrolment(row as never)),
  };
});

import { DELETE } from "./route";

const IDENTITY = "22222222-2222-4222-8222-222222222222";
const NOW = () => Math.floor(Date.now() / 1000);
const TOTP = {
  id: "totp-1",
  method: "totp",
  is_primary: true,
  phone_e164: null,
  confirmed_at: new Date("2026-11-01T00:00:00Z"),
  created_at: new Date("2026-11-01T00:00:00Z"),
};

function signedIn(claims: Record<string, unknown>) {
  mocks.requireMember.mockResolvedValue({
    session: { sub: "member-1", businessId: "biz-1", platformUserId: IDENTITY, ...claims },
    membership: { role: "owner" },
    error: null,
  });
}

async function removePasskey() {
  return (DELETE as unknown as (r: NextRequest, c: unknown) => Promise<Response>)(
    new NextRequest("http://test.local/api/auth/webauthn/credentials/cred-1", { method: "DELETE" }),
    { params: Promise.resolve({ credentialId: "cred-1" }) },
  );
}

beforeEach(() => {
  mocks.revokeCredential.mockClear();
  mocks.getAccountMfaEnrolments.mockReset();
  mocks.getAccountMfaEnrolments.mockResolvedValue([TOTP]);
});

describe("DELETE /api/auth/webauthn/credentials/[credentialId]", () => {
  it("refuses an OTP-only session on an account holding a TOTP, and revokes nothing", async () => {
    signedIn({ recentAuthAt: NOW(), otpOnlyAssurance: true });
    const res = await removePasskey();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "recent_auth_required",
      distinctFactorRequired: true,
      allowedMethods: ["totp", "recovery"],
    });
    expect(mocks.revokeCredential).not.toHaveBeenCalled();
  });

  it("removes the passkey once the distinct factor has been proved", async () => {
    signedIn({ recentAuthAt: NOW(), otpOnlyAssurance: false });
    const res = await removePasskey();
    expect(res.status).toBe(200);
    expect(mocks.revokeCredential).toHaveBeenCalledWith("cred-1", "biz-1", "member-1", "member-1");
  });

  it("still refuses a stale session with the plain recent-auth answer", async () => {
    signedIn({ recentAuthAt: NOW() - 60 * 60 });
    const res = await removePasskey();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "recent_auth_required" });
    expect(mocks.revokeCredential).not.toHaveBeenCalled();
  });
});
