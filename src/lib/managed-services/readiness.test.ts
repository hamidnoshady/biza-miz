/**
 * Issue #902 §9 item 5 — the contract, applied per integration.
 *
 * Two kinds of assertion, for two different failures:
 *
 *   1. **The translation is right.** Each adapter is a table, so it is tested like
 *      one: every internal reason it can be handed maps to the sentence a tenant
 *      reads, and the *order* is asserted — our setup comes before their plan,
 *      because "buy a plan" for a service we cannot run is the one sentence this
 *      vocabulary must never produce.
 *   2. **Nothing internal survives the translation.** Every view each integration
 *      can produce is walked by the same leak guard the API uses, and its JSON is
 *      searched for the internal reason strings themselves. A mapping that got the
 *      status right but forwarded `missing_runtime_credential` would pass a
 *      status-only test and fail a customer.
 */
import { describe, expect, it } from "vitest";
import {
  MANAGED_SERVICES,
  MANAGED_SERVICE_DETAILS,
  MANAGED_SERVICE_FAULTS,
  findTenantLeaks,
  toTenantManagedServiceView,
  type ManagedServiceDetailKey,
  type ManagedServiceDefinition,
  type TenantManagedServiceView,
} from "./contract";
import { SUPPLIER_NAME_PATTERN, managedInventoryEntry } from "./inventory";
import {
  aiDetailKey,
  aiPlatformDetailKey,
  emailDetailKey,
  entitlementDetailKey,
  mediaDetailKey,
  paymentDetailKey,
  type EntitlementFacts,
} from "./readiness";

const ALLOWED: EntitlementFacts = { allowed: true, reason: null };
const NOT_IN_PLAN: EntitlementFacts = { allowed: false, reason: "not_in_plan" };

/** Every state the contract can express — the domain every integration is walked over. */
const ALL_DETAIL_KEYS: ManagedServiceDetailKey[] = [
  "ready",
  "provisioning",
  "suspended_by_plan",
  "suspended_by_platform",
  "wallet_empty",
  "platform_setup_incomplete",
  "temporarily_unavailable",
  "needs_support",
  "usage_limit_reached",
  "no_access",
];

function view(definition: ManagedServiceDefinition, detailKey: ManagedServiceDetailKey): TenantManagedServiceView {
  return toTenantManagedServiceView({
    definition,
    detailKey,
    checkedAt: "2026-10-31T09:00:00.000Z",
  });
}

describe("the entitlement layer translates, in the order that matters", () => {
  it("says ready for an allowed capability, whatever else is true", () => {
    expect(entitlementDetailKey(ALLOWED)).toBe("ready");
    expect(entitlementDetailKey({ allowed: true, reason: "not_in_plan" })).toBe("ready");
  });

  it("separates the three ways a business cannot use something", () => {
    // Buy or upgrade a plan.
    for (const reason of ["subscription_expired", "not_in_plan", "addon_required"] as const) {
      expect(entitlementDetailKey({ allowed: false, reason })).toBe("suspended_by_plan");
    }
    // Top up the wallet.
    expect(entitlementDetailKey({ allowed: false, reason: "insufficient_credit" })).toBe("wallet_empty");
    // Ask for a higher ceiling — not a wallet problem.
    for (const reason of ["limit_reached", "spend_limit_reached"] as const) {
      expect(entitlementDetailKey({ allowed: false, reason })).toBe("usage_limit_reached");
    }
  });

  it("never blames the tenant for the platform's own state", () => {
    // A disabled app or a switched-off rollout is ours, and saying "check your
    // plan" would send the business to a page that cannot fix it.
    expect(entitlementDetailKey({ allowed: false, reason: "platform_unavailable" })).toBe(
      "temporarily_unavailable",
    );
    // A member without the permission is not a service fault either.
    expect(entitlementDetailKey({ allowed: false, reason: "permission_denied" })).toBe("no_access");
    // And a denial with no reason does not become "ready".
    expect(entitlementDetailKey({ allowed: false, reason: null })).toBe("needs_support");
  });
});

