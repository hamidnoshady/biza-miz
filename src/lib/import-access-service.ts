/**
 * The database half of effective import access (GitHub #1580 / ESH-227).
 *
 * `import-access.ts` holds the rules; this module answers them for one target
 * (or a wizard's whole catalogue at once) from the canonical tables, and
 * nowhere else:
 *
 *   - `setup.selectedApps` (a draft, read through `setup-apps-service`, which
 *     is the owner of that row — never a second settings read);
 *   - `business_service_activations` (the #1041 activation state);
 *   - `business_complimentary_grants` (#1579's active grant read);
 *   - `workspaceAccessFor` (#1110's industry/deployment/service/permission
 *     decision) for Workspace targets;
 *   - `effectiveAppAvailability` (the operator's platform/tenant app state);
 *   - the member's own permissions, passed in by the caller so this module
 *     never invents an authorization.
 *
 * The reads are quiet (no writes) and each shared axis is read **once per
 * request**: the wizard resolves fifteen targets by paying for the selection,
 * availability and Workspace reads once and one activation/grant read per
 * distinct app. Every failed read resolves to the restrictive answer — a
 * mutation gate must fail closed, while the ordinary read/export path is gated
 * elsewhere.
 */
import {
  appServiceActivationState,
  serviceActivationState,
} from "./service-activation/app-gate-service";
import type { ServiceState } from "./service-activation/catalog";
import { WORKSPACE_ACCESS_SERVICE_KEY, workspaceAccessFor } from "./workspace-access";
import { readActiveComplimentaryGrant } from "./complimentary-grant-service";
import { effectiveAppAvailability } from "./app-availability-service";
import { getSelectedSetupApps } from "./setup-apps-service";
import { SETUP_IMPORT_MODULE_APP } from "./setup-imports";
import type { AppKey } from "./apps";
import type { DataModuleKey } from "./data-transfer/types";
import { PERMISSIONS } from "./permissions";
import {
  resolveImportAccess,
  type ImportAccessDecision,
  type ImportAccessGrantInput,
  type ImportAccessWorkspaceInput,
} from "./import-access";

export interface ImportAccessTarget {
  /** The Data Transfer module that owns the entity. */
  module: DataModuleKey;
  /** The entity's own import permission (registry), if it has one. */
  requiredPermission?: string | null;
  /** The platform registered a write path for this entity. */
  importable: boolean;
  /** The business type has the entity's module (`requiresModule`). */
  industryEligible?: boolean;
  /**
   * The caller already enforced `data.import` + the entity key (the Data
   * Transfer route does, through `entityAccess`). Background work then asks the
   * service axis alone, rather than re-deriving a member's permissions from a
   * session it does not have.
   */
  permissionAlreadyEnforced?: boolean;
  /**
   * Do not use the deployment profile as an import gate (#1580).
   *
   * The background engine is asked whether the *service* may receive writes;
   * the install's deployment capability is an authorization answer the HTTP
   * route already applied, and an import staged on Cloud must be able to run
   * on a Hybrid install of the same business. Workspace eligibility (#1110) and
   * service state are still enforced.
   */
  deploymentAgnostic?: boolean;
}

export interface ImportAccessTargetInput extends ImportAccessTarget {
  businessId: string;
  /** The member's current effective permissions. */
  permissions: ReadonlySet<string>;
  /** Deterministic instant for tests; defaults to now. */
  at?: string;
}

/** Is `data.import` plus the entity's own key held by this member? */
export function importPermissionHeld(
  permissions: ReadonlySet<string>,
  required: string | null | undefined,
): boolean {
  if (!permissions.has(PERMISSIONS.dataImport)) return false;
  return !required || permissions.has(required);
}

interface SharedAxes {
  /** `null` = the legacy pre-gallery state (grandfathered). */
  selection: AppKey[] | null;
  availability: Partial<Record<AppKey, boolean>>;
  workspace: ImportAccessWorkspaceInput | null;
  activationFor: (appKey: AppKey | null, isWorkspace: boolean) => Promise<{
    ok: boolean;
    state: ServiceState | null;
  }>;
  grantFor: (appKey: AppKey | null) => Promise<ImportAccessGrantInput | null>;
}

