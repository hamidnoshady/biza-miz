/**
 * Issue #1110 — the one server-side My Workspace access decision.
 *
 * The canonical rule from the issue:
 *
 * ```ts
 * workspaceAvailable = industryEligible
 *   && workspaceServiceEnabled
 *   && deploymentSupportsWorkspace;
 * canShowWorkspace = workspaceAvailable && effectivePermissions.has("workspace.view");
 * ```
 *
 * The axes are **intersected, never substituted**: industry applicability
 * (`workspace-eligibility.ts`), the separately activated Workspace service
 * (#1041), the deployment capability, and the member's current effective
 * permission. Hiding a navigation row is never the authorization; the pages,
 * the API guard, the AI tools and the MCP catalogue all ask this module.
 *
 * Project-level authorization is deliberately NOT here: it stays in
 * `workspace.ts` (`requireProjectCapability`), which every service call runs.
 * Eligibility never grants a permission or a project role.
 */
import { query, withTenant } from "./db";
import { readDeploymentProfile } from "./deployment-mode";
import { deploymentRole } from "./deployment-role";
import type { DeploymentProfile } from "./deployment-mode";
import { readBusinessIndustry } from "./business-industry";
import { PERMISSIONS } from "./permissions";
import {
  resolveWorkspaceIndustryEligibility,
  type WorkspaceEligibilityOverride,
  type WorkspaceIndustryEligibilityReason,
} from "./workspace-eligibility";

/**
 * The Workspace capability whose activation decides the whole area.
 *
 * #1041 sells Workspace capabilities individually (`projects`, `documents`,
 * `media-library`). The module home, projects, tasks, calendar, contracts,
 * teams, approvals and reports are the `projects` capability's surface, so its
 * activation is the one that decides whether the area exists. `documents`
 * remains separately gated for its own mutating routes by the existing guard.
 */
export const WORKSPACE_ACCESS_SERVICE_KEY = "projects";

/**
 * The activation states a customer's own disable can produce (#1041's
 * `customerDisabled` set). Kept as a tiny constant here rather than importing
 * `catalog.ts` / `app-gate-service.ts`: this module is on every Workspace/AEC API
 * route, and the 35 KB service catalogue would be duplicated into the server
 * common chunk (caught by the desktop size gate). `workspace-access.test.ts`
 * pins this set against `SERVICE_STATE_META`.
 */
export const WORKSPACE_CUSTOMER_DISABLED_STATES = [
  "disabled_retained",
  "eligible_for_purge",
  "purging",
  "data_purged",
  "purge_failed",
] as const;

const CUSTOMER_DISABLED = new Set<string>(WORKSPACE_CUSTOMER_DISABLED_STATES);

/**
 * Has the business deliberately disabled the Workspace `projects` capability?
 * No row means "never activated" and stays available (grandfathered, #1041).
 */
async function workspaceServiceEnabled(businessId: string): Promise<boolean> {
  const { rows } = await withTenant(businessId, () =>
    query<{ state: string }>(
      `SELECT state
         FROM business_service_activations
        WHERE business_id = $1 AND service_kind = 'workspace' AND service_key = $2
        ORDER BY (state = 'active') DESC, updated_at DESC
        LIMIT 1`,
      [businessId, WORKSPACE_ACCESS_SERVICE_KEY],
    ),
  );
  const state = rows[0]?.state;
  return !state || !CUSTOMER_DISABLED.has(state);
}

/** The stable, client-safe refusal code. */
export const WORKSPACE_UNAVAILABLE_ERROR = "workspace_not_available";

export type WorkspaceUnavailableReason =
  | "BUSINESS_TYPE_UNSUPPORTED"
  | "WORKSPACE_SERVICE_DISABLED"
  | "DEPLOYMENT_UNSUPPORTED"
  | "INSUFFICIENT_PERMISSION"
  | "WORKSPACE_ACCESS_CHECK_UNAVAILABLE";

export interface WorkspaceAccessDecision {
  available: boolean;
  /** Industry applicability, before the other axes. */
  eligible: boolean;
  /** The Workspace service has not been deliberately disabled. */
  serviceEnabled: boolean;
  /** This deployment can run the Workspace capability. */
  deploymentSupported: boolean;
  /** The member's current effective permissions include `workspace.view`. */
  permitted: boolean;
  reason: WorkspaceUnavailableReason | null;
  industry: string | null;
  industryReason: WorkspaceIndustryEligibilityReason;
}

export function resolveWorkspaceAccessDecision(input: {
  industry: string | null | undefined;
  deploymentProfile: DeploymentProfile;
  runtimeRole?: "central" | "site";
  serviceEnabled: boolean;
  permissions: ReadonlySet<string> | readonly string[];
  override?: WorkspaceEligibilityOverride | null;
}): WorkspaceAccessDecision {
  const industry = resolveWorkspaceIndustryEligibility(input.industry, input.override);
  const held = input.permissions instanceof Set ? input.permissions : new Set(input.permissions);
  const permitted = held.has(PERMISSIONS.workspaceView);
  // `app.workspace` is a cloud/hybrid capability in `capabilities.ts`. Kept as
  // a local predicate here so the route guards do not pull the whole app
  // registry into every API bundle; `workspace-access.test.ts` pins it against
  // the registry's profile list.
  const deploymentSupported =
    (input.deploymentProfile === "cloud" || input.deploymentProfile === "hybrid") &&
    input.runtimeRole !== "site";
  const serviceEnabled = input.serviceEnabled === true;

  let reason: WorkspaceUnavailableReason | null = null;
  if (!industry.eligible) reason = "BUSINESS_TYPE_UNSUPPORTED";
  else if (!serviceEnabled) reason = "WORKSPACE_SERVICE_DISABLED";
  else if (!deploymentSupported) reason = "DEPLOYMENT_UNSUPPORTED";
  else if (!permitted) reason = "INSUFFICIENT_PERMISSION";

  return {
    available: reason === null,
    eligible: industry.eligible,
    serviceEnabled,
    deploymentSupported,
    permitted,
    reason,
    industry: industry.industry,
    industryReason: industry.reason,
  };
}

/**
 * Load the trusted business context once and decide.
 *
 * Every read is scoped to `businessId` (the session's tenant), never to a
 * client-supplied value. A failed read is a **closed** answer: an unavailable
 * industry/service/deployment can only deny access, never grant it.
 */
export async function workspaceAccessFor(
  businessId: string,
  permissions: ReadonlySet<string> | readonly string[],
): Promise<WorkspaceAccessDecision> {
  const [industry, deployment, serviceEnabled] = await Promise.all([
    readBusinessIndustry(businessId).catch(() => null),
    readDeploymentProfile(businessId).catch(() => null),
    workspaceServiceEnabled(businessId).catch(() => false),
  ]);

  return resolveWorkspaceAccessDecision({
    industry,
    // An unreadable deployment row is treated as the most restrictive profile
    // (`local` cannot run a cloud capability), so a failed read fails closed.
    deploymentProfile: deployment?.profile ?? "local",
    runtimeRole: deploymentRole(),
    serviceEnabled,
    permissions,
  });
}
