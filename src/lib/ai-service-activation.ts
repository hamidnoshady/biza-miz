import { ACTION_CATALOG, type ActionType } from "./ai";
import { appForApiPath } from "./app-availability";
import { getBusinessIndustry } from "./industry-guard";
import { resolveWorkspaceIndustryEligibility } from "./workspace-eligibility";
import { serviceActivationState } from "./service-activation/app-gate-service";
import { serviceGateBlocks } from "./service-activation/app-gate";
import type { ServiceKind, ServiceState } from "./service-activation/catalog";
import {
  workspaceActionServiceForEndpoint,
  type AiActionServiceIdentity,
} from "./ai-action-service";

export type { AiActionServiceIdentity };

/**
 * Resolve the paid service owning an action's canonical endpoint. The app half
 * lives here (and pulls the app registry); the Workspace half is the pure
 * mapping in `ai-action-service.ts`, which the client-safe prompt module also
 * imports.
 */
export function aiActionServiceForEndpoint(
  endpoint: string,
): AiActionServiceIdentity | null {
  const pathname = endpoint.split(/[?#]/, 1)[0];
  const app = appForApiPath(pathname);
  if (app) return { kind: "app", key: app };
  return workspaceActionServiceForEndpoint(endpoint);
}

export type AiActionServiceGate =
  | { allowed: true; service: AiActionServiceIdentity | null }
  | {
      allowed: false;
      error:
        | "service_disabled"
        | "service_activation_check_unavailable"
        | "workspace_not_available"
        | "workspace_access_check_unavailable";
      service: AiActionServiceIdentity;
      state?: ServiceState;
    };

/**
 * Background AI routines execute the same typed actions as the assistant, but
 * call their service executors directly instead of traversing the HTTP route
 * guard. Re-check the target service at execution time so a deliberate customer
 * disable cannot be bypassed by an already-scheduled routine. Shared endpoints
 * stay shared, and non-customer suspension states remain usable.
 *
 * Issue #1110 adds the industry axis: an ineligible business's Workspace actions
 * are refused even when a routine was scheduled before the rule existed, and an
 * unknown industry fails closed.
 */
export async function aiActionServiceGate(
  businessId: string,
  actionType: ActionType,
): Promise<AiActionServiceGate> {
  const meta = ACTION_CATALOG[actionType];
  const service = aiActionServiceForEndpoint(meta.endpoint);
  if (!service) return { allowed: true, service: null };

  if (service.kind === "workspace") {
    let industry: string | null;
    try {
      industry = await getBusinessIndustry(businessId);
    } catch {
      return { allowed: false, error: "workspace_access_check_unavailable", service };
    }
    if (!resolveWorkspaceIndustryEligibility(industry).eligible) {
      return { allowed: false, error: "workspace_not_available", service };
    }
  }

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
