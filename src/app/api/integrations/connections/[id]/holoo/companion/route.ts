import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isHoloo } from "@/lib/integrations/provider-registry";
import { activateHolooCompanion, deactivateHolooCompanion } from "@/lib/integrations/holoo/connection-service";
import { isFeatureEnabled } from "@/lib/features";

/** Set or clear the companion-mode cutover timestamp for one Holoo connection. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;
  const connection = await getAccessibleConnection(session, id);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { active?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.active !== false && !(await isFeatureEnabled(session.businessId, "holoo_companion"))) {
    return NextResponse.json({ error: "feature_disabled", flag: "holoo_companion" }, { status: 403 });
  }

  const result = body.active === false
    ? await deactivateHolooCompanion(session.businessId, id, session.sub)
    : await activateHolooCompanion(session.businessId, id, session.sub);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json(result);
});
