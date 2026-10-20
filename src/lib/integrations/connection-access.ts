/** Live branch checks for the hub's operational routes. Tenant checks remain
 * in the service SQL and in RLS; a permission alone does not grant all branches. */
import { query } from "../db";
import type { SessionPayload } from "../auth-edge";
import { accessibleLocationsFor } from "../setup-state";
import { getConnection, listConnections } from "./connections-service";

export async function connectionLocationAccess(session: SessionPayload) {
  // Deactivation must not strand active credentials or retained history.
  // Include inactive branches, but still re-read role and assignments; do not
  // widen a restricted manager just because a branch is no longer switchable.
  const access = await accessibleLocationsFor(session, { includeInactive: true });
  const ids = new Set(access.locations.map((location) => location.id));
  return (locationId: string | null) => locationId !== null
    ? ids.has(locationId)
    : ids.size === access.businessLocationCount;
}

export async function getAccessibleConnection(session: SessionPayload, id: string) {
  const [connection, allows] = await Promise.all([
    getConnection(session.businessId, id), connectionLocationAccess(session),
  ]);
  return connection && allows(connection.location_id) ? connection : null;
}

export async function listAccessibleConnections(session: SessionPayload) {
  const [connections, allows] = await Promise.all([
    listConnections(session.businessId), connectionLocationAccess(session),
  ]);
  return connections.filter((connection) => allows(connection.locationId));
}

/** Historical diagnostics remain readable after disconnect, under branch scope. */
export async function canReadConnectionHistory(session: SessionPayload, id: string) {
  const [{ rows }, allows] = await Promise.all([
    query<{ location_id: string | null }>(
      `SELECT location_id FROM integration_connections WHERE business_id = $1 AND id = $2`,
      [session.businessId, id],
    ), connectionLocationAccess(session),
  ]);
  return Boolean(rows[0] && allows(rows[0].location_id));
}
