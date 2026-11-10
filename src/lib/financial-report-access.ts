import type { SessionPayload } from "./auth";
import { accessibleLocationsFor } from "./setup-state";

/** Every report needs the live branch scope, including historical branches. */
export async function financialReportAccess(session: SessionPayload) {
  const { locations, businessLocationCount } = await accessibleLocationsFor(session, { includeInactive: true });
  return {
    allowedLocationIds: locations.length === businessLocationCount
      ? null
      : locations.map(({ id }) => id),
  };
}
