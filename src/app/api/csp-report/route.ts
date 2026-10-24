import { NextRequest, NextResponse } from "next/server";
import { CSP_REPORT_MAX_BYTES, createCspReportLog, parseCspReports } from "@/lib/csp-report";
import { readBoundedJson } from "@/lib/product-attributes";

/**
 * Issue #1003 — where browsers post Content-Security-Policy violations
 * (`report-uri` / `report-to` in src/lib/security-headers.ts).
 *
 * Session-less by necessity: browsers send these without credentials, from
 * any page, before or after sign-in. It therefore reads nothing, writes no
 * row and answers the same empty 204 to everything — a caller learns nothing
 * from it. Each violation becomes one sanitized log line (origin + path only,
 * never a query string or a script sample; see src/lib/csp-report.ts), under a
 * per-process line budget so a flood costs log volume at most.
 *
 * This is what makes a report-only window mean something: before it, the
 * policy reported to nobody, so nobody could tell whether enforcing it on a
 * production stack would break a screen.
 */
const violations = createCspReportLog();

export async function POST(request: NextRequest) {
  const body = await readBoundedJson(request, CSP_REPORT_MAX_BYTES);
  if (body.ok) violations.record(parseCspReports(body.value));
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
