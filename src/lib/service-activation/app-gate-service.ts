/**
 * The database half of the paid-activation guard (`app-gate.ts` holds the
 * decision and its reasons).
 *
 * Its own module on purpose: `src/lib/auth.ts` imports this on the request path
 * of every route, and `activation-service.ts` is a large module that reaches
 * the wallet and billing runtime. Keeping the one indexed read here means the
 * guard adds a single `SELECT` — not a dependency graph — to every request.
 */
import { query, withTenant } from "../db";
import { isServiceState, type ServiceState } from "./catalog";

/**
 * The activation state of the business's **app** service, or null when the
 * business never activated it.
 *
 * Deliberately narrow — one indexed lookup on `(business_id, kind, key)`, no
 * joins, no writes — and it **fails open** on an infrastructure error. That is
 * the opposite of the billing paths (which fail closed and refuse to charge)
 * and it is the right trade here: "no row" stays a non-blocking answer, while
 * a failed lookup is a temporary 503 in the caller — never an accidental pass
 * through a deliberate disable. A transient outage cannot lock customers out
 * permanently; the next request can try again.
 */
export async function appServiceActivationState(
  businessId: string,
  appKey: string,
): Promise<ServiceState | null> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{ state: string }>(
      `SELECT state
         FROM business_service_activations
        WHERE business_id = $1 AND service_kind = 'app' AND service_key = $2
        ORDER BY (state = 'active') DESC, updated_at DESC
        LIMIT 1`,
      [businessId, appKey],
    );
    const state = rows[0]?.state;
    return isServiceState(state) ? state : null;
  });
}
