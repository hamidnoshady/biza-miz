/**
 * The business lifecycle's transition table — one source of truth for what a
 * `currentStatus -> requestedStatus` move means and which capability it needs.
 *
 * This module exists because the console used to authorize on the *target*
 * status alone. `archived -> active` therefore needed only `business.suspend`,
 * and an engineer — who cannot archive — could undo an owner's archive decision.
 * The capability now belongs to the *transition*, not the destination:
 *
 *   active            -> suspended  business.suspend
 *   suspended         -> active     business.suspend
 *   active            -> archived   business.archive
 *   suspended         -> archived   business.archive
 *   archived          -> active     business.archive
 *
 * Every other pair is invalid and rejected explicitly, including
 * `X -> X` (a no-op is a stale screen, not a lifecycle change).
 *
 * It is pure — no database, no request — so the HTTP route, the overview
 * controls and the unit tests all ask the same question and get the same
 * answer instead of each re-deriving "who may un-archive?".
 */
import type { PlatformCapability } from "./platform-admin";

export type BusinessLifecycleStatus = "active" | "suspended" | "archived";

export interface LifecycleTransition {
  from: BusinessLifecycleStatus;
  to: BusinessLifecycleStatus;
  /** The capability that authorizes *this* move. */
  capability: PlatformCapability;
  /** Persian label of the action, for the console's buttons and notices. */
  label: string;
  /** The audit action recorded for the move. */
  auditAction: string;
}

export type LifecycleError = "same_status" | "invalid_transition";

export type LifecycleDecision =
  | { ok: true; transition: LifecycleTransition }
  | { ok: false; error: LifecycleError };

/**
 * The five legal moves. Spelled out rather than derived, so a reviewer can read
 * the whole policy without following a rule — and so a sixth state added later
 * fails loudly (every lookup just misses) instead of inheriting an accidental
 * permission from a wildcard.
 */
export const LIFECYCLE_TRANSITIONS: readonly LifecycleTransition[] = [
  {
    from: "active",
    to: "suspended",
    capability: "business.suspend",
    label: "تعلیق",
    auditAction: "business.suspended",
  },
  {
    from: "suspended",
    to: "active",
    capability: "business.suspend",
    label: "فعال‌سازی",
    auditAction: "business.active",
  },
  {
    from: "active",
    to: "archived",
    capability: "business.archive",
    label: "بایگانی",
    auditAction: "business.archived",
  },
  {
    from: "suspended",
    to: "archived",
    capability: "business.archive",
    label: "بایگانی",
    auditAction: "business.archived",
  },
  {
    // Restoring is the inverse of archiving, so it is owner-level too: `suspend`
    // is what an engineer holds for temporary problems, and using it here was
    // the authorization gap this table closes.
    from: "archived",
    to: "active",
    capability: "business.archive",
    label: "بازگردانی از بایگانی",
    auditAction: "business.active",
  },
];

export function isBusinessLifecycleStatus(value: unknown): value is BusinessLifecycleStatus {
  return value === "active" || value === "suspended" || value === "archived";
}

/** Resolve one transition, or say exactly why it is not allowed. */
export function businessLifecycleTransition(
  from: BusinessLifecycleStatus,
  to: BusinessLifecycleStatus,
): LifecycleDecision {
  if (from === to) return { ok: false, error: "same_status" };
  const transition = LIFECYCLE_TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (!transition) return { ok: false, error: "invalid_transition" };
  return { ok: true, transition };
}

/** Every legal move out of the current status, with the capability each needs. */
export function lifecycleTransitionsFrom(
  from: BusinessLifecycleStatus,
): LifecycleTransition[] {
  return LIFECYCLE_TRANSITIONS.filter((t) => t.from === from);
}

/**
 * The moves this operator may actually make — what the console header and the
 * overview's lifecycle card render. The server re-checks with the same policy,
 * this only keeps the UI from offering a button that is guaranteed a 403.
 */
export function allowedLifecycleTransitions(
  from: BusinessLifecycleStatus,
  capabilities: readonly PlatformCapability[],
): LifecycleTransition[] {
  return lifecycleTransitionsFrom(from).filter((t) => capabilities.includes(t.capability));
}
