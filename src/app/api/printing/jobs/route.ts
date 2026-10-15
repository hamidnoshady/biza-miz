import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { formatJalali } from "@/lib/jalali";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MAX_PRINT_REQUEST_ID, SENDING_STALE_AFTER_SECONDS } from "@/lib/printing/routing";
import {
  classifyDeliveryOutcome,
  printerErrorMessage,
  type DeliveryOutcome,
  type PrinterErrorCode,
} from "@/lib/printing/errors";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HistoryJobRow extends Record<string, unknown> {
  id: string;
  document_type: string;
  entity_id: string | null;
  status: string;
  error_code: string | null;
  delivery_outcome?: string | null;
  route_reason?: string | null;
  attempt_number?: number | null;
  previous_job_id?: string | null;
  printer_id?: string | null;
  printer_name: string | null;
  fallback_from_printer_id?: string | null;
  fallback_from_printer_name?: string | null;
  template_id?: string | null;
  template_key: string | null;
  template_name?: string | null;
  template_version: number | null;
  template_paper?: string | null;
  template_source?: string | null;
  print_request_id?: string | null;
  created_at: Date;
  handed_off_at?: Date | null;
}

function resolveRowDeliveryOutcome(row: HistoryJobRow): DeliveryOutcome | "pending" {
  if (
    row.delivery_outcome === "pending" ||
    row.delivery_outcome === "handed_off" ||
    row.delivery_outcome === "not_delivered" ||
    row.delivery_outcome === "ambiguous" ||
    row.delivery_outcome === "connector_unavailable"
  ) {
    return row.delivery_outcome;
  }
  if (row.status === "handed_off") return "handed_off";
  if (row.status === "failed") {
    if (row.error_code === "render_failed") return "not_delivered";
    return classifyDeliveryOutcome({
      ok: false,
      error: (row.error_code as PrinterErrorCode | undefined) ?? "print_failed",
    });
  }
  return "pending";
}

