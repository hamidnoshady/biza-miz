import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import {
  createPlatformBackupToken,
  getPlatformBackupConfig,
  listPlatformBackupTokens,
} from "@/lib/platform-backup-service";
import { generateSyncToken } from "@/lib/sync-token";

/**
 * The credentials other servers present to this one's `/api/peer/backup/*`
 * endpoints (migration 0132).
 *
 * Needs `backup.share` (issue #807): a token is custody of a full copy of every
 * tenant's data, handed to another machine. An engineer runs and verifies
 * backups; only an owner decides who else may pull one.
 *
 * A token is generated here and shown exactly once: the row keeps only its
 * sha256, so a database dump — or a screenshot of this page — cannot hand over
 * working access to every backup this server has ever taken. What the list does
 * carry is the tail of each token, its use count and its last use, which is how
 * an operator tells "the token for the new server" from "the one for the NAS
 * importer" when it is time to revoke one.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("backup.share");
  if (error) return error;
  const [tokens, config] = await Promise.all([listPlatformBackupTokens(), getPlatformBackupConfig()]);
  return NextResponse.json({ tokens, servingEnabled: config.servingEnabled });
});

/**
 * Mint one. `token` in the body is optional: an operator pasting the secret the
 * OLD server already shows them (the usual migration direction) gets that exact
 * value registered here, and the pair simply agree. Omitting it asks this
 * server to generate one for the peer to be given.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("backup.share");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return NextResponse.json({ error: "missing_label" }, { status: 400 });
  const days = body.expiresInDays === undefined || body.expiresInDays === null ? null : Number(body.expiresInDays);
  if (days !== null && (!Number.isFinite(days) || days < 1 || days > 3650)) {
    return NextResponse.json({ error: "invalid_expiry" }, { status: 400 });
  }

  const result = await createPlatformBackupToken({
    label,
    token: typeof body.token === "string" ? body.token : generateToken(),
    expiresInDays: days,
    platformAdminId: session.padmin,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  await platformAudit({
    adminId: session.padmin,
    action: "platform_backup.token.create",
    entity: "platform_backup_tokens",
    entityId: result.id,
    // Deliberately not the token itself — the audit log is readable, the secret is not.
    payload: { label, hint: result.hint, expiresInDays: days },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json({ token: result.token, hint: result.hint, id: result.id });
});

/**
 * The token a peer is given, when the operator does not paste one: the same
 * shape the server-sync realm issues (see src/lib/sync-token.ts) — checksummed
 * and grouped, so a mis-copied character is caught at the other server's input
 * instead of surfacing as a silent 401 in the middle of a migration.
 */
function generateToken(): string {
  return generateSyncToken();
}