async function readSharedAxes(
  businessId: string,
  permissions: ReadonlySet<string>,
  at: string,
  needsWorkspace: boolean,
): Promise<SharedAxes> {
  // A failed selection read becomes `[]` (an explicit "nothing selected"), not
  // `null` (the grandfathering state) — a mutation must not be granted because
  // a read failed.
  const [selection, availabilityMap, workspace] = await Promise.all([
    getSelectedSetupApps(businessId).catch(() => [] as AppKey[]),
    effectiveAppAvailability(businessId).catch(() => null),
    needsWorkspace
      ? workspaceAccessFor(businessId, permissions).catch(() => null)
      : Promise.resolve(null),
  ]);

  const activations = new Map<string, Promise<{ ok: boolean; state: ServiceState | null }>>();
  const grants = new Map<
    string,
    Promise<ImportAccessGrantInput | null>
  >();

  return {
    selection,
    availability: Object.fromEntries(
      Object.entries(availabilityMap ?? {}).map(([key, value]) => [
        key,
        value?.usable ?? true,
      ]),
    ),
    workspace: workspace
      ? {
          eligible: workspace.eligible,
          serviceEnabled: workspace.serviceEnabled,
          deploymentSupported: workspace.deploymentSupported,
        }
      : null,
    activationFor(appKey, isWorkspace) {
      const cacheKey = appKey ?? (isWorkspace ? "workspace:projects" : "none");
      const cached = activations.get(cacheKey);
      if (cached) return cached;
      const read = (async () => {
        try {
          if (appKey) {
            return {
              ok: true,
              state: await appServiceActivationState(businessId, appKey),
            };
          }
          if (isWorkspace) {
            return {
              ok: true,
              state: await serviceActivationState(
                businessId,
                "workspace",
                WORKSPACE_ACCESS_SERVICE_KEY,
              ),
            };
          }
          return { ok: true, state: null };
        } catch {
          return { ok: false, state: null };
        }
      })();
      activations.set(cacheKey, read);
      return read;
    },
    grantFor(appKey) {
      if (!appKey) return Promise.resolve(null);
      const cached = grants.get(appKey);
      if (cached) return cached;
      const read = (async () => {
        try {
          const grant = await readActiveComplimentaryGrant({
            businessId,
            identity: { kind: "app", key: appKey },
            at,
          });
          return grant
            ? {
                status: grant.status,
                startsAt: grant.startsAt,
                expiresAt: grant.expiresAt,
              }
            : null;
        } catch {
          // A failed read is "no proven grant", not a grant that expired: the
          // activation state still decides, and a selected app falls back to
          // «منتظر فعال‌سازی» rather than a misleading expiry message.
          return null;
        }
      })();
      grants.set(appKey, read);
      return read;
    },
  };
}

/**
 * Resolve the effective import access for several targets of one business.
 * The wizard uses this for its whole catalogue; the engine uses it for one.
 */
export async function importAccessForTargets(
  businessId: string,
  targets: readonly ImportAccessTarget[],
  permissions: ReadonlySet<string>,
  atInput?: string,
): Promise<ImportAccessDecision[]> {
  const at = atInput ?? new Date().toISOString();
  const axes = await readSharedAxes(
    businessId,
    permissions,
    at,
    targets.some((target) => target.module === "workspace"),
  );
  return Promise.all(
    targets.map(async (target) => {
      const appKey: AppKey | null = SETUP_IMPORT_MODULE_APP[target.module] ?? null;
      const isWorkspace = target.module === "workspace";
      const [activation, grant] = await Promise.all([
        axes.activationFor(appKey, isWorkspace),
        axes.grantFor(appKey),
      ]);
      // A failed activation read must not become "no row" (which would
      // grandfather the target). Treat it as pending: staging only.
      const activationState: string | null = activation.ok
        ? activation.state
        : "payment_reserved";
      return resolveImportAccess({
        appKey,
        selection: axes.selection,
        activationState,
        grant,
        workspace: isWorkspace
          ? axes.workspace
            ? {
                ...axes.workspace,
                deploymentSupported:
                  target.deploymentAgnostic === true ? true : axes.workspace.deploymentSupported,
              }
            : null
          : null,
        permitted:
          target.permissionAlreadyEnforced === true ||
          importPermissionHeld(permissions, target.requiredPermission),
        importable: target.importable,
        industryEligible: target.industryEligible,
        deploymentSupported: appKey ? axes.availability[appKey] !== false : true,
        at,
      });
    }),
  );
}

/** Resolve the effective import access for one entity. */
export async function importAccessForTarget(
  input: ImportAccessTargetInput,
): Promise<ImportAccessDecision> {
  const [decision] = await importAccessForTargets(
    input.businessId,
    [input],
    input.permissions,
    input.at,
  );
  return decision;
}
