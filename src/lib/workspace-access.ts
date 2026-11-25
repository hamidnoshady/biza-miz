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
import { redirect } from "next/navigation";
import { query, withTenant } from "./db";
import { readDeploymentProfile } from "./deployment-mode";
import { deploymentRole } from "./deployment-role";
import type { DeploymentProfile } from "./deployment-mode";
import type { Industry } from "./industries";
import { PERMISSIONS } from "./permissions";
import { isWorkspaceServiceOperational } from "./service-activation/app-gate-service";
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
 * The tenant's industry, read under an explicit tenant scope.
 *
 * A local read rather than `industry-guard.getBusinessIndustry` on purpose: the
 * guard module pulls the module/profile registry and `app-routes`, and this
 * function runs in every Workspace/AEC API bundle. The query is the same one
 * the guard uses, scoped to the session's business — never a client value.
 */
async function readTrustedIndustry(businessId: string): Promise<Industry | null> {
  const { rows } = await withTenant(businessId, () =>
    query<{ industry: Industry }>("SELECT industry FROM businesses WHERE id = $1", [businessId]),
  );
  return rows[0]?.industry ?? null;
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
    readTrustedIndustry(businessId).catch(() => null),
    readDeploymentProfile(businessId).catch(() => null),
    isWorkspaceServiceOperational(businessId, WORKSPACE_ACCESS_SERVICE_KEY).catch(() => false),
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

/**
 * Page gate for every `/workspace` surface. Redirects an unavailable business to
 * the assistant home — the platform's accessible home — rather than rendering
 * an empty or padlocked Workspace.
 */
export async function requireWorkspacePageAccess(
  businessId: string,
  permissions: ReadonlySet<string> | readonly string[],
): Promise<WorkspaceAccessDecision> {
  const access = await workspaceAccessFor(businessId, permissions);
  if (!access.available) redirect("/dashboard");
  return access;
}
