import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getConnection, testConnection } from "@/lib/integrations/connections-service";
import { testHolooConnection } from "@/lib/integrations/holoo/connection-service";
import { isHoloo } from "@/lib/integrations/provider-registry";

export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (isHoloo(connection)) {
    const result = await testHolooConnection(session.businessId, id);
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.error === "not_found" ? 404 : 502 });
    return NextResponse.json({
      ok: true,
      version: result.version,
      fingerprint: result.fingerprint,
      profile: result.profile ?? null,
      diagnostics: result.diagnostics ?? [],
      migrationReady: Boolean(result.profile),
    });
  }

  const result = await testConnection(session.businessId, id);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.error === "not_found" ? 404 : 502 });
  return NextResponse.json({ ok: true });
});
