import { NextRequest, NextResponse } from "next/server";

import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  createExternalMcpServer,
  listExternalMcpServers,
  type ExternalMcpFailure,
} from "@/lib/mcp/outbound/service";

/**
 * External MCP servers a tenant has registered (issue #1473).
 *
 * Read is `integrations.view`, write is `integrations.manage` — the same pair the
 * WooCommerce and Holoo connections use, because this is the same kind of object:
 * a tenant-owned integration with a credential. The credential is write-only in
 * both directions; no response from this file can contain it.
 */

function failureStatus(reason: ExternalMcpFailure): number {
  switch (reason) {
    case "not_found":
      return 404;
    case "duplicate_slug":
      return 409;
    case "url_not_allowed":
      return 403;
    case "missing_credential":
    case "invalid_slug":
    case "invalid_label":
    case "invalid_url":
      return 400;
    default:
      return 400;
  }
}

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;
  return NextResponse.json({ servers: await listExternalMcpServers(session.businessId) });
});

interface CreateBody {
  slug?: unknown;
  label?: unknown;
  url?: unknown;
  authKind?: unknown;
  bearerToken?: unknown;
  enabled?: unknown;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const authKind = body.authKind === "bearer" ? "bearer" : "none";
  const result = await createExternalMcpServer({
    authKind,
    bearerToken: typeof body.bearerToken === "string" ? body.bearerToken : null,
    businessId: session.businessId,
    createdBy: session.sub ?? null,
    enabled: body.enabled === true,
    label: typeof body.label === "string" ? body.label : "",
    slug: typeof body.slug === "string" ? body.slug : "",
    url: typeof body.url === "string" ? body.url : "",
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: failureStatus(result.error) });
  return NextResponse.json({ server: result.data }, { status: 201 });
});
