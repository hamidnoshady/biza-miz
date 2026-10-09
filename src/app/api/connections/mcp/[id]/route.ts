import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { revokeMcpConnection, updateMcpConnectionAccess } from "@/lib/mcp/connections-service";

/**
 * Narrow or withdraw one connection.
 *
 * `PATCH` exists so an owner who has second thoughts about a connector can take
 * the writes away — or drop it to approval-only — without going back to their
 * phone and re-running the whole OAuth flow. Widening works the same way, and is
 * equally the owner's call: the route does not distinguish, because "you may
 * only ever reduce" would just mean deleting and re-adding.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.mcpManage);
    if (error) return error;
    const { id } = await context.params;

    let body: { scopes?: unknown; writeMode?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const result = await updateMcpConnectionAccess(session.businessId, id, {
      scopes: body.scopes,
      writeMode: body.writeMode,
      // Re-recorded on every change: the person whose authority the connection's
      // writes run under is whoever last said what it may do.
      authorizedBy: session.sub,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.error === "connection_not_found" ? 404 : 400 },
      );
    }
    return NextResponse.json({ connection: result.connection });
  },
);

/**
 * Revoke. Deliberately not a delete: the row is what `ai_action_audit`
 * references, and "this connector existed, did these things, and was withdrawn
 * on this date" is the answer an audit needs. Its OAuth tokens are deleted with
 * it — they can authenticate nothing once the connection is revoked.
 */
export const DELETE = withTenantScope(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.mcpManage);
    if (error) return error;
    const { id } = await context.params;

    const revoked = await revokeMcpConnection(session.businessId, id);
    if (!revoked) return NextResponse.json({ error: "connection_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
