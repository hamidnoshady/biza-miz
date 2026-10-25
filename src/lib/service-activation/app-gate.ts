/**
 * The paid-activation guard for app APIs (issue #1041 §B/§C).
 *
 * The epic's enforcement clause is explicit: *"Enforce app entitlement +
 * paid-activation state on APIs, background workers, tools, scheduler and
 * pages"*. This module is the API half — the decision, kept pure so it is
 * testable and so the one call site in `src/lib/auth.ts` stays three lines.
 *
 * ## Why this is a *narrow* guard, on purpose
 *
 * Three separate questions already gate an app's HTTP surface, and this is a
 * fourth axis, not a replacement:
 *
 *   - a **feature flag** — "is this business entitled to it" (`feature_disabled`)
 *   - a **module**       — "does this trade have it at all" (`module_unavailable`)
 *   - **availability**   — "is the app working right now" (`app_unavailable`, 503)
 *   - **activation**     — "did this business deliberately switch it off" (`service_disabled`)
 *
 * Because that is the fourth axis, it must be the *quietest*:
 *
 *  1. **No activation row ⇒ no opinion.** A business that never touched the
 *     service layer keeps working exactly as before. A guard that defaulted to
 *     "not activated, therefore blocked" would lock every existing customer out
 *     of their own POS the moment this shipped, which is the precise opposite of
 *     the epic's "zero unintended debits / no lockout" requirement.
 *  2. **Only a deliberate customer disable blocks.** Auto-suspension (low
 *     credit), platform unavailability and legal hold are *not* a disable — the
 *     issue says they must never masquerade as one — so they do not lock the
 *     app. They are billing-side states; the billing engine already stops the
 *     clock and refuses to run up debt.
 *  3. **Reads stay open; only writes are refused.** The issue requires a
 *     "permitted read/export path" after a disable, and the customer's data must
 *     remain exportable until the retention deadline actually passes.
 */
import { SERVICE_STATE_META, type ServiceState } from "./catalog";

/** The error code the client shows (403, beside `feature_disabled`). */
export const SERVICE_GATE_ERROR = "service_disabled";
export const SERVICE_GATE_STATUS = 403;

/**
 * The states that lock an app's mutating surface.
 *
 * Derived from the state catalogue rather than listed again: every state the
 * catalogue marks `customerDisabled` (disabled_retained, eligible_for_purge,
 * purging, data_purged, purge_failed) is a customer decision that ended the
 * app's use, and every state it does not mark (`active`, the two suspension
 * states, `legal_hold`, the two setup states) leaves the app usable.
 */
export function serviceGateBlocks(state: ServiceState | string | null | undefined): boolean {
  if (!state) return false;
  const meta = SERVICE_STATE_META[state as ServiceState];
  return Boolean(meta?.customerDisabled);
}

/** Mutating methods are what a disabled app may not do. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ServiceGateDecision {
  error: typeof SERVICE_GATE_ERROR;
  status: number;
  /** Which app the request was for — the console and the client both need it. */
  app: string;
  state: string;
}

/**
 * The guard's whole decision: does this request need refusing?
 *
 * `state` is the caller's activation state for `app`, or null when the business
 * has never activated it (the common case, and never a block).
 */
export function serviceGateDecision(input: {
  method: string;
  app: string | null;
  state: ServiceState | string | null | undefined;
}): ServiceGateDecision | null {
  if (!input.app) return null;
  if (!MUTATING_METHODS.has(input.method.toUpperCase())) return null;
  if (!serviceGateBlocks(input.state)) return null;
  return {
    error: SERVICE_GATE_ERROR,
    status: SERVICE_GATE_STATUS,
    app: input.app,
    state: String(input.state),
  };
}
