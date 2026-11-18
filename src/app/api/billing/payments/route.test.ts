import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * ESH-199 × ESH-193 — the commercial purchase boundary's phone gate.
 *
 * `purchaseReadiness` is tested as a pure rule in
 * `src/lib/identity-billing-contract.test.ts`. What matters here is that the
 * route *calls it before creating a payment*: a checkout that quotes an
 * unverified identity and only discovers the requirement at settlement would
 * be the duplicated, drifting check the shared contract exists to prevent.
 */

type AnyFn = ReturnType<typeof vi.fn>;

const mocks = vi.hoisted(() => ({
  readPlatformIdentityAssurance: vi.fn() as AnyFn,
  createPayment: vi.fn(async () => ({ id: "pay-1", amountRial: 1000 })) as AnyFn,
  startPayment: vi.fn(async () => ({ redirectUrl: null, gateway: "manual" })) as AnyFn,
  listCreditPackages: vi.fn(async () => [] as unknown[]) as AnyFn,
  readCommercialSettings: vi.fn(async () => ({
    tax_rate_bps: 0,
    rounding: "ceil",
    minimum_top_up_rial: 1000,
  })) as AnyFn,
  listBillingPlans: vi.fn(async () => [] as unknown[]) as AnyFn,
  listPlanFeatures: vi.fn(async () => [] as unknown[]) as AnyFn,
  calculateSubscriptionTotal: vi.fn() as AnyFn,
  requirePermission: vi.fn() as AnyFn,
  query: vi.fn() as AnyFn,
  loadQuote: vi.fn() as AnyFn,
  assertQuotePayable: vi.fn() as AnyFn,
  consumeQuote: vi.fn() as AnyFn,
}));

vi.mock("@/lib/db", () => ({ query: mocks.query }));

vi.mock("@/lib/billing/quote/quote-store", () => ({
  loadQuote: mocks.loadQuote,
  assertQuotePayable: mocks.assertQuotePayable,
  consumeQuote: mocks.consumeQuote,
}));

vi.mock("@/lib/auth", () => ({
  // The route is written for `withTenantScope`; the test supplies the session
  // the real wrapper would have resolved.
  withTenantScope: (handler: (req: Request) => Promise<Response>) => handler,
  requirePermission: mocks.requirePermission,
}));

vi.mock("@/lib/iam/global-identity-service", () => ({
  readPlatformIdentityAssurance: mocks.readPlatformIdentityAssurance,
}));

vi.mock("@/lib/wallet-service", () => ({
  countPayments: vi.fn(),
  createPayment: mocks.createPayment,
  getPaymentConfig: vi.fn(),
  listCreditPackages: mocks.listCreditPackages,
  listPayments: vi.fn(),
  startPayment: mocks.startPayment,
}));

vi.mock("@/lib/billing-plans-service", () => ({
  listBillingPlans: mocks.listBillingPlans,
  listPlanFeatures: mocks.listPlanFeatures,
}));

vi.mock("@/lib/subscription-service", () => ({
  calculateSubscriptionTotal: mocks.calculateSubscriptionTotal,
  getBusinessSubscription: vi.fn(),
}));

vi.mock("@/lib/billing/runtime", () => ({
  readCommercialSettings: mocks.readCommercialSettings,
}));

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/billing/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const session = {
  sub: "user-1",
  businessId: "11111111-1111-1111-1111-111111111111",
  platformUserId: "22222222-2222-2222-2222-222222222222",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ session, error: null });
  mocks.createPayment.mockResolvedValue({ id: "pay-1", amountRial: 1000 });
  mocks.startPayment.mockResolvedValue({ redirectUrl: null, gateway: "manual" });
  mocks.listCreditPackages.mockResolvedValue([]);
  mocks.readCommercialSettings.mockResolvedValue({
    tax_rate_bps: 0,
    rounding: "ceil",
    minimum_top_up_rial: 1000,
  });
});

describe("POST /api/billing/payments — verified-phone precondition", () => {
  it("refuses an unverified identity before creating a payment", async () => {
    mocks.readPlatformIdentityAssurance.mockResolvedValue({
      phone: { e164: null, verified: false },
      email: { address: "owner@example.com", verified: true },
    });

    const { POST } = await import("./route");
    const response = await POST(post({ kind: "unknown" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "phone_verification_required",
      blockedBy: ["phone_not_verified"],
    });
    expect(mocks.createPayment).not.toHaveBeenCalled();
  });

  it("fails closed when the session has no global identity", async () => {
    mocks.requirePermission.mockResolvedValue({
      session: { ...session, platformUserId: null },
      error: null,
    });

    const { POST } = await import("./route");
    const response = await POST(post({ kind: "topup", amountRial: 10_000 }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "phone_verification_required",
      blockedBy: ["phone_not_verified"],
    });
    expect(mocks.readPlatformIdentityAssurance).not.toHaveBeenCalled();
    expect(mocks.createPayment).not.toHaveBeenCalled();
  });

  it("lets a verified mobile through to the ordinary validation", async () => {
    mocks.readPlatformIdentityAssurance.mockResolvedValue({
      phone: { e164: "+989121234567", verified: true },
      email: { address: "owner@example.com", verified: true },
    });

    const { POST } = await import("./route");
    // An unknown kind is a harmless way to prove the gate opened: it returns
    // the route's own bad_request instead of the phone refusal.
    const response = await POST(post({ kind: "unknown" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(mocks.readPlatformIdentityAssurance).toHaveBeenCalledWith(session.platformUserId);
    expect(mocks.createPayment).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/payments - wallet checkout", () => {
  it("preserves the shared payment status when a concurrent settlement wins", async () => {
    mocks.readPlatformIdentityAssurance.mockResolvedValue({ phone: { e164: "+989121234567", verified: true } });
    mocks.listBillingPlans.mockResolvedValue([{ key: "pro", name: "Pro" }]);
    mocks.loadQuote.mockResolvedValue({
      id: "quote-1",
      quote: { planKey: "pro", termMonths: 1, totals: { netRial: 1000 } },
    });
    mocks.assertQuotePayable.mockResolvedValue({ ok: true });
    mocks.consumeQuote.mockResolvedValue({ ok: false, error: "settlement_conflict" });

    const { POST } = await import("./route");
    const response = await POST(post({ kind: "plan", planKey: "pro", quoteId: "quote-1", payWithWallet: true }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "settlement_conflict", quoteId: "quote-1" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("AND status = 'failed'"), ["pay-1"]);
  });
});
