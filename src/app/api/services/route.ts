import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  listBusinessServices,
  listServiceRuntimeSummary,
} from "@/lib/service-activation/activation-service";

/**
 * The business's «سرویس‌ها» list (issue #1041): the four apps, the separately
 * priced My Workspace capabilities and any agent/routine the business runs,
 * each with its live state, whether setup was already paid, its retention
 * deadline and the hours it has accrued.
 *
 * Read-only and permission-gated by `billing.view`: the state itself is not
 * secret from a member who may see the ledger, and the spending decision is
 * enforced server-side on the mutation routes.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;

  const [services, runtime] = await Promise.all([
    listBusinessServices(session.businessId),
    listServiceRuntimeSummary(session.businessId),
  ]);
  return NextResponse.json({ services, runtime });
});
