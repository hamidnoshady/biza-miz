import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireCompanionSession } from "@/lib/support-companion/companion-auth";
import { recordDiagnosticRun } from "@/lib/support-companion/diagnostics";
import { recordInstallationContact } from "@/lib/support-companion/installations";

/** The companion uploads one run's redacted findings for its ticket-bound
 * request. Requires the session's `report.upload` scope; findings are
 * redacted again server-side before persistence, and server receipt is
 * acknowledged here — the only path that clears the `not_sent` label. */
export async function POST(request: NextRequest) {
  const auth = await requireCompanionSession(request);
  if ("response" in auth) return auth.response;
  const session = auth.session;
  if (!session.scope.includes("report.upload") && !session.scope.includes("diagnostics.run")) {
    return NextResponse.json({ error: "scope_insufficient" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const state = typeof body.state === "string" ? body.state : "";
  if (!requestId || !state) {
    return NextResponse.json({ error: "request_and_state_required" }, { status: 400 });
  }

  const recorded = await withTenant(session.businessId, async () => {
    const result = await recordDiagnosticRun({
      businessId: session.businessId,
      requestId,
      state,
      expectTicketId: session.ticketId,
      expectInstallationId: session.installationId,
      collectorVersions:
        body.collectorVersions && typeof body.collectorVersions === "object"
          ? (body.collectorVersions as Record<string, unknown>)
          : {},
      coverage:
        body.coverage && typeof body.coverage === "object"
          ? (body.coverage as Record<string, unknown>)
          : {},
      findings: Array.isArray(body.findings) ? body.findings : [],
      severityOverall:
        body.severityOverall === "ok" ||
        body.severityOverall === "warning" ||
        body.severityOverall === "failed"
          ? body.severityOverall
          : "unknown",
      observedAt: typeof body.observedAt === "string" ? body.observedAt : null,
    });
    if (result.ok) {
      const versions =
        body.versions && typeof body.versions === "object"
          ? (body.versions as Record<string, string>)
          : {};
      await recordInstallationContact(session.businessId, session.installationId, {
        mainVersion: typeof versions.mainVersion === "string" ? versions.mainVersion : undefined,
        companionVersion:
          typeof versions.companionVersion === "string" ? versions.companionVersion : undefined,
      }).catch(() => {});
    }
    return result;
  });

  if (!recorded.ok) {
    const status =
      recorded.error === "invalid_state" ? 400 : recorded.error === "scope_mismatch" ? 403 : 404;
    return NextResponse.json({ error: recorded.error }, { status });
  }
  return NextResponse.json(
    { run: recorded.run, redaction: recorded.redaction },
    { status: 201 },
  );
}
