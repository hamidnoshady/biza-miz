import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isHoloo } from "@/lib/integrations/provider-registry";
import { armDirectSqlFor } from "@/lib/integrations/holoo/push-service";
import { HOLOO_DIRECT_SQL_CONFIRMATION_PHRASE } from "@/lib/integrations/holoo/direct-sql";

/** Arm guarded direct-SQL writes for one Holoo connection. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;
  const connection = await getAccessibleConnection(session, id);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { confirmation?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await armDirectSqlFor(session.businessId, id, body.confirmation ?? "", session.sub);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, confirmationPhrase: HOLOO_DIRECT_SQL_CONFIRMATION_PHRASE },
      { status: result.error === "not_found" ? 404 : 400 },
    );
  }
  return NextResponse.json({ ok: true });
});
