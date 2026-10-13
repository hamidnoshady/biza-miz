import type { Role } from "../auth-edge";
import type { PermissionOverrides } from "../permissions";
import type { LocationScope } from "../location-access";

export const IAM_SCHEMA_VERSION = 1 as const;
export const IAM_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type MembershipStatus = "invited" | "active" | "suspended" | "locked" | "inactive" | "offboarded";

export interface IamMembership {
  id: string;
  businessId: string;
  cloudIdentityRef: string | null;
  role: Role;
  customRoleId: string | null;
  fullName: string;
  email: string | null;
  isActive: boolean;
  status: MembershipStatus;
  overrides: PermissionOverrides;
  locationScope: LocationScope;
  defaultLocationId: string | null;
  locationIds: string[];
  revision: number;
}

export interface IamTenantRole {
  id: string;
  businessId: string;
  name: string;
  description: string;
  permissions: string[];
  defaultLocationScope: LocationScope;
  isActive: boolean;
  revision: number;
}

export interface SiteMemberPolicy {
  allowedLocationIds: string[] | null;
  permissionDenies: string[];
  isLocallySuspended: boolean;
  localLoginLocked: boolean;
  revision: number;
}

export type IamEntityType = "membership" | "tenant_role" | "credential";
export const IAM_EVENT_TYPES = [
  "membership.created", "membership.profile_updated", "membership.system_role_changed",
  "membership.custom_role_changed", "membership.permissions_changed", "membership.location_policy_changed",
  "membership.locations_changed", "membership.suspended", "membership.reactivated", "membership.offboarded",
  /**
   * Issue #854 (pass 4) — the explicit rehire ceremony: an offboarded
   * membership regains its identity linkage, credentials, role, permissions
   * and branch policy in one locked write. Carries the full membership
   * snapshot like `membership.created`, so a replica applies it the same way.
   */
  "membership.rehired",
  "credential.created", "credential.rotated", "credential.revoked",
  "tenant_role.created", "tenant_role.updated", "tenant_role.permissions_changed", "tenant_role.archived",
] as const;
export type IamEventType = (typeof IAM_EVENT_TYPES)[number];

export interface IamEvent {
  id: string;
  businessId: string;
  sequence: number;
  eventType: IamEventType;
  entityType: IamEntityType;
  entityId: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  actorUserId: string | null;
  origin: "cloud" | "local" | "site_command" | "migration";
  createdAt: string;
}

export interface IamSnapshot {
  schemaVersion: typeof IAM_SNAPSHOT_SCHEMA_VERSION;
  businessId: string;
  siteDeviceId: string;
  snapshotVersion: number;
  lastSequence: number;
  stateHash: string;
  memberships: IamMembership[];
  tenantRoles: IamTenantRole[];
  /** Metadata only. Secret material never belongs in a Cloud IAM snapshot. */
  credentials: Array<{ id: string; userId: string; type: string; status: string; revision: number }>;
}
