import { ACTION_CATALOG, type ActionType } from "./ai";
import { appForApiPath } from "./app-availability";
import { serviceActivationState } from "./service-activation/app-gate-service";
import { serviceGateBlocks } from "./service-activation/app-gate";
import type { ServiceKind, ServiceState } from "./service-activation/catalog";

export interface AiActionServiceIdentity {
  kind: ServiceKind;
  key: string;
}

export type AiActionServiceGate =
  | { allowed: true; service: AiActionServiceIdentity | null }
  | {
      allowed: false;
      error: "service_disabled" | "service_activation_check_unavailable";
      service: AiActionServiceIdentity;
      state?: ServiceState;
    };

/** Resolve the paid service owning an action's existing, canonical endpoint. */
export function aiActionServiceForEndpoint(endpoint: string): AiActionServiceIdentity | null {
  const pathname = endpoint.split(/[?#]/, 1)[0];
  const app = appForApiPath(pathname);
  if (app) return { kind: "app", key: app };
  if (
    pathname === "/api/workspace" ||
    pathname.startsWith("/api/workspace/") ||
    pathname === "/api/aec" ||
    pathname.startsWith("/api/aec/")
  ) {
    return {
      kind: "workspace",
      key: /(?:^|\/)documents(?:\/|$)/.test(pathname) ? "documents" : "projects",
    };
  }
  return null;
}

/**
 * Background AI routines execute the same typed actions as the assistant, but
 * call their service executors directly instead of traversing the HTTP route
 * guard. Re-check the target service at execution time so a deliberate customer
 * disable cannot be bypassed by an already-scheduled routine. Shared endpoints
 * stay shared, and non-customer suspension states remain usable.
 */
export async function aiActionServiceGate(
  businessId: string,
  actionType: ActionType,
): Promise<AiActionServiceGate> {
  const meta = ACTION_CATALOG[actionType];
  const service = aiActionServiceForEndpoint(meta.endpoint);
  if (!service) return { allowed: true, service: null };

  let state: ServiceState | null;
  try {
    state = await serviceActivationState(businessId, service.kind, service.key);
  } catch {
    return { allowed: false, error: "service_activation_check_unavailable", service };
  }
  if (serviceGateBlocks(state)) {
    return { allowed: false, error: "service_disabled", service, state: state! };
  }
  return { allowed: true, service };
}
