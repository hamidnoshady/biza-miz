import type { Role } from "../auth-edge";
import { effectivePermissions, type Permission, type PermissionOverrides } from "../permissions";
import type { DeploymentProfile } from "../deployment-mode";
import type { SiteMemberPolicy } from "./model";

export interface EffectiveAccessInput {
  profile: DeploymentProfile;
  role: Role;
  overrides?: PermissionOverrides | null;
  customRolePermissions?: readonly string[] | null;
  sitePolicy?: SiteMemberPolicy | null;
  canonicalLocationIds: readonly string[];
  deploymentPermissions?: ReadonlySet<Permission> | null;
}

/**
 * The single policy composition point. Cloud and Local use the canonical RBAC
 * result. Hybrid applies deny-only site and deployment intersections. There is
 * intentionally no site grant input, making privilege expansion unrepresentable.
 */
export function resolveEffectiveAccess(input: EffectiveAccessInput): {
  permissions: Set<Permission>;
  locationIds: Set<string>;
  suspended: boolean;
  loginLocked: boolean;
} {
  const canonical = effectivePermissions(input.role, input.overrides, input.customRolePermissions);
  const permissions = new Set(canonical);
  let locationIds = new Set(input.canonicalLocationIds);
  let suspended = false;
  let loginLocked = false;

  if (input.profile === "hybrid") {
    const policy = input.sitePolicy;
    for (const denied of policy?.permissionDenies ?? []) permissions.delete(denied as Permission);
    if (input.deploymentPermissions) {
      for (const permission of [...permissions]) {
        if (!input.deploymentPermissions.has(permission)) permissions.delete(permission);
      }
    }
    if (policy?.allowedLocationIds !== null && policy?.allowedLocationIds !== undefined) {
      const allowed = new Set(policy.allowedLocationIds);
      locationIds = new Set([...locationIds].filter((id) => allowed.has(id)));
    }
    suspended = policy?.isLocallySuspended ?? false;
    loginLocked = policy?.localLoginLocked ?? false;
  }

  return { permissions, locationIds, suspended, loginLocked };
}

export function isAuthorityIncrease(
  before: ReadonlySet<Permission>,
  after: ReadonlySet<Permission>,
  beforeLocations: ReadonlySet<string>,
  afterLocations: ReadonlySet<string>,
): boolean {
  return [...after].some((permission) => !before.has(permission)) ||
    [...afterLocations].some((location) => !beforeLocations.has(location));
}
