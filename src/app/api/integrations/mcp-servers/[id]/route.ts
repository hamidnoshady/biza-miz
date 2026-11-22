import { NextRequest, NextResponse } from "next/server";

import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  deleteExternalMcpServer,
  getExternalMcpServer,
  updateExternalMcpServer,
  type ExternalMcpFailure,
} from "@/lib/mcp/outbound/service";

/**
 * One registered external MCP server (issue #1473).
 *
 * `PATCH` treats an **absent** `bearerToken` as "leave the stored credential
 * alone" — the panel never receives the secret, so a save that omitted the field
 * must not wipe it. Sending `bearerToken: ""` is an explicit attempt to clear a
 * bearer server's only credential and is refused by the service.
 */

function failureStatus(reason: ExternalMcpFailure): number {
  switch (reason) {
    case "not_found":
      return 404;
    case "url_not_allowed":
      return 403;
    default:
      return 400;
  }
}

interface PatchBody {
  label?: unknown;
  url?: unknown;
  authKind?: unknown;
  bearerToken?: unknown;
  enabled?: unknown;
  allowedTools?: unknown;
}

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;

  const { id } = await context.params;
  const server = await getExternalMcpServer(session.businessId, id);
  if (!server) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ server });
});

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;

  const { id } = await context.params;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const result = await updateExternalMcpServer({
    allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.map(String) : undefined,
    authKind: body.authKind === "bearer" ? "bearer" : body.authKind === "none" ? "none" : undefined,
    bearerToken: typeof body.bearerToken === "string" ? body.bearerToken : undefined,
    businessId: session.businessId,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    id,
    label: typeof body.label === "string" ? body.label : undefined,
    url: typeof body.url === "string" ? body.url : undefined,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: failureStatus(result.error) });
  return NextResponse.json({ server: result.data });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;

  const { id } = await context.params;
  const deleted = await deleteExternalMcpServer(session.businessId, id);
  return deleted
    ? NextResponse.json({ deleted: true })
    : NextResponse.json({ error: "not_found" }, { status: 404 });
});
