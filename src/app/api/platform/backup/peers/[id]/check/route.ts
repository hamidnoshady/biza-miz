import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { checkPeer } from "@/lib/platform-backup-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * «بررسی اتصال» — ask the peer what it has, and answer the question the
 * operator is really asking: *could this install restore it?*
 *
 * So the reply is not just the artifact list. It carries the peer's manifest
 * (migration count, Postgres major, business count — what its backups contain)
 * beside this install's own snapshot, and the compatibility warnings
 * `checkPeerManifest` produced. Nothing is downloaded and nothing is written:
 * a check that could not be run casually would not be run before a migration,
 * which is exactly when it matters.
 */
export const POST = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("backup.peer.manage");
  if (error) return error;

  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await checkPeer(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
});
