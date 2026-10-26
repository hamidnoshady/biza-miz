/**
 * Issue #902 — the child-account provisioning state machine, pure half.
 *
 * The provider's `client/add` is not idempotent in the way an HTTP caller
 * usually assumes: a timeout says nothing about whether the child was created.
 * The machine in this file therefore treats **recovery as a first-class
 * state**, not an error path:
 *
 *   not_provisioned → pending → provisioning → active
 *                                   │  ╰────→ retry_pending ──→ attention_required
 *                                   ╰────────→ attention_required (operator)
 *   active ⇄ suspended   (Growth off/on; records and provider credit survive)
 *
 * `retry_pending` always means "look before you write": the next attempt calls
 * `client/fetchbylocalid` with the business UUID before it calls `client/add`
 * again, and a `503 duplicate localid` is resolved the same way rather than
 * being reported as a failure. That, plus a database uniqueness constraint on
 * both `business_id` and `localid`, is what makes simultaneous activation and a
 * timed-out retry unable to produce a second account.
 *
 * Everything here is framework-free so the transitions can be unit-tested
 * directly; the database/queue half lives in `provisioning-service.ts`.
 */
import { randomBytes } from "node:crypto";
import { KAVENEGAR_CHILD_STATUS } from "./client";
import type { ManagedServiceDetailKey } from "../managed-services/contract";

export type ProvisionState =
  | "not_provisioned"
  | "pending"
  | "provisioning"
  | "active"
  | "retry_pending"
  | "attention_required"
  | "suspended";

export type ProvisionEvent =
  | "request_provision"
  | "claim"
  | "succeeded"
  | "recovered"
  | "adopted"
  | "username_collision"
  | "outcome_unknown"
  | "transient_failure"
  | "permanent_failure"
  | "attempts_exhausted"
  | "suspend"
  | "reactivate";

export interface ProvisionTransition {
  state: ProvisionState;
  /** Internal reason code; tenant copy is derived by the contract layer. */
  reason: string | null;
  /** True when the caller must enqueue a job because of this transition. */
  enqueue: boolean;
}

/**
 * The transition table. Unknown (state, event) pairs describe a programming
 * error, so they throw instead of silently leaving a tenant half-provisioned.
 */
const TRANSITIONS: Record<ProvisionState, Partial<Record<ProvisionEvent, ProvisionTransition>>> = {
  not_provisioned: {
    request_provision: { state: "pending", reason: "requested", enqueue: true },
    adopted: { state: "active", reason: "adopted_existing_child", enqueue: false },
  },
  pending: {
    claim: { state: "provisioning", reason: null, enqueue: false },
    transient_failure: { state: "retry_pending", reason: "transient_failure", enqueue: true },
    adopted: { state: "active", reason: "adopted_existing_child", enqueue: false },
    permanent_failure: { state: "attention_required", reason: "permanent_failure", enqueue: false },
  },
  provisioning: {
    succeeded: { state: "active", reason: null, enqueue: false },
    recovered: { state: "active", reason: "recovered_after_unknown_outcome", enqueue: false },
    adopted: { state: "active", reason: "adopted_existing_child", enqueue: false },
    username_collision: { state: "retry_pending", reason: "username_collision", enqueue: true },
    outcome_unknown: { state: "retry_pending", reason: "outcome_unknown", enqueue: true },
    transient_failure: { state: "retry_pending", reason: "transient_failure", enqueue: true },
    permanent_failure: { state: "attention_required", reason: "permanent_failure", enqueue: false },
  },
  active: {
    suspend: { state: "suspended", reason: "suspended", enqueue: false },
    permanent_failure: { state: "attention_required", reason: "provider_revoked", enqueue: false },
  },
  retry_pending: {
    claim: { state: "provisioning", reason: null, enqueue: false },
    request_provision: { state: "pending", reason: "requested", enqueue: true },
    recovered: { state: "active", reason: "recovered_after_unknown_outcome", enqueue: false },
    adopted: { state: "active", reason: "adopted_existing_child", enqueue: false },
    attempts_exhausted: { state: "attention_required", reason: "attempts_exhausted", enqueue: false },
    permanent_failure: { state: "attention_required", reason: "permanent_failure", enqueue: false },
    suspend: { state: "suspended", reason: "suspended", enqueue: false },
  },
  attention_required: {
    request_provision: { state: "pending", reason: "operator_retry", enqueue: true },
    adopted: { state: "active", reason: "adopted_existing_child", enqueue: false },
    suspend: { state: "suspended", reason: "suspended", enqueue: false },
  },
  suspended: {
    reactivate: { state: "pending", reason: "reactivated", enqueue: true },
    request_provision: { state: "pending", reason: "reactivated", enqueue: true },
    adopted: { state: "active", reason: "adopted_existing_child", enqueue: false },
  },
};

export class ProvisionTransitionError extends Error {
  constructor(
    readonly state: ProvisionState,
    readonly event: ProvisionEvent,
  ) {
    super(`illegal_provision_transition:${state}->${event}`);
    this.name = "ProvisionTransitionError";
  }
}

export function transitionProvisionState(
  state: ProvisionState,
  event: ProvisionEvent,
): ProvisionTransition {
  const transition = TRANSITIONS[state]?.[event];
  if (!transition) throw new ProvisionTransitionError(state, event);
  return transition;
}

/** States in which a child exists and may be used for sending. */
export function isProvisionUsable(state: ProvisionState): boolean {
  return state === "active";
}

