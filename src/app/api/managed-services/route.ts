import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertTenantSafePayload } from "@/lib/managed-services/contract";
import { getTenantManagedServices } from "@/lib/managed-services/readiness-service";

/**
 * Issue #902 §9 item 5 — every managed service's readiness for this business.
 *
 * `billing.view` rather than a feature permission: the states this reports are
 * commercial (plan, wallet, usage limit) and its actions are the billing pages,
 * so the permission that already reads those is the one that reads this. The
 * payload is the contract's shape and nothing else — no provider, no account id,
 * no wholesale figure — and it goes through the leak guard on the way out.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;

  const services = await getTenantManagedServices(session.businessId);
  return NextResponse.json(
    assertTenantSafePayload({ services, checkedAt: new Date().toISOString() }),
  );
});