describe("AI: the platform's reason first, the plan second", () => {
  it("maps every runtime reason to a state a tenant can read", () => {
    const cases: [Parameters<typeof aiPlatformDetailKey>[0]["reason"], ManagedServiceDetailKey | null][] = [
      ["platform_disabled", "suspended_by_platform"],
      ["gateway_disabled", "suspended_by_platform"],
      ["missing_base_url", "platform_setup_incomplete"],
      ["invalid_base_url", "platform_setup_incomplete"],
      ["missing_runtime_credential", "platform_setup_incomplete"],
      ["missing_model", "platform_setup_incomplete"],
      ["invalid_max_output_tokens", "platform_setup_incomplete"],
      ["configuration_load_failed", "platform_setup_incomplete"],
      ["tenant_virtual_key_missing", "provisioning"],
      ["tenant_credential_undecryptable", "needs_support"],
      [null, "needs_support"],
    ];
    for (const [reason, expected] of cases) {
      expect(aiDetailKey({ entitlement: ALLOWED, platform: { ready: false, reason } }), String(reason)).toBe(expected);
    }
    // A ready platform defers to the commercial layer.
    expect(aiPlatformDetailKey({ ready: true, reason: null })).toBeNull();
    expect(aiDetailKey({ entitlement: NOT_IN_PLAN, platform: { ready: true, reason: null } })).toBe(
      "suspended_by_plan",
    );
  });

  it("never tells a business to buy a plan for a service we cannot run", () => {
    // The ordering rule, stated as one fixture: both halves broken.
    const both = aiDetailKey({
      entitlement: NOT_IN_PLAN,
      platform: { ready: false, reason: "missing_runtime_credential" },
    });
    expect(both).toBe("platform_setup_incomplete");
  });
});

describe("payments: online means a gateway with what it needs", () => {
  it("reports the platform's side when online payment is not set up", () => {
    expect(paymentDetailKey({ entitlement: ALLOWED, gateway: "manual", merchantConfigured: true })).toBe(
      "platform_setup_incomplete",
    );
    expect(paymentDetailKey({ entitlement: ALLOWED, gateway: "zarinpal", merchantConfigured: false })).toBe(
      "platform_setup_incomplete",
    );
    // Manual is a valid deployment, not a fault in the tenant's plan: even an
    // unentitled business is told the truth about whose side is missing.
    expect(paymentDetailKey({ entitlement: NOT_IN_PLAN, gateway: "manual", merchantConfigured: false })).toBe(
      "platform_setup_incomplete",
    );
  });

  it("defers to the plan once the gateway works", () => {
    expect(paymentDetailKey({ entitlement: NOT_IN_PLAN, gateway: "zarinpal", merchantConfigured: true })).toBe(
      "suspended_by_plan",
    );
    expect(paymentDetailKey({ entitlement: ALLOWED, gateway: "zarinpal", merchantConfigured: true })).toBe(
      "ready",
    );
  });
});

describe("media: switched on is not the same as configured", () => {
  it("requires the switch and a complete storage account", () => {
    expect(mediaDetailKey({ entitlement: ALLOWED, enabled: false, storageConfigured: true })).toBe(
      "platform_setup_incomplete",
    );
    expect(mediaDetailKey({ entitlement: ALLOWED, enabled: true, storageConfigured: false })).toBe(
      "platform_setup_incomplete",
    );
    expect(
      mediaDetailKey({ entitlement: NOT_IN_PLAN, enabled: true, storageConfigured: false }),
    ).toBe("platform_setup_incomplete");
    expect(mediaDetailKey({ entitlement: NOT_IN_PLAN, enabled: true, storageConfigured: true })).toBe(
      "suspended_by_plan",
    );
    expect(mediaDetailKey({ entitlement: ALLOWED, enabled: true, storageConfigured: true })).toBe("ready");
  });
});

