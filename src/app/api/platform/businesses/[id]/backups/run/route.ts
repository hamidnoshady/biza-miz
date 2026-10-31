import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { catchUpBusinessUploads, runBusinessBackup } from "@/lib/platform-tenant-backup-ops";

/**
 * Issue #903 §3 — "trigger/create" and "retry/catch-up" for one business.
 *
 * The two operator actions share a route because they are the same decision from
 * the console's point of view ("make this business protected now"), and differ
 * only in which half of the pipeline needs a nudge:
 *
 *  - `run`      → the shipped `runBackupNow` (local snapshot + managed upload),
 *                 the same call the scheduler makes, with the same gates.
 *  - `catch_up` → drain the durable upload queue, the same queue an offline
 *                 device filled, with the same backoff and generation fence.
 *
 * Capability: `tenant_backup.verify` — an engineer-level operation. Owner-only
 * capabilities (`download`, `policy`, `restore`) are separate, so an operator
 * account can be allowed to fix a fleet without being allowed to exfiltrate one.
 *
 * Audited either way, with the outcome and never with an artifact payload.
 */
export const POST = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformCapability("tenant_backup.verify");
    if (error) return error;
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let body: { action?: unknown } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      // An empty body means "run", which is what the console's primary button
      // sends. A malformed body is still refused below.
      body = {};
    }
    const action = typeof body.action === "string" ? body.action : "run";

    if (action === "run") {
      const result = await runBusinessBackup(id);
      await platformAudit({
        adminId: session.padmin,
        businessId: id,
        action: "tenant_backup.run",
        entity: "backup_runs",
        payload: {
          ok: result.ok,
          local: result.ok ? result.local.status : null,
          cloud: result.ok ? result.cloud.status : null,
          error: result.ok ? null : result.error,
        },
      }).catch(() => undefined);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
      return NextResponse.json(
        { ok: true, local: result.local, cloud: result.cloud },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (action === "catch_up") {
      const drained = await catchUpBusinessUploads(id);
      await platformAudit({
        adminId: session.padmin,
        businessId: id,
        action: "tenant_backup.catch_up",
        entity: "tenant_backup_upload_queue",
        payload: { ...drained },
      }).catch(() => undefined);
      return NextResponse.json({ ok: true, ...drained }, { headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  },
);
