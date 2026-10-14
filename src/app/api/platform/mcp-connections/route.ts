import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope, platformAudit } from "@/lib/platform-auth";
import { platformCan, type PlatformCapability } from "@/lib/platform-admin";
import {
  createPlatformMcpConnection,
  listPlatformMcpConnections,
  revokePlatformMcpConnection,
} from "@/lib/mcp/platform-mcp";
import { PLATFORM_MCP_TOOLS } from "@/lib/mcp/platform-mcp";

const ALL_TOOL_CAPABILITIES = [...new Set(PLATFORM_MCP_TOOLS.map((t) => t.capability))];

/**
 * Console-side management of the platform MCP credentials (issue #883 wave 3).
 *
 * Minting is deliberately owner-only (`admins.manage`): a console token is a
 * machine credential with — depending on the capabilities granted — read or
 * even lifecycle reach into every business on this deployment. The rule the
 * tenant side learned (owner-only `mcp.manage`) applies here with more force,
 * not less.
 *
 * Every mint records a platform audit event whose payload names exactly the
 * capabilities granted — the answer to "who let that robot in, and what did
 * they tell it it could do?".
 */
export const GET = withPlatformScope(async () => {
  const { error, session } = await requirePlatformAdmin();
  if (error) return error;
  const connections = await listPlatformMcpConnections();
  return NextResponse.json({
    connections,
    tools: PLATFORM_MCP_TOOLS.map((t) => ({
      name: t.name,
      capability: t.capability,
      description: t.description,
      bridged: t.bridged,
    })),
    canManage: platformCan(session.role, "admins.manage" as PlatformCapability),
  });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { error, session } = await requirePlatformAdmin();
  if (error) return error;
  if (!platformCan(session.role, "admins.manage" as PlatformCapability)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    adminId?: string;
    name?: string;
    capabilities?: unknown;
    businessIds?: unknown;
    expiresInDays?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "invalid_name" }, { status: 400 });

  const caps = Array.isArray(body.capabilities)
    ? body.capabilities.filter((c): c is PlatformCapability =>
        typeof c === "string" && (ALL_TOOL_CAPABILITIES as string[]).includes(c),
      )
    : [];
  if (caps.length === 0) {
    return NextResponse.json({ error: "invalid_capabilities" }, { status: 400 });
  }

  const businessIds = Array.isArray(body.businessIds)
    ? body.businessIds.filter((x): x is string => typeof x === "string")
    : null;

  const result = await createPlatformMcpConnection({
    adminId: session.padmin,
    name,
    capabilities: caps,
    businessIds,
    expiresInDays: typeof body.expiresInDays === "number" ? body.expiresInDays : null,
  });

  await platformAudit({
    adminId: session.padmin,
    action: "platform_mcp.mint",
    entity: "platform_mcp_connection",
    entityId: result.connection.id,
    payload: { name, capabilities: caps, businessIds, expiresInDays: body.expiresInDays ?? null },
  });

  return NextResponse.json({ connection: result.connection, token: result.token }, { status: 201 });
});

export const DELETE = withPlatformScope(async (request: NextRequest) => {
  const { error, session } = await requirePlatformAdmin();
  if (error) return error;
  if (!platformCan(session.role, "admins.manage" as PlatformCapability)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const ok = await revokePlatformMcpConnection(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await platformAudit({
    adminId: session.padmin,
    action: "platform_mcp.revoke",
    entity: "platform_mcp_connection",
    entityId: id,
  });
  return NextResponse.json({ ok: true });
});