describe("the email relay has two answers", () => {
  it("is ready when the deployment's relay exists, and ours to fix when it does not", () => {
    expect(emailDetailKey({ relayConfigured: true })).toBe("ready");
    expect(emailDetailKey({ relayConfigured: false })).toBe("platform_setup_incomplete");
  });
});

describe("no integration leaks through the contract", () => {
  const integrations = [
    MANAGED_SERVICES.messagingSms,
    MANAGED_SERVICES.messagingEmail,
    MANAGED_SERVICES.aiAssistant,
    MANAGED_SERVICES.paymentsGateway,
    MANAGED_SERVICES.mediaStorage,
  ];

  it("renders a first-party label and sentence for every state, per integration", () => {
    for (const definition of integrations) {
      for (const detailKey of ALL_DETAIL_KEYS) {
        const built = view(definition, detailKey);
        expect(built.service).toBe(definition.key);
        expect(built.label).toBe(definition.tenantLabel);
        expect(built.statusLabel).toBe(built.statusLabel.trim());
        expect(built.detail.length).toBeGreaterThan(0);
        expect(SUPPLIER_NAME_PATTERN.test(built.label), built.label).toBe(false);
        expect(SUPPLIER_NAME_PATTERN.test(built.detail), built.detail).toBe(false);
      }
    }
  });

  it("passes the same leak guard the API applies", () => {
    for (const definition of integrations) {
      for (const detailKey of ALL_DETAIL_KEYS) {
        const built = view(definition, detailKey);
        expect(findTenantLeaks(built), `${definition.key}/${detailKey}`).toEqual([]);
      }
    }
  });

  it("does not forward an internal reason as copy", () => {
    // The failure mode a status-only test misses: right state, supplier's own
    // vocabulary in the sentence.
    const reasons = [
      "missing_runtime_credential",
      "tenant_credential_undecryptable",
      "configuration_load_failed",
      "not_in_plan",
      "insufficient_credit",
      "spend_limit_reached",
      "zarinpal",
      "manual",
    ];
    for (const definition of integrations) {
      for (const detailKey of ALL_DETAIL_KEYS) {
        const serialised = JSON.stringify(view(definition, detailKey));
        for (const reason of reasons) {
          expect(serialised.includes(reason), `${definition.key}/${detailKey} leaked ${reason}`).toBe(false);
        }
      }
    }
  });

  it("links only to first-party screens the platform owns", () => {
    const allowed = new Set(["/settings/billing", "/growth/settings", "/support", "/dashboard"]);
    for (const definition of integrations) {
      for (const detailKey of ALL_DETAIL_KEYS) {
        const action = view(definition, detailKey).action;
        if (!action) continue;
        expect(allowed.has(action.href), action.href).toBe(true);
        expect(action.label.trim().length).toBeGreaterThan(0);
      }
    }
    // The two new states have the destinations their fix implies.
    expect(view(MANAGED_SERVICES.aiAssistant, "usage_limit_reached").action?.href).toBe("/support");
    // "No access" is granted by another member, not by a page: no link to offer.
    expect(view(MANAGED_SERVICES.aiAssistant, "no_access").action).toBeNull();
  });

  it("registers every managed service in the inventory and vice versa", () => {
    // The rollout's own guard: an integration cannot join `MANAGED_SERVICES`
    // without an inventory row, which is what keeps the audit honest.
    const keys = Object.values(MANAGED_SERVICES).map((definition) => definition.key);
    expect(keys).toEqual([
      "messaging.sms",
      "messaging.email",
      "ai.assistant",
      "payments.gateway",
      "media.storage",
    ]);
    for (const key of keys) {
      expect(managedInventoryEntry(key), `${key} is not in the inventory`).toBeDefined();
    }
  });

  it("keeps the fault taxonomy first-party too", () => {
    for (const fault of Object.values(MANAGED_SERVICE_FAULTS)) {
      expect(SUPPLIER_NAME_PATTERN.test(fault.tenantMessage), fault.tenantMessage).toBe(false);
    }
  });
});
