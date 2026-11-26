import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  readPlatformIdentityAssurance: vi.fn(),
  enforceCommercialServiceAccess: vi.fn(),
  activateService: vi.fn(),
  reenableService: vi.fn(),
  disableService: vi.fn(),
  purchaseServiceTerm: vi.fn(),
  quoteServiceTerm: vi.fn(),
  getServiceWizardState: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: <T>(fn: T) => fn,
}));

vi.mock("@/lib/iam/global-identity-service", () => ({
  readPlatformIdentityAssurance: mocks.readPlatformIdentityAssurance,
}));

vi.mock("@/lib/billing/resolver/access", () => ({
  enforceCommercialServiceAccess: mocks.enforceCommercialServiceAccess,
  resolveCommercialAvailability: vi.fn(),
}));

vi.mock("@/lib/billing/resolver/service", () => ({
  purchaseServiceTerm: mocks.purchaseServiceTerm,
  quoteServiceTerm: mocks.quoteServiceTerm,
}));

vi.mock("@/lib/service-activation/activation-service", () => ({
  activateService: mocks.activateService,
  reenableService: mocks.reenableService,
  disableService: mocks.disableService,
  getServiceActivation: vi.fn(),
  getServiceWizardState: mocks.getServiceWizardState,
  listServiceRuntimeSummary: vi.fn(),
  settleServiceRuntime: vi.fn(),
}));

vi.mock("@/lib/service-activation/pricing-service", () => ({
  quoteService: vi.fn(),
}));

vi.mock("@/lib/service-activation/retention-service", () => ({
  effectiveRetentionPolicy: vi.fn(),
  listServicePurgeJournal: vi.fn(),
  servicePurgePlan: vi.fn(),
}));

import { POST } from "./route";

const session = {
  sub: "user-1",
  platformUserId: "platform-user-1",
  businessId: "biz-1",
  role: "owner" as const,
};

function requestWith(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/services/app/crm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ kind: "app", key: "crm" }) };

describe("POST /api/services/[kind]/[key] — global identity purchaseReadiness gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({ session, error: null });
    mocks.enforceCommercialServiceAccess.mockResolvedValue({ allowed: true });
    mocks.getServiceWizardState.mockResolvedValue({ progress: {} });
  });

  it("refuses activate, reenable and term_purchase with 403 phone_verification_required when phone is unverified", async () => {
    mocks.readPlatformIdentityAssurance.mockResolvedValue({
      phone: { e164: "+989121234567", verified: false },
      email: { address: "owner@example.com", verified: true },
    });

    for (const payload of [
      { action: "activate" },
      { action: "reenable" },
      { action: "term_purchase", termMonths: 3, offerId: "offer-1", expectedNetRial: 1_000_000 },
    ]) {
      const res = await POST(requestWith(payload), ctx);
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        error: "phone_verification_required",
        blockedBy: ["phone_not_verified"],
      });
    }

    expect(mocks.enforceCommercialServiceAccess).not.toHaveBeenCalled();
    expect(mocks.activateService).not.toHaveBeenCalled();
    expect(mocks.reenableService).not.toHaveBeenCalled();
    expect(mocks.purchaseServiceTerm).not.toHaveBeenCalled();
  });

  it("refuses paid actions with phone_not_mobile when the identity holds a landline", async () => {
    mocks.readPlatformIdentityAssurance.mockResolvedValue({
      phone: { e164: "+982188776655", verified: true },
      email: { address: "owner@example.com", verified: true },
    });

    const res = await POST(
      requestWith({
        action: "term_purchase",
        termMonths: 3,
        offerId: "offer-1",
        expectedNetRial: 1_000_000,
      }),
      ctx,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "phone_verification_required",
      blockedBy: ["phone_not_mobile"],
    });
  });

  it("keeps disable and term_quote reachable even when the actor has no verified mobile", async () => {
    mocks.disableService.mockResolvedValue({ status: "already_disabled" });
    mocks.quoteServiceTerm.mockResolvedValue({ ok: true, netRial: 500_000 });

    const disableRes = await POST(requestWith({ action: "disable" }), ctx);
    expect(disableRes.status).toBe(200);
    expect(mocks.readPlatformIdentityAssurance).not.toHaveBeenCalled();

    const quoteRes = await POST(requestWith({ action: "term_quote", termMonths: 3 }), ctx);
    expect(quoteRes.status).toBe(200);
    expect(mocks.readPlatformIdentityAssurance).not.toHaveBeenCalled();
  });
});
