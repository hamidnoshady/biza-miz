import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1388 — the provisioning act at the end of the public signup flow is
 * closed when registration is administratively disabled or paused for
 * maintenance. Reading and saving drafts stay available so progress is not
 * lost; only creating the business is refused.
 */
const mocks = vi.hoisted(() => ({
  loadSignupGate: vi.fn(),
  submitOnboarding: vi.fn(),
  readOnboardingIdentity: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => ({ value: "continuation-token" }) })),
}));

vi.mock("@/lib/iam/signup-controls", () => ({
  loadSignupGate: mocks.loadSignupGate,
  signupGateError: (reason: string) =>
    reason === "maintenance" ? "signup_maintenance" : "signup_disabled",
}));

vi.mock("@/lib/iam/onboarding-session", () => ({
  ONBOARDING_COOKIE: "pos_onboarding",
  onboardingCookieOptions: () => ({}),
  signOnboardingToken: vi.fn(),
  readOnboardingIdentity: mocks.readOnboardingIdentity,
}));

vi.mock("@/lib/onboarding", () => ({
  loadOnboardingState: vi.fn(),
  removeOnboardingLogo: vi.fn(),
  saveOnboardingLogo: vi.fn(),
  saveOnboardingStep: vi.fn(),
  submitOnboarding: mocks.submitOnboarding,
}));

vi.mock("@/lib/business-logo", () => ({
  buildBusinessLogo: vi.fn(),
  hasMatchingLogoSignature: vi.fn(),
  isLogoMimeType: vi.fn(),
  isValidLogo: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ withTenant: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "pos_session",
  sessionCookieOptions: () => ({}),
  signSession: vi.fn(),
}));
vi.mock("@/lib/employee-service", () => ({ createSession: vi.fn() }));
vi.mock("@/lib/ai-gateway-service", () => ({ autoProvisionBusinessVirtualKey: vi.fn() }));
vi.mock("@/lib/iam/signup-events", () => ({ recordSignupEvent: vi.fn() }));

import { POST } from "./route";

const accountId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readOnboardingIdentity.mockResolvedValue(accountId);
});

function submit(): Request {
  return new Request("http://test.local/api/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "submit" }),
  });
}

describe("POST /api/onboarding action=submit gate", () => {
  it("refuses provisioning during a maintenance pause and keeps the draft", async () => {
    mocks.loadSignupGate.mockResolvedValue({
      enabled: false,
      reason: "maintenance",
      source: "runtime",
      controls: null,
      readable: true,
    });

    const res = await POST(submit());
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body).toMatchObject({ error: "signup_maintenance", next: "/signup" });
    expect(body.message).toContain("ذخیره");
    expect(mocks.submitOnboarding).not.toHaveBeenCalled();
  });

  it("refuses an administratively disabled door with no internal detail", async () => {
    mocks.loadSignupGate.mockResolvedValue({
      enabled: false,
      reason: "administratively_disabled",
      source: "runtime",
      controls: null,
      readable: true,
    });

    const res = await POST(submit());
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toBe("signup_disabled");
    expect(JSON.stringify(body)).not.toMatch(/kavenegar|provider|key/i);
    expect(mocks.submitOnboarding).not.toHaveBeenCalled();
  });
});
