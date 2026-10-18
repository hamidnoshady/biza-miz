import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import { listInstallations } from "@/lib/support-companion/installations";
import { listTicketDiagnosticRuns } from "@/lib/support-companion/diagnostics";
import { listTicketConsentEvents } from "@/lib/support-companion/consent";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { query } from "@/lib/db";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Authorized support context for a ticket, loaded on demand: requester and
 * business metadata (no secrets), the business's verified installations with
 * freshness, and the latest diagnostic health. An online browser user is not
 * proof the installed companion is online — every installation row carries
 * its own observed `lastContactAt`. */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("support.context.read");
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const ticket = await getSupportTicket(id);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [installations, runs, consentEvents, businessRows, deploymentProfile] = await Promise.all([
    listInstallations(ticket.businessId),
    listTicketDiagnosticRuns(ticket.businessId, id),
    listTicketConsentEvents(ticket.businessId, id),
    query<{ status: string; support_access_policy: string }>(
      `SELECT status::text AS status, support_access_policy FROM businesses WHERE id = $1`,
      [ticket.businessId],
    ),
    readDeploymentProfile(ticket.businessId).catch(() => null),
  ]);
  const business = businessRows.rows[0] ?? null;
  const latestRun = runs[0] ?? null;

  return NextResponse.json({
    context: {
      ticketId: id,
      businessId: ticket.businessId,
      businessName: ticket.businessName,
      locationName: ticket.locationName,
      userName: ticket.userName,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      deploymentProfile: deploymentProfile ?? null,
      businessStatus: business?.status ?? null,
      supportAccessPolicy: business?.support_access_policy ?? null,
      installations: installations.map((installation) => ({
        id: installation.id,
        locationId: installation.locationId,
        locationName: installation.locationName,
        displayName: installation.displayName,
        generation: installation.generation,
        osBuild: installation.osBuild,
        mainVersion: installation.mainVersion,
        companionVersion: installation.companionVersion,
        schemaCompat: installation.schemaCompat,
        enrollmentState: installation.enrollmentState,
        lastContactAt: installation.lastContactAt,
      })),
      latestHealth: latestRun
        ? {
            runId: latestRun.id,
            state: latestRun.state,
            severity: latestRun.severityOverall,
            observedAt: latestRun.observedAt,
            receivedAt: latestRun.receivedAt,
            uploadState: latestRun.uploadState,
            findingCount: latestRun.findings.length,
          }
        : null,
      consent: consentEvents.slice(0, 20).map((event) => ({
        id: event.id,
        installationId: event.installationId,
        subject: event.subject,
        decision: event.decision,
        grantedBy: event.grantedBy,
        expiresAt: event.expiresAt,
        createdAt: event.createdAt,
      })),
    },
  });
});
