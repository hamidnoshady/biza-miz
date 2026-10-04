import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { normalizePeerBaseUrl } from "@/lib/platform-backup";
import {
  deletePlatformBackupPeer,
  getPlatformBackupConfig,
  upsertPlatformBackupPeer,
} from "@/lib/platform-backup-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Editing a peer keeps its id, so its check history and any restore rows survive. */
export const PUT = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("backup.peer.manage");
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const config = await getPlatformBackupConfig();
  let baseUrl: string | undefined;
  if (body.baseUrl !== undefined) {
    const resolved = normalizePeerBaseUrl(body.baseUrl, { allowInsecure: config.allowInsecurePeers });
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    baseUrl = resolved.url;
  }

  const result = await upsertPlatformBackupPeer(
    {
      id,
      label: typeof body.label === "string" ? body.label : "",
      // An omitted address keeps the stored one — the form may legitimately save
      // a label or a token without resending the URL.
      baseUrl: baseUrl ?? "",
      token: typeof body.token === "string" ? body.token : null,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    },
    session.padmin,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  await platformAudit({
    adminId: session.padmin,
    action: "platform_backup.peer.update",
    entity: "platform_backup_peers",
    entityId: id,
    payload: { baseUrl: result.peer.baseUrl, label: result.peer.label },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ peer: result.peer });
});

/**
 * Forget a peer. This never touches the other server, its artifacts, or any
 * restore already applied from it — it only removes the address and the
 * credential this install would have used.
 */
export const DELETE = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("backup.peer.manage");
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const deleted = await deletePlatformBackupPeer(id);
  await platformAudit({
    adminId: session.padmin,
    action: "platform_backup.peer.delete",
    entity: "platform_backup_peers",
    entityId: id,
    payload: { deleted },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ deleted });
});
