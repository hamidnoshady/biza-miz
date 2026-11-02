/**
 * Issue #902 — the managed-service contract's two promises:
 *
 *   1. A tenant-facing view can describe readiness without ever naming a
 *      supplier, and
 *   2. a payload that DOES name one (or carries a credential-shaped field) is
 *      caught by a check rather than shipped by accident.
 */
import { describe, expect, it } from "vitest";
import {
  MANAGED_SERVICES,
  MANAGED_SERVICE_DETAILS,
  MANAGED_SERVICE_STATUS_LABELS,
  ManagedServiceLeakError,
  assertTenantSafePayload,
  findTenantLeaks,
  managedServiceFault,
  redactManagedServiceText,
  statusForDetail,
  toTenantManagedServiceView,
  type ManagedServiceDetailKey,
} from "./contract";

describe("toTenantManagedServiceView", () => {
  it("renders a ready service with first-party wording only", () => {
    const view = toTenantManagedServiceView({
      definition: MANAGED_SERVICES.messagingSms,
      detailKey: "ready",
      checkedAt: new Date("2026-10-26T10:00:00.000Z"),
    });
    expect(view).toMatchObject({
      service: "messaging.sms",
      label: "پیامک",
      status: "ready",
      statusLabel: "آماده",
      action: null,
      retryable: false,
      checkedAt: "2026-10-26T10:00:00.000Z",
    });
    expect(view.detail).toBe(MANAGED_SERVICES.messagingSms.readyDetail);
  });

  it("offers a first-party destination only when the tenant can act", () => {
    const wallet = toTenantManagedServiceView({
      definition: MANAGED_SERVICES.messagingSms,
      detailKey: "wallet_empty",
    });
    expect(wallet).toMatchObject({
      status: "action_required",
      action: { href: "/settings/billing", blocking: true },
    });

    const plan = toTenantManagedServiceView({
      definition: MANAGED_SERVICES.messagingSms,
      detailKey: "suspended_by_plan",
    });
    expect(plan.action?.href).toBe("/settings/billing");

    const wait = toTenantManagedServiceView({
      definition: MANAGED_SERVICES.messagingSms,
      detailKey: "provisioning",
    });
    expect(wait.status).toBe("preparing");
    expect(wait.retryable).toBe(true);
    expect(wait.action).toBeNull();
  });

  it("maps every internal reason to one of the four tenant states", () => {
    const keys = Object.keys(MANAGED_SERVICE_DETAILS) as ManagedServiceDetailKey[];
    for (const key of keys) {
      const status = statusForDetail(key);
      expect(Object.keys(MANAGED_SERVICE_STATUS_LABELS)).toContain(status);
    }
  });

  it("never names a provider in any state, in any field", () => {
    for (const key of Object.keys(MANAGED_SERVICE_DETAILS) as ManagedServiceDetailKey[]) {
      const payload = toTenantManagedServiceView({
        definition: MANAGED_SERVICES.messagingSms,
        detailKey: key,
      });
      expect(findTenantLeaks(payload), `detail ${key} leaks`).toEqual([]);
      expect(JSON.stringify(payload)).not.toMatch(/kaveh|کاوه/i);
    }
  });

  it("exposes a Persian sentence for every fault, with no provider wording", () => {
    const fault = managedServiceFault("platform_credit_exhausted", "provider: status 418");
    expect(fault.tenantMessage).toContain("کیف پول");
    expect(fault.operatorDetail).toBe("provider: status 418");
    expect(fault.retryable).toBe(false);
  });
});

describe("findTenantLeaks", () => {
  it("passes a clean tenant payload", () => {
    expect(
      findTenantLeaks({
        config: { enabled: true, configured: true, rate: { smsRialPerSegment: 1500 } },
        service: { status: "ready", label: "پیامک" },
      }),
    ).toEqual([]);
  });

  it("flags provider-named fields even when their values look harmless", () => {
    const leaks = findTenantLeaks({ config: { kavenegarSender: "10004346" } });
    expect(leaks.map((leak) => leak.path)).toContain("config.kavenegarSender");
  });

  it("flags the provider's raw field spellings", () => {
    const leaks = findTenantLeaks({
      child: { apikey: "x", remaincredit: 25000, pricingname: "Price", localid: "L" },
    });
    expect(leaks.map((leak) => leak.reason)).toEqual([
      "forbidden_field",
      "forbidden_field",
      "forbidden_field",
      "forbidden_field",
    ]);
  });

  it("flags a supplier name inside a message, not just in a key", () => {
    const leaks = findTenantLeaks({ error: "Kavenegar error 418" });
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.reason).toBe("provider_name");
  });

  it("flags a token-shaped value", () => {
    const leaks = findTenantLeaks({ note: "please use 8A7SD878SDF76SDF876SDF876SDF" });
    expect(leaks.map((leak) => leak.reason)).toContain("credential_value");
  });

  it("does not mistake a UUID (a service/business id) for a credential", () => {
    expect(findTenantLeaks({ businessId: "0d5f4c7e-2e63-4e1f-9c8e-6e0f6f4a9b11" })).toEqual([]);
  });
});

describe("assertTenantSafePayload", () => {
  it("returns a clean payload untouched", () => {
    const payload = { service: { status: "ready" } };
    expect(assertTenantSafePayload(payload)).toBe(payload);
  });

  it("throws — loudly, with every path — when a payload would leak", () => {
    expect(() =>
      assertTenantSafePayload({
        config: { provider: "kavenegar", rate: { smsRialPerSegment: 1500 } },
      }),
    ).toThrow(ManagedServiceLeakError);

    try {
      assertTenantSafePayload({ api_key: "secret", child: { kavenegarKeyHint: "••••1234" } });
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedServiceLeakError);
      expect((error as ManagedServiceLeakError).leaks.map((leak) => leak.path)).toEqual([
        "api_key",
        "child.kavenegarKeyHint",
      ]);
    }
  });
});

describe("redactManagedServiceText", () => {
  it("removes the key path and secret query parameters", () => {
    const text = redactManagedServiceText(
      "kavenegar GET https://api.kavenegar.com/v1/SECRETKEY/client/fetch.json?apikey=CHILDKEY&password=pw",
    );
    expect(text).toContain("سرویس پیام‌رسانی");
    expect(text).not.toContain("SECRETKEY");
    expect(text).not.toContain("CHILDKEY");
    expect(text).not.toContain("password=pw");
  });
});
