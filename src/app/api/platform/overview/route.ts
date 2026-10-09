/**
 * The super-admin overview dashboard aggregation (task section 3). Read-only,
 * any authenticated admin; one batched query behind `getPlatformOverview`.
 *
 * Migration status is computed by the one shared service
 * (`@/lib/migration-status-service.ts`) — the same call the system route makes —
 * so the two surfaces cannot classify a pending, gated or unreadable migration
 * inventory differently.
 */
import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { getMigrationStatus } from "@/lib/migration-status-service";
import { getPlatformOverview } from "@/lib/platform-overview-service";

export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const migrations = await getMigrationStatus();
  return NextResponse.json({ overview: await getPlatformOverview(migrations) });
});
