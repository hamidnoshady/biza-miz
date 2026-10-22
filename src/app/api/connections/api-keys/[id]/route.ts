import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { revokeApiKey } from "@/lib/api-keys-service";

/**
 * Revoke one key. Deliberately not a delete: the row is what
 * `api_request_log` references, and "this key existed and was withdrawn on
 * this date" is the answer an audit needs.
 */
export const DELETE = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.apiManage);
  if (error) return error;
  const { id } = await context.params;

  const revoked = await revokeApiKey(session.businessId, id);
  if (!revoked) return NextResponse.json({ error: "api_key_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
