import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { revokePlatformBackupToken } from "@/lib/platform-backup-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Revoke one peer credential. Immediate, not at token expiry: "the migration is
 * finished" and "that address is no longer ours" are both reasons to stop
 * answering a server today. Idempotent — revoking an already-revoked row is a
 * success, because the caller's intent (it must not work any more) is satisfied.
 */
export const DELETE = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("backup.share");
  if (error) return error;

  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const revoked = await revokePlatformBackupToken(id);
  await platformAudit({
    adminId: session.padmin,
    action: "platform_backup.token.revoke",
    entity: "platform_backup_tokens",
    entityId: id,
    payload: { changed: revoked },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ revoked });
});
