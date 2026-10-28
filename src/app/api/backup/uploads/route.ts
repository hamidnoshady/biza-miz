import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { startUploadSession } from "@/lib/tenant-backup-transport";

/**
 * Issue #903 §3 — start a resumable upload of an artifact the tenant owns.
 *
 * The declared size is checked here, against the platform's own ceiling; the
 * checksum is optional at start and required in spirit at completion (a session
 * without one is hashed and compared against itself, which still proves the
 * received bytes are the bytes that stay). Nothing is registered as an artifact
 * until `complete`, and nothing becomes restorable until `verify`.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const payload = (body ?? {}) as { expectedBytes?: unknown; sha256?: unknown };
  const expectedBytes = Number(payload.expectedBytes);
  const sha256 = typeof payload.sha256 === "string" ? payload.sha256 : null;

  const started = await startUploadSession({
    businessId: session.businessId,
    expectedBytes,
    sha256,
    createdBy: session.sub,
  });
  if (!started.ok) return NextResponse.json({ error: started.error }, { status: 400 });
  return NextResponse.json(
    {
      token: started.session.token,
      chunkBytes: started.chunkBytes,
      receivedBytes: started.session.receivedBytes,
      expiresAt: started.session.expiresAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
