import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { rotateLinkToken } from "@/lib/integrations/connections-service";

/**
 * Rotate a plugin connection's link token.
 *
 * Owner-only, unlike the rest of the connection routes (Owner/Manager): this
 * is the credential that lets a WordPress install write orders and journal
 * entries into the business, and rotating it is both the recovery action after
 * a compromised store and, until the new token is pasted into WordPress, an
 * outage. The new value is returned exactly once.
 */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.apiManage);
  if (error) return error;
  const { id } = await context.params;

  const result = await rotateLinkToken(session.businessId, id, session.sub);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  }

  const response = NextResponse.json({ linkToken: result.linkToken });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
