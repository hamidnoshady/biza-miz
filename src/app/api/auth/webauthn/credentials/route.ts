import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { PIN_ROLES } from "@/lib/roles";
import { listWebauthnCredentials } from "@/lib/employee-service";

/** The caller's own registered authenticators, for the "manage biometric login" panel. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole(...PIN_ROLES);
  if (error) return error;

  const credentials = await listWebauthnCredentials(session.sub, session.businessId);
  return NextResponse.json({ credentials });
});
