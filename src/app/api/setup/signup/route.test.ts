import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #1388 — the legacy email signup is a public registration entry point
 * and enforces the same runtime control as the phone-first door. A hidden form
 * is not enforcement.
 */
const mocks = vi.hoisted(() => ({
  loadSignupGate: vi.fn(),
  provisionBusiness: vi.fn(),
}));

vi.mock("@/lib/iam/signup-controls", () => ({
  loadSignupGate: mocks.loadSignupGate,
  signupGateError: (reason: string) =>
    reason === "maintenance" ? "signup_maintenance" : "signup_disabled",
}));

vi.mock("@/lib/business-provisioning", () => {
  class EmailPasswordMismatchError extends Error {}
  return {
    EmailPasswordMismatchError,
    provisionBusiness: mocks.provisionBusiness,
    validateProvisionBody: () => ({ input: {}, error: null }),
  };
});

vi.mock("@/lib/ai-gateway-service", () => ({ autoProvisionBusinessVirtualKey: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "pos_session",
  sessionCookieOptions: () => ({}),
  signSession: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ withTenant: vi.fn() }));
vi.mock("@/lib/employee-service", () => ({ createSession: vi.fn() }));

import { POST } from "./route";

function request(): NextRequest {
  return new NextRequest("http://test.local/api/setup/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessName: "کافه",
      ownerName: "مالک",
      email: "owner@example.com",
      password: "correct-horse",
      ownerPhone: "09121234567",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/setup/signup gate", () => {
  it("refuses an administratively disabled door before validating the body", async () => {
    mocks.loadSignupGate.mockResolvedValue({
      enabled: false,
      reason: "administratively_disabled",
      source: "runtime",
      controls: null,
      readable: true,
    });

    const res = await POST(request());
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "signup_disabled",
      reason: "administratively_disabled",
    });
    expect(mocks.provisionBusiness).not.toHaveBeenCalled();
  });

  it("refuses a maintenance pause with its own code and no provider detail", async () => {
    mocks.loadSignupGate.mockResolvedValue({
      enabled: false,
      reason: "maintenance",
      source: "runtime",
      controls: null,
      readable: true,
    });

    const res = await POST(request());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("signup_maintenance");
    expect(JSON.stringify(body)).not.toMatch(/kavenegar|provider|key/i);
  });
});