/**
 * Print history for the active branch.
 *
 * Two things this route guarantees, because the printing pipeline is
 * best-effort by contract and history is how an operator finds out what
 * actually happened:
 *
 *  1. **A job never stays «در حال ارسال» forever.** The server stamps a row
 *     `sending` when it renders; the browser closes it. If the browser is
 *     closed, the tab is killed, the machine loses power or the connector
 *     hangs, nothing closes it — so a row left `sending` for longer than
 *     `SENDING_STALE_AFTER_SECONDS` is swept to `failed` with
 *     `job_timeout` and `delivery_outcome = 'ambiguous'` here, on read. The
 *     alternative is a history that shows a receipt as permanently in-flight.
 *  2. **Diagnostics carry provenance.** Every row answers "which printer, which
 *     attempt, which routing reason, which fallback origin, which delivery
 *     outcome, and exactly which template revision produced this?" — the
 *     question support actually asks when a receipt prints wrong.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.printingExecute);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ jobs: [] });
  try {
    await sweepStaleJobs(location.id);
    const { rows } = await query<HistoryJobRow>(
      `SELECT j.id,
              j.document_type,
              j.entity_id,
              j.status,
              j.error_code,
              j.delivery_outcome,
              j.route_reason,
              j.attempt_number,
              j.previous_job_id,
              j.printer_id,
              COALESCE(p.name, j.printer_name) AS printer_name,
              j.fallback_from_printer_id,
              COALESCE(fp.name, j.fallback_from_printer_name) AS fallback_from_printer_name,
              j.template_id,
              j.template_key,
              COALESCE(j.template_name, t.name) AS template_name,
              j.template_version,
              j.template_paper,
              j.template_source,
              j.print_request_id,
              j.created_at,
              j.handed_off_at
         FROM print_jobs j
         LEFT JOIN printers p ON p.id = j.printer_id AND p.location_id = j.location_id
         LEFT JOIN printers fp ON fp.id = j.fallback_from_printer_id AND fp.location_id = j.location_id
         LEFT JOIN print_templates t ON t.id = j.template_id AND t.location_id = j.location_id
        WHERE j.location_id = $1
        ORDER BY j.created_at DESC, j.attempt_number DESC
        LIMIT 20`,
      [location.id],
    );
    return NextResponse.json({
      jobs: rows.map((row) => ({
        id: row.id,
        documentType: row.document_type,
        entityId: row.entity_id,
        status: row.status,
        errorCode: row.error_code,
        errorMessage: row.error_code ? printerErrorMessage(row.error_code) : null,
        deliveryOutcome: resolveRowDeliveryOutcome(row),
        routeReason: row.route_reason ?? "rule",
        attemptNumber: row.attempt_number ?? 1,
        previousJobId: row.previous_job_id ?? null,
        printerId: row.printer_id ?? null,
        printerName: row.printer_name,
        fallbackFromPrinterId: row.fallback_from_printer_id ?? null,
        fallbackFromPrinterName: row.fallback_from_printer_name ?? null,
        templateId: row.template_id ?? null,
        templateKey: row.template_key,
        templateName: row.template_name ?? null,
        templateVersion: row.template_version,
        templatePaper: row.template_paper ?? null,
        templateSource: row.template_source ?? null,
        printRequestId: row.print_request_id ?? null,
        when: formatJalali(row.created_at, { withTime: true }),
      })),
    });
  } catch (err) {
    console.error("listing print jobs failed", err);
    return NextResponse.json({ error: "print_jobs_failed", jobs: [] }, { status: 500 });
  }
});

/**
 * Mark a print ATTEMPT handed off or failed after the local spooler answers.
 *
 * The attempt is addressed by its own id — the one the print endpoint
 * returned when it opened the row (`jobId`) — so two prints of the same
 * receipt are two rows, each closed by the delivery that actually carried it.
 * Before migration 0213 the key was the caller's `print_request_id`, which the
 * screens derive from the document (`receipt:{orderId}`); a retry therefore
 * wrote nothing, and a successful reprint could not be told from the failed
 * first attempt it followed.
 *
 * `printRequestId` is still accepted, and closes that caller's newest in-flight
 * attempt: a browser tab that was open across this deployment keeps working.
 * Only the two terminal states are accepted — `sending` is the server's own
 * opening state, never a client's answer — and a row that is already terminal
 * (swept to `job_timeout`, or closed by the render failure that produced it) is
 * never reopened by a late acknowledgement.
 */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.printingExecute);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ ok: false }, { status: 404 });
  let body: { jobId?: string; printRequestId?: string; status?: string; errorCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (body.status !== "handed_off" && body.status !== "failed") {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const jobId = typeof body.jobId === "string" && JOB_ID.test(body.jobId) ? body.jobId : null;
  const requestId =
    typeof body.printRequestId === "string" && body.printRequestId.length > 0 && body.printRequestId.length <= MAX_PRINT_REQUEST_ID
      ? body.printRequestId
      : null;
  if (!jobId && !requestId) return NextResponse.json({ ok: false }, { status: 400 });
  const errorCode =
    typeof body.errorCode === "string" && /^[a-z_]{1,40}$/.test(body.errorCode) ? body.errorCode : null;

  try {
    await query(
      `UPDATE print_jobs
          SET status = $3,
              error_code = $4,
              handed_off_at = CASE WHEN $3 = 'handed_off' THEN now() ELSE handed_off_at END,
              delivery_outcome = CASE
                WHEN $3 = 'handed_off' THEN 'handed_off'
                WHEN $4 IN ('connector_not_installed', 'connector_outdated', 'connector_unreachable', 'not_in_browser')
                  THEN 'connector_unavailable'
                WHEN $4 IN ('printer_offline', 'printer_not_found', 'network_unreachable', 'spooler_rejected', 'printer_inactive', 'reconnect_required', 'invalid_printer', 'incompatible_printer', 'render_failed')
                  THEN 'not_delivered'
                ELSE 'ambiguous'
              END
        WHERE location_id = $1
          AND status = 'sending'
          AND id = COALESCE(
                $2::uuid,
                (SELECT id FROM print_jobs
                  WHERE location_id = $1 AND print_request_id = $5 AND status = 'sending'
                  ORDER BY created_at DESC, id DESC LIMIT 1)
              )`,
      [location.id, jobId, body.status, errorCode, requestId],
    );
    return NextResponse.json({ ok: true, jobId });
  } catch (err) {
    console.error("updating print job failed", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
});

/**
 * Close jobs whose delivery never reported back. Runs on read, is scoped to
 * one branch, and never touches a row that is already terminal.
 */
async function sweepStaleJobs(locationId: string): Promise<void> {
  try {
    await query(
      `UPDATE print_jobs
          SET status = 'failed',
              error_code = COALESCE(error_code, $3),
              delivery_outcome = 'ambiguous'
        WHERE location_id = $1
          AND status = 'sending'
          AND created_at < now() - make_interval(secs => $2)`,
      [locationId, SENDING_STALE_AFTER_SECONDS, "job_timeout" as PrinterErrorCode],
    );
  } catch (err) {
    console.error("sweeping stale print jobs failed", err);
  }
}
