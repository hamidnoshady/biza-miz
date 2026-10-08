/**
 * Platform health for the system page: applied migrations and how many are
 * pending, the live connection-pool figures, whether RLS is actually being
 * enforced (the app must not connect as a superuser or bypass role), the most
 * recent backup per business, and headline counts. Read-only — a dashboard,
 * not a control surface.
 *
 * Migration status comes from the one shared service
 * (`@/lib/migration-status-service.ts`) rather than a per-route count of
 * unrecorded files: the deliberately deferred
 * `0209_ai_gateway_secret_cutover.sql` must be reported as a gated cleanup
 * awaiting operator verification, not as "running code is ahead of the
 * database — run npm run db:migrate".
 */
import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { getMigrationStatus } from "@/lib/migration-status-service";
import { systemStatus } from "@/lib/platform-service";

export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const migrations = await getMigrationStatus();
  return NextResponse.json({ status: await systemStatus(migrations) });
});
