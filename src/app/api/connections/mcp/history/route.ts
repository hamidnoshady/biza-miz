import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { listMcpHistory } from "@/lib/mcp/connections-service";

/**
 * Issue #883 (UX) — the decided half of a business's MCP trail with
 * pagination, status/connection filters and search. Read-only, and readable
 * by any member who may see the integrations screen; the entries are the
 * connector's own audit rows, never another tenant's.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.mcpManage);
  if (error) return error;

  if (!(await isFeatureEnabled(session.businessId, "api_platform"))) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const limit = Number(params.get("limit") ?? "20");
  const offset = Number(params.get("offset") ?? "0");
  if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
    return NextResponse.json({ error: "invalid_pagination" }, { status: 400 });
  }
  const statusParam = params.get("status");
  const status =
    statusParam === "applied" || statusParam === "failed" || statusParam === "dismissed"
      ? statusParam
      : undefined;

  const page = await listMcpHistory(session.businessId, {
    limit,
    offset,
    status,
    connectionId: params.get("connectionId") ?? undefined,
    search: params.get("q") ?? undefined,
  });

  return NextResponse.json(page);
});
