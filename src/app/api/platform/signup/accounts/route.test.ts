import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Issue #1388 — the account inspector.
 *
 * Search is masked and `signup.read`; the unmasked reveal needs
 * `signup.inspect`, is rate limited, and is audited before the answer. Both
 * halves never carry a code, a password or a national ID.
 */
const mocks = vi.hoisted(() => ({
  requirePlatformCapability: vi.fn(),
  platformAudit: vi.fn(),
  reserveSignupInspection: vi.fn(),
  findSignupAccount: vi.fn(),
  revealSignupAccountContact: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (handler: unknown) => handler,
  requirePlatformCapability: mocks.requirePlatformCapability,
  platformAudit: mocks.platformAudit,
}));

vi.mock("@/lib/iam/signup-controls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/iam/signup-controls")>();
  return { ...actual, reserveSignupInspection: mocks.reserveSignupInspection };
});

vi.mock("@/lib/iam/signup-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/iam/signup-events")>();
  return {
    ...actual,
    findSignupAccount: mocks.findSignupAccount,
    revealSignupAccountContact: mocks.revealSignupAccountContact,
  };
});

import { GET, POST } from "./route";

const admin = { padmin: "22222222-2222-4222-8222-222222222222" };
const accountId = "11111111-1111-4111-8111-111111111111";
const masked = {
  accountId,
  fullName: "نگار احمدی",
  maskedPhone: "+989***4567",
  maskedEmail: "n***@example.com",
  isActive: true,
  phoneVerified: true,
  emailVerified: false,
  createdAt: "2026-11-20T10:00:00.000Z",
  onboarding: { started: true, submitted: false, provisionedBusinessId: null },
  memberships: [],
};

function get(id: string): NextRequest {
  return new NextRequest(
    `http://test.local/api/platform/signup/accounts?accountId=${encodeURIComponent(id)}`,
  );
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/platform/signup/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformCapability.mockResolvedValue({ session: admin, error: null });
  mocks.reserveSignupInspection.mockResolvedValue({ allowed: true });
  mocks.findSignupAccount.mockResolvedValue(masked);
  mocks.revealSignupAccountContact.mockResolvedValue({
    accountId,
    fullName: "نگار احمدی",
    phone: "+989121234567",
    email: "negar@example.com",
  });
});

describe("GET /api/platform/signup/accounts", () => {
  it("requires signup.read and accepts only a full account uuid", async () => {
    const res = await GET(get("negar@example.com"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_account_id" });
    expect(mocks.findSignupAccount).not.toHaveBeenCalled();
    expect(mocks.requirePlatformCapability).toHaveBeenCalledWith("signup.read");
  });

  it("returns the masked account and applies the per-admin budget", async () => {
    const res = await GET(get(accountId));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.account).toEqual(masked);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(body)).not.toContain("+989121234567");
    expect(mocks.reserveSignupInspection).toHaveBeenCalledWith(admin.padmin);
  });

  it("answers 429 with retry information when the budget is spent", async () => {
    mocks.reserveSignupInspection.mockResolvedValue({ allowed: false, retryAfterMs: 42_000 });

    const res = await GET(get(accountId));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(mocks.findSignupAccount).not.toHaveBeenCalled();
  });

  it("returns 404 for a well-formed id with no account", async () => {
    mocks.findSignupAccount.mockResolvedValue(null);
    const res = await GET(get(accountId));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/platform/signup/accounts", () => {
  it("requires the owner-only signup.inspect capability", async () => {
    const forbidden = NextResponse.json({ error: "forbidden" }, { status: 403 });
    mocks.requirePlatformCapability.mockResolvedValue({ session: null, error: forbidden });

    const res = await POST(post({ accountId }));
    expect(res.status).toBe(403);
    expect(mocks.requirePlatformCapability).toHaveBeenCalledWith("signup.inspect");
    expect(mocks.revealSignupAccountContact).not.toHaveBeenCalled();
  });

  it("audits the reveal with the fields and reason, never the values", async () => {
    const res = await POST(post({ accountId, reason: "پیگیری تیکت" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.contact.phone).toBe("+989121234567");
    expect(mocks.platformAudit).toHaveBeenCalledTimes(1);
    const audit = mocks.platformAudit.mock.calls[0][0];
    expect(audit).toMatchObject({
      adminId: admin.padmin,
      action: "signup.account.reveal",
      entity: "platform_user",
      entityId: accountId,
      payload: { fields: ["phone", "email"], reason: "پیگیری تیکت" },
    });
    expect(JSON.stringify(audit.payload)).not.toContain("+989121234567");
    expect(JSON.stringify(audit.payload)).not.toContain("negar@example.com");
  });

  it("does not audit a reveal that found nothing", async () => {
    mocks.revealSignupAccountContact.mockResolvedValue(null);
    const res = await POST(post({ accountId }));
    expect(res.status).toBe(404);
    expect(mocks.platformAudit).not.toHaveBeenCalled();
  });
});
