/**
 * Issue #902 §9 item 5 — the contract, applied to the integrations that were not messaging.
 *
 * `contract.ts` says what a tenant may be told about a managed service and
 * `inventory.ts` says which services exist. Neither of them knows how *this*
 * integration is doing. That translation is what lives here, and it is pure: an
 * adapter hands in a handful of booleans and internal reasons, and gets back one
 * of the contract's detail keys. No database, no provider client, nothing to mock.
 *
 * The rule each adapter follows, in order:
 *
 *   1. **Our side first.** If the platform has not finished setting the service up,
 *      that is the answer — telling a business to buy a plan for something we
 *      cannot deliver yet is the one wrong sentence in this vocabulary. This is
 *      why the `platform_*` checks come before the entitlement check rather than
 *      after it.
 *   2. **Then their side.** A working service the business is not entitled to is
 *      `suspended_by_plan` (or `no_access` for one member), which is a sentence
 *      with a first-party link that fixes it.
 *   3. **Then limits and money.** `usage_limit_reached` and `wallet_empty` are
 *      distinct because the fix differs: one is a support conversation, one is a
 *      top-up.
 *
 * Every internal reason is mapped explicitly rather than passed through. A
 * supplier code, a LiteLLM reason or a Zarinpal status that reached a tenant
 * would be the leak this epic exists to prevent — and a `switch` over a union is
 * how a future code becomes a compile error instead of a leak.
 */
import type { AiRuntimeUnavailableReason } from "../ai-config";
import type { DenialReason } from "../entitlement-service";
import type { ManagedServiceDetailKey } from "./contract";

/** What the entitlement resolver said, in the two fields that matter here. */
export interface EntitlementFacts {
  allowed: boolean;
  reason: DenialReason | null;
}

/**
 * The commercial layer, translated.
 *
 * `permission_denied` is about the *person* asking rather than the business, so
 * it must never be rendered as a service fault — `no_access` is the only honest
 * reading, and the readiness service resolves without an acting permission set
 * precisely so this state is rare.
 *
 * An `allowed: false` with no reason is a resolver bug; `needs_support` is the
 * safe direction because it does not claim the service works.
 */
export function entitlementDetailKey(facts: EntitlementFacts): ManagedServiceDetailKey {
  if (facts.allowed) return "ready";
  switch (facts.reason) {
    case "platform_unavailable":
      // A disabled app or a switched-off rollout: temporary, ours, and it will be
      // re-checked by itself — not something the business can act on.
      return "temporarily_unavailable";
    case "subscription_expired":
    case "not_in_plan":
    case "addon_required":
      return "suspended_by_plan";
    case "insufficient_credit":
      return "wallet_empty";
    case "limit_reached":
    case "spend_limit_reached":
      return "usage_limit_reached";
    case "permission_denied":
      return "no_access";
    case null:
      return "needs_support";
  }
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export interface AiServiceFacts {
  entitlement: EntitlementFacts;
  /** `getAiRuntimeReadiness()` — the platform's own side of the service. */
  platform: { ready: boolean; reason: AiRuntimeUnavailableReason | null };
}

/**
 * The platform's AI reason, translated. `null` means the platform is fine and the
 * entitlement check decides.
 *
 * The split: reasons an operator fixes in the console are `platform_setup_incomplete`
 * ("no action for you"), a platform-level switch is `suspended_by_platform`, a
 * virtual key the runtime mints for the business is `provisioning`, and an
 * undecryptable credential is a support call rather than a configuration gap —
 * re-provisioning it would orphan the key still live in the gateway.
 */
export function aiPlatformDetailKey(
  platform: AiServiceFacts["platform"],
): ManagedServiceDetailKey | null {
  if (platform.ready) return null;
  switch (platform.reason) {
    case "platform_disabled":
    case "gateway_disabled":
      return "suspended_by_platform";
    case "missing_base_url":
    case "invalid_base_url":
    case "missing_runtime_credential":
    case "missing_model":
    case "invalid_max_output_tokens":
    case "configuration_load_failed":
      return "platform_setup_incomplete";
    case "tenant_virtual_key_missing":
      return "provisioning";
    case "tenant_credential_undecryptable":
      return "needs_support";
    case null:
      // Not ready, no reason: the safe reading is that something needs a human,
      // and saying "ready" would be the only dangerous answer here.
      return "needs_support";
  }
}

export function aiDetailKey(facts: AiServiceFacts): ManagedServiceDetailKey {
  return aiPlatformDetailKey(facts.platform) ?? entitlementDetailKey(facts.entitlement);
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface PaymentServiceFacts {
  entitlement: EntitlementFacts;
  /** The configured mode. `manual` means bank transfer, which is not online payment. */
  gateway: "manual" | "zarinpal";
  /** Whether the merchant id the gateway needs is actually present. */
  merchantConfigured: boolean;
}

/**
 * Online top-up is ready when a gateway is configured *and* has what it needs.
 *
 * A deployment on `manual` is not broken — tenants can still transfer — but this
 * service is "online payment", and it is not that. Reporting `platform_setup_incomplete`
 * is honest for both halves: the platform has not set it up, and there is nothing
 * for the tenant to do about it.
 */
export function paymentDetailKey(facts: PaymentServiceFacts): ManagedServiceDetailKey {
  if (facts.gateway !== "zarinpal" || !facts.merchantConfigured) return "platform_setup_incomplete";
  return entitlementDetailKey(facts.entitlement);
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface MediaServiceFacts {
  entitlement: EntitlementFacts;
  /** The platform's storage switch. */
  enabled: boolean;
  /** Endpoint, bucket and credential all present. */
  storageConfigured: boolean;
}

export function mediaDetailKey(facts: MediaServiceFacts): ManagedServiceDetailKey {
  if (!facts.enabled || !facts.storageConfigured) return "platform_setup_incomplete";
  return entitlementDetailKey(facts.entitlement);
}

// ---------------------------------------------------------------------------
// The email relay
// ---------------------------------------------------------------------------

export interface EmailServiceFacts {
  /** The deployment's own relay: a noop provider counts as "not set up". */
  relayConfigured: boolean;
}

/**
 * The relay is ours, with no supplier to hide — what it needs is a `ready` /
 * `platform_setup_incomplete` decision and nothing else. Deliberately no
 * entitlement branch: email shares the messaging capability with SMS, and its
 * plan gate belongs to the messaging surface that already resolves it once.
 */
export function emailDetailKey(facts: EmailServiceFacts): ManagedServiceDetailKey {
  return facts.relayConfigured ? "ready" : "platform_setup_incomplete";
}
