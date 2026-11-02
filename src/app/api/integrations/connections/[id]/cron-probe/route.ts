import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { requestCronProbe } from "@/lib/integrations/plugin-service";
import { isPluginJobUnsupportedError } from "@/lib/integrations/plugin-job-guard";
import { cronProbeOffered } from "@/lib/integrations/plugin-cron-probe";

/**
 * Ask this store's plugin to prove its scheduler runs (issue #1206, P0).
 *
 * Deliberately separate from `/test`: that endpoint answers "does this token
 * authenticate", which a store whose WP-Cron never fires answers perfectly. The
 * answer to this one only exists once a *separate* scheduler invocation has run
 * the event, and it arrives later as signed telemetry — so the response says
 * "queued", not "ok", and the panel grades the rest.
 */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Refused on the connection's own advertised capabilities, before anything is
  // written: a REST-mode connection has no plugin scheduler to probe, and an
  // older plugin cannot lease the job.
  if (!cronProbeOffered({ link_mode: connection.link_mode, capabilities: connection.plugin_capabilities })) {
    return NextResponse.json({ ok: false, error: "plugin_job_unsupported" }, { status: 409 });
  }

  try {
    const { jobId, probeId } = await requestCronProbe(session.businessId, id);
    return NextResponse.json({ ok: true, queued: true, probeId, jobId });
  } catch (err) {
    if (isPluginJobUnsupportedError(err)) {
      return NextResponse.json({ ok: false, error: "plugin_job_unsupported" }, { status: 409 });
    }
    throw err;
  }
});
