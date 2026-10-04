import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { normalizePeerBaseUrl } from "@/lib/platform-backup";
import {
  getPlatformBackupConfig,
  listPlatformBackupPeers,
  upsertPlatformBackupPeer,
} from "@/lib/platform-backup-service";

/**
 * The servers this install may restore FROM (migration 0132) — the "address"
 * half of the feature: on the new server, add the old server's address and the
 * token it issued, and its backups become selectable.
 *
 * The list is masked: `hasToken` + a tail, never the credential itself, which
 * the peer row needs server-side and the browser has no business holding.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("backup.peer.manage");
  if (error) return error;
  return NextResponse.json({ peers: await listPlatformBackupPeers() });
});

/**
 * Add (or re-add by label) a peer. The address is validated here rather than at
 * request time, so a typo is reported to the person who typed it: an operator
 * who writes `http://` while the config forbids plain http gets
 * `https_required`, not a mysterious network failure three dialogs later.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("backup.peer.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const config = await getPlatformBackupConfig();
  const resolved = normalizePeerBaseUrl(body.baseUrl, { allowInsecure: config.allowInsecurePeers });
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const result = await upsertPlatformBackupPeer(
    {
      label: typeof body.label === "string" ? body.label : "",
      baseUrl: resolved.url,
      token: typeof body.token === "string" ? body.token : null,
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
    },
    session.padmin,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  await platformAudit({
    adminId: session.padmin,
    action: "platform_backup.peer.save",
    entity: "platform_backup_peers",
    entityId: result.peer.id,
    payload: { label: result.peer.label, baseUrl: result.peer.baseUrl, tokenSet: result.peer.hasToken },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ peer: result.peer });
});
