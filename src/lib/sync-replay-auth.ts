import type { Role, SessionPayload } from "./auth-edge";
import { authorize } from "./authorize";
import { query, withoutTenantScope } from "./db";
import { PERMISSIONS, type Permission } from "./permissions";

export type SyncReplayAccess =
  | { ok: true; businessId: string; role: Role; permissions: Set<Permission> }
  | { ok: false; error: string };

/**
 * Automated cloud-originated website events (e.g. a CMS café order arriving
 * via webhook/poll with no staff user) carry `actorUserId === ""` when pulled
 * down to a paired desktop. They may exercise only the narrow non-discount
 * order/payment/kitchen surface — never discount overrides or admin mutations.
 */
const AUTOMATED_CLOUD_PERMISSIONS = new Set<Permission>([
  PERMISSIONS.ordersView,
  PERMISSIONS.ordersCreate,
  PERMISSIONS.ordersVoid,
  PERMISSIONS.ordersVoidItem,
  PERMISSIONS.ordersAmendClosed,
  PERMISSIONS.paymentsTake,
  PERMISSIONS.paymentsRefund,
  PERMISSIONS.kitchenView,
]);

export async function authorizeAutomatedCloudReplay(input: {
  locationId: string;
  permissions: readonly Permission[];
  requireAll?: boolean;
}): Promise<SyncReplayAccess> {
  const { rows } = await withoutTenantScope("authorization-membership", () =>
    query<{ business_id: string }>(
      `SELECT business_id FROM locations WHERE id = $1 AND is_active`,
      [input.locationId],
    ),
  );
  const businessId = rows[0]?.business_id;
  if (!businessId) return { ok: false, error: "unknown_location" };

  const allowed = input.requireAll
    ? input.permissions.every((perm) => AUTOMATED_CLOUD_PERMISSIONS.has(perm))
    : input.permissions.some((perm) => AUTOMATED_CLOUD_PERMISSIONS.has(perm));
  if (!allowed) return { ok: false, error: "forbidden" };

  return {
    ok: true,
    businessId,
    role: "cashier",
    permissions: new Set(AUTOMATED_CLOUD_PERMISSIONS),
  };
}

/**
 * Resolve replay authority from live membership state, never the event's stored
 * role or the sync registry's descriptive permission. This deliberately enters
 * the same authorize() path used by requirePermission: active membership and
 * tenant checks, effective grants/revocations, current custom role, deployment
 * profile restrictions, and the target branch's scope are all evaluated now.
 */
export async function authorizeSyncReplay(input: {
  locationId: string;
  userId: string;
  permissions: readonly Permission[];
  requireAll?: boolean;
}): Promise<SyncReplayAccess> {
  const { rows } = await withoutTenantScope("authorization-membership", () =>
    query<{ business_id: string; role: Role | null }>(
      `SELECT l.business_id, u.role::text AS role
         FROM locations l
         LEFT JOIN users u ON u.id=$2 AND u.business_id=l.business_id
        WHERE l.id=$1 AND l.is_active`,
      [input.locationId, input.userId],
    ),
  );
  const businessId = rows[0]?.business_id;
  if (!businessId) return { ok: false, error: "unknown_location" };
  if (!rows[0].role) return { ok: false, error: "forbidden" };

  // The role is read live for the required session shape, and authorize()
  // independently re-resolves and returns the current membership role.
  const session = {
    sub: input.userId,
    role: rows[0].role,
    businessId,
    locationId: null,
    fullName: "",
  } as SessionPayload;
  const decision = await authorize(session, {
    ...(input.requireAll
      ? { allPermissions: input.permissions }
      : { anyPermission: input.permissions }),
    locationId: input.locationId,
  });
  if (!decision.ok) return { ok: false, error: "forbidden" };
  return {
    ok: true,
    businessId,
    role: decision.session.role,
    permissions: decision.membership.permissions,
  };
}
