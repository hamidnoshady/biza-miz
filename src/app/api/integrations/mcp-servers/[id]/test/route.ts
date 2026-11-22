import { NextRequest, NextResponse } from "next/server";

import { requirePermission, withTenantScope } from "@/lib/auth";
import { OutboundMcpError } from "@/lib/mcp/outbound/client";
import { discoverExternalMcpServer } from "@/lib/mcp/outbound/service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * "Test connection": `initialize` + `tools/list`, persisted (issue #1473).
 *
 * This is the only route that performs discovery, and it is a **write** — it
 * replaces the cached tool list, so it needs `integrations.manage`, not the view
 * grant. The status mapping is deliberate: a refused target is 403 (the operator
 * can fix it by allowlisting), a failing server is 502 (nothing here to fix), and
 * a missing row is 404. The response never echoes the credential or the raw error
 * body; the bounded message is already stored on the row as `lastError`.
 */
export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;

  const { id } = await context.params;

  try {
    const result = await discoverExternalMcpServer(session.businessId, id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
    }
    return NextResponse.json({ info: result.data.info, server: result.data.server });
  } catch (failure) {
    const code = failure instanceof OutboundMcpError ? failure.code : "unknown";
    const status = code === "target_refused" ? 403 : code === "timeout" ? 504 : 502;
    return NextResponse.json({ error: "discovery_failed", reason: code }, { status });
  }
});