/** States whose next attempt must read the provider before it writes. */
export function needsProviderReadFirst(state: ProvisionState): boolean {
  return state === "retry_pending" || state === "attention_required";
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type ProvisionAction =
  | { action: "provision"; reason: ManagedServiceDetailKey }
  | { action: "suspend"; reason: ManagedServiceDetailKey }
  | { action: "reactivate"; reason: ManagedServiceDetailKey }
  | { action: "wait"; reason: ManagedServiceDetailKey }
  | { action: "operator"; reason: ManagedServiceDetailKey };

export interface ProvisionEligibilityInput {
  /** Console policy: the platform has opted in to customer management. */
  policyEnabled: boolean;
  /** Canonical entitlement (`cloud.messaging`). */
  entitled: boolean;
  /** The Growth app is available platform-wide and for this business. */
  appAvailable: boolean;
  existingState: ProvisionState | null;
  now: Date;
  /** When the last automatic attempt ran, if any. */
  lastAttemptAt?: Date | null;
}

/**
 * Decide what the tick should do for one business.
 *
 * The order is the contract's order: platform availability, then entitlement,
 * then the account's own state. A tenant is never told *why* the platform's
 * supplier relationship is unavailable — only whether it can act, must wait,
 * or needs support.
 */
export function decideProvisionAction(input: ProvisionEligibilityInput): ProvisionAction {
  if (!input.policyEnabled) return { action: "wait", reason: "platform_setup_incomplete" };
  if (!input.appAvailable) return { action: "wait", reason: "suspended_by_platform" };

  const state = input.existingState;

  if (!input.entitled) {
    // Growth lapsed: stop new sends and suspend the child, but never delete the
    // mapping, its audit trail or the provider credit already transferred.
    if (state === "active" || state === "provisioning" || state === "pending") {
      return { action: "suspend", reason: "suspended_by_plan" };
    }
    return { action: "wait", reason: "suspended_by_plan" };
  }

  switch (state) {
    case null:
    case "not_provisioned":
      return { action: "provision", reason: "provisioning" };
    case "pending":
    case "provisioning":
      return { action: "wait", reason: "provisioning" };
    case "active":
      return { action: "wait", reason: "ready" };
    case "retry_pending":
      return isBackoffElapsed(input.lastAttemptAt ?? null, input.now)
        ? { action: "provision", reason: "provisioning" }
        : { action: "wait", reason: "provisioning" };
    case "attention_required":
      // Only an operator (console retry or adoption) may move it.
      return { action: "operator", reason: "needs_support" };
    case "suspended":
      return { action: "reactivate", reason: "provisioning" };
  }
}

export function provisionRetryDelayMs(attempts: number): number {
  const safe = Math.max(1, Math.trunc(attempts));
  return Math.min(30_000 * 2 ** (safe - 1), 6 * 60 * 60_000);
}

function isBackoffElapsed(lastAttemptAt: Date | null, now: Date): boolean {
  if (!lastAttemptAt) return true;
  return now.getTime() - lastAttemptAt.getTime() >= 30_000;
}

// ---------------------------------------------------------------------------
// Request material
// ---------------------------------------------------------------------------

/**
 * Our provider `localid`. Always the business UUID: it is unique across the
 * install, stable, and — unlike a username — never regenerated, which is what
 * makes `fetchbylocalid` a reliable recovery key.
 */
export function provisioningLocalId(businessId: string): string {
  return businessId;
}

/**
 * A candidate panel username. Deterministic from the business id plus an
 * attempt suffix, so a retry after a provider collision is a different name and
 * an operator reading two logs sees the same derivation.
 */
export function provisioningUsername(businessId: string, attempt = 0): string {
  const compact = businessId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const base = `bm${compact.slice(0, 16)}`;
  return attempt > 0 ? `${base}${attempt}` : base;
}

const PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";

/**
 * A strong, provider-acceptable panel password.
 *
 * Nobody types this: the child is created with panel login disabled
 * (`Status=2`) and the platform never uses the panel. It exists because the
 * provider requires one. The random source is injectable so the test can prove
 * the alphabet and the guaranteed character classes rather than assert
 * "looks random".
 */
export function generatePanelPassword(random: (bytes: number) => Buffer = randomBytes): string {
  const bytes = random(28);
  let body = "";
  for (const byte of bytes) body += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
  // Guarantee the classes the provider's panel asks for, regardless of draw.
  return `Aa1${body}`;
}

export interface ChildProvisioningRequest {
  localId: string;
  username: string;
  password: string;
  fullName: string;
  planId: number | null;
  minAllowedCreditRial: number;
  status: string;
  lines: string[];
  initialCreditRial: number;
}

export function buildChildProvisioningRequest(input: {
  businessId: string;
  businessName: string;
  policy: { planId: number | null; minAllowedCreditRial: number; senderLines: string[] };
  usernameAttempt?: number;
  password?: string;
}): ChildProvisioningRequest {
  return {
    localId: provisioningLocalId(input.businessId),
    username: provisioningUsername(input.businessId, input.usernameAttempt ?? 0),
    password: input.password ?? generatePanelPassword(),
    fullName: (input.businessName || "").trim().slice(0, 120) || "Bizamiz",
    planId: input.policy.planId,
    minAllowedCreditRial: Math.max(0, Math.trunc(input.policy.minAllowedCreditRial)),
    status: KAVENEGAR_CHILD_STATUS.activeNoPanel,
    lines: input.policy.senderLines,
    // Funding is a separate, audited transfer; a new child starts at zero.
    initialCreditRial: 0,
  };
}
