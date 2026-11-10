import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { retryPlatformCloudUpload } from "@/lib/platform-backup-service";

/**
 * «تلاش دوبارهٔ ارسال» — upload the newest whole-platform artifact again, now
 * (issue #1296).
 *
 * Why a route of its own rather than a flag on `run`:
 *
 *  - `run` takes a *new dump*, which costs minutes and disk. When the only thing
 *    wrong is that the upload never finished, re-dumping does not help and
 *    replaces a good local artifact with another one of the same size. This
 *    route re-uses the artifact that is already on disk and already encrypted.
 *  - The issue's P1 asks for "actionable retry without obscuring technical
 *    diagnostics": the answer carries the redacted classification (provider
 *    code, HTTP status, stage, whether retrying can help) so the operator knows
 *    whether to wait or to fix the destination — never a signed URL, a key or a
 *    provider message body.
 *  - It skips the scheduler's backoff but *not* the per-artifact upload lock: a
 *    double click, or the scheduler firing at the same moment, gets
 *    `upload_in_flight` back instead of two concurrent PUTs of the same key.
 *
 * Needs `backup.run`, the same capability as taking a backup — an engineer may
 * retry an upload because it destroys nothing; restoring stays owner-only.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("backup.run");
  if (error) return error;

  // An optional body lets the console retry a specific artifact (a row's own
  // retry button) rather than only the newest one. The server validates the
  // name; anything that is not one of this product's artifact names is refused.
  let artifact: string | null = null;
  let verify: "size" | "sha256" | undefined;
  try {
    const body = (await request.json()) as { artifact?: unknown; verify?: unknown } | null;
    artifact = typeof body?.artifact === "string" ? body.artifact : null;
    verify = body?.verify === "sha256" ? "sha256" : undefined;
  } catch {
    /* no body = "the newest one", the common case */
  }

  const result = await retryPlatformCloudUpload(session.padmin, { artifact, verify });

  await platformAudit({
    adminId: session.padmin,
    action: "platform_backup.cloud.retry",
    entity: "platform_backup_runs",
    entityId: artifact,
    payload: {
      status: result.status,
      // Diagnostics only: a code, a status class and a stage. No endpoint, no
      // key, no object URL.
      code: result.status === "failed" ? (result.diagnostics.code ?? null) : null,
      providerStatus: result.status === "failed" ? result.diagnostics.providerStatus : null,
      phase: result.status === "failed" ? result.diagnostics.phase : null,
      retryable: result.status === "failed" ? result.retryable : null,
      attempt: result.status === "failed" || result.status === "ok" ? result.attempt : null,
    },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  }).catch(() => undefined);

  return NextResponse.json(
    { result },
    { status: result.status === "failed" ? 502 : 200, headers: { "Cache-Control": "no-store" } },
  );
});
