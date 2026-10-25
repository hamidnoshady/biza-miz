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
import { serviceGateBlocks } from "./app-gate";
import { isServiceState, type ServiceKind, type ServiceState } from "./catalog";

/**
 * The activation state of one business service, or null when the business
 * never activated it.
 *
 * Deliberately narrow — one indexed lookup on `(business_id, kind, key)`, no
 * joins and no writes. A missing row is non-blocking; a failed lookup is a
 * temporary 503 in the API caller, never an accidental pass through a
 * deliberate disable. The worker helper below catches lookup failures and
 * leaves queued work untouched until the next tick.
 */
export async function serviceActivationState(
  businessId: string,
  kind: ServiceKind,
  serviceKey: string,
): Promise<ServiceState | null> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{ state: string }>(
      `SELECT state
         FROM business_service_activations
        WHERE business_id = $1 AND service_kind = $2 AND service_key = $3
        ORDER BY (state = 'active') DESC, updated_at DESC
        LIMIT 1`,
      [businessId, kind, serviceKey],
    );
    const state = rows[0]?.state;
    return isServiceState(state) ? state : null;
  });
}

export async function appServiceActivationState(
  businessId: string,
  appKey: string,
): Promise<ServiceState | null> {
  return serviceActivationState(businessId, "app", appKey);
}

export async function workspaceServiceActivationState(
  businessId: string,
  serviceKey: string,
): Promise<ServiceState | null> {
  return serviceActivationState(businessId, "workspace", serviceKey);
}

/** Read the app activation snapshot once for the tenant shell. */
export async function appServiceActivationStates(
  businessId: string,
): Promise<Partial<Record<string, ServiceState>>> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{ service_key: string; state: string }>(
      `SELECT DISTINCT ON (service_key) service_key, state
         FROM business_service_activations
        WHERE business_id = $1 AND service_kind = 'app'
        ORDER BY service_key, (state = 'active') DESC, updated_at DESC`,
      [businessId],
    );
    return Object.fromEntries(
      rows.flatMap(({ service_key, state }) =>
        isServiceState(state) ? [[service_key, state] as const] : [],
      ),
    );
  });
}

/**
 * App and Workspace work remains available for legacy tenants with no
 * activation row and for every state except a deliberate customer disable.
 * In particular, credit/platform suspension and legal hold do not masquerade
 * as a customer decision. A lookup failure fails closed for the worker and
 * leaves queued work intact.
 */
export async function isServiceOperational(
  businessId: string,
  kind: ServiceKind,
  serviceKey: string,
): Promise<boolean> {
  try {
    const state = await serviceActivationState(businessId, kind, serviceKey);
    return !serviceGateBlocks(state);
  } catch {
    return false;
  }
}

export async function isAppServiceOperational(
  businessId: string,
  appKey: string,
): Promise<boolean> {
  return isServiceOperational(businessId, "app", appKey);
}

export async function isWorkspaceServiceOperational(
  businessId: string,
  serviceKey: string,
): Promise<boolean> {
  return isServiceOperational(businessId, "workspace", serviceKey);
}
