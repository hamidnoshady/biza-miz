import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { formatJalali } from "@/lib/jalali";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { SENDING_STALE_AFTER_SECONDS } from "@/lib/printing/routing";
import type { PrinterErrorCode } from "@/lib/printing/errors";

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
 * Mark a job handed off or failed after the local spooler answers. Only these
 * two terminal states are accepted: `sending` is the server's own opening
 * state, never a client's answer.
 */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.printingExecute);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ ok: false }, { status: 404 });
  let body: { printRequestId?: string; status?: string; errorCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (!body.printRequestId || (body.status !== "handed_off" && body.status !== "failed")) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  try {
    await query(
      `UPDATE print_jobs
          SET status = $3,
              error_code = $4,
              handed_off_at = CASE WHEN $3 = 'handed_off' THEN now() ELSE handed_off_at END
        WHERE location_id = $1 AND print_request_id = $2`,
      [location.id, body.printRequestId.slice(0, 80), body.status, body.errorCode ?? null],
    );
    return NextResponse.json({ ok: true });
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
