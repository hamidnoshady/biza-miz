import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { formatJalali } from "@/lib/jalali";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MAX_PRINT_REQUEST_ID, SENDING_STALE_AFTER_SECONDS } from "@/lib/printing/routing";
import type { PrinterErrorCode } from "@/lib/printing/errors";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *     `job_timeout` here, on read. The alternative is a history that shows a
 *     receipt as permanently in-flight.
 *  2. **Diagnostics carry provenance.** Every row answers "which printer, and
 *     exactly which template revision, produced this?" — the question support
 *     actually asks when a receipt prints wrong.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.printingExecute);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ jobs: [] });
  try {
    await sweepStaleJobs(location.id);
    const { rows } = await query<{
      id: string;
      document_type: string;
      entity_id: string | null;
      status: string;
      error_code: string | null;
      created_at: Date;
      printer_name: string | null;
      template_key: string | null;
      template_version: number | null;
    }>(
      `SELECT j.id, j.document_type, j.entity_id, j.status, j.error_code, j.created_at,
              p.name AS printer_name, j.template_key, j.template_version
         FROM print_jobs j
         LEFT JOIN printers p ON p.id = j.printer_id
        WHERE j.location_id = $1
        ORDER BY j.created_at DESC
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
        printerName: row.printer_name,
        templateKey: row.template_key,
        templateVersion: row.template_version,
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
              handed_off_at = CASE WHEN $3 = 'handed_off' THEN now() ELSE handed_off_at END
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
              error_code = COALESCE(error_code, $3)
        WHERE location_id = $1
          AND status = 'sending'
          AND created_at < now() - make_interval(secs => $2)`,
      [locationId, SENDING_STALE_AFTER_SECONDS, "job_timeout" as PrinterErrorCode],
    );
  } catch (err) {
    console.error("sweeping stale print jobs failed", err);
  }
}
