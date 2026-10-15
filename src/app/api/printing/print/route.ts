import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  resolvePrintPlan,
  type PrintBranding,
  type PrintDocumentType,
  type PrintPlan,
  type ResolvedTemplate,
} from "@/lib/printing/plan";
import { preparePrint, printerRefusal, type PrintJob } from "@/lib/printing/render-service";
import { printerTargetOf } from "@/lib/printing/types";
import { defaultDocumentTypeFor, documentTypesFor, parsePrintRequest } from "@/lib/printing/document-request";
import { loadPrintDocument } from "@/lib/printing/document-loader";
import { CONFIRMED_PRE_HANDOFF_ERRORS, type PrinterErrorCode } from "@/lib/printing/errors";

/**
 * The one hardware print endpoint: resolve the print plan for the caller's
 * branch, load the document the request names from this branch's own rows,
 * render it to canonical bytes on the authenticated app server, and hand them
 * back for local delivery.
 *
 * The request is an **intent**, not output, and it is not an assertion about
 * the business either. It carries a document *reference* (an order id, a
 * barcode's item) plus an optional printer/template id; the server loads the
 * document, so the receipt a customer walks out with is built from the sale's
 * rows and the label's bars point at the catalogue row they name:
 *
 *  - no `html` job type exists — the server renders in Chromium, and accepting
 *    a client's markup would let every `printingExecute` role point that
 *    browser, and therefore the server's network position, anywhere it liked
 *    (see printing/chromium.ts);
 *  - no `connection`/`target` in the body is read: printer and template ids
 *    are resolved against the caller's active location, so a hand-edited body
 *    can neither print through another branch's printer nor aim the server at
 *    an arbitrary IP, queue or port — and a document reference from another
 *    branch does not resolve either;
 *  - no browser-built `ReceiptData`/`KitchenTicketData`/`LabelData` is
 *    accepted any more (`document_required`): a price, a branch or a line a
 *    client made up cannot reach paper.
 *
 * History is written for **every** attempt — the row is opened here, addressed
 * by its own id, and closed here when the render itself fails; the browser
 * closes it once the local spooler answers. `print_request_id` is the caller's
 * correlation id, recorded for support, never a uniqueness key (migration
 * 0213 explains why attempts must not collapse).
 *
 * On a runtime fallback attempt (`failedPrinterId` / `previousJobId`), attempt
 * 2 is bound to attempt 1's persisted `render_snapshot` (exact resolved
 * document, template revision, branding, and rendering inputs) so concurrent
 * database edits between attempt 1 and attempt 2 are never silently reloaded.
 */
export const runtime = "nodejs";

/**
 * A request carries ids and a document reference — a few hundred bytes. The
 * ceiling exists so the endpoint cannot be used as a general-purpose upload
 * sink now that no document data travels through it at all.
 */
const MAX_BODY_BYTES = 16 * 1024;

export type JobRouteReason =
  | "explicit"
  | "rule"
  | "fallback"
  | "runtime_fallback"
  | "default"
  | "only"
  | "none";

export interface PrintOperationSnapshot {
  documentType: PrintDocumentType;
  entityId: string | null;
   requestedEntityRefId: string | null;
  documentSource: string;
  job: PrintJob;
  template: ResolvedTemplate;
  branding: PrintBranding;
  primaryPrinterId: string;
  primaryPrinterName: string;
  backupPrinterId: string | null;
  backupPrinterName: string | null;
}

interface PriorAttemptRecord extends Record<string, unknown> {
  id: string;
  document_type: string;
  entity_id: string | null;
  printer_id: string | null;
  printer_name: string | null;
  template_id: string | null;
  template_key: string | null;
  template_version: number | null;
  template_name: string | null;
  template_paper: string | null;
  template_source: string | null;
  status: string;
  error_code: string | null;
  delivery_outcome: string | null;
  attempt_number: number;
  previous_job_id: string | null;
  print_request_id: string | null;
  render_snapshot: PrintOperationSnapshot | null;
  has_fallback_attempt: boolean;
}

interface CachedAttemptEntry {
  jobId: string | null;
  locationId: string;
  printRequestId: string | null;
  attemptNumber: number;
  hasFallbackAttempt: boolean;
  snapshot: PrintOperationSnapshot;
}

const MAX_CACHED_SNAPSHOTS = 200;
const snapshotCacheByRequest = new Map<string, CachedAttemptEntry>();
const snapshotCacheByJobId = new Map<string, CachedAttemptEntry>();

function rememberAttemptSnapshot(entry: CachedAttemptEntry): void {
  if (entry.printRequestId) {
    const key = `${entry.locationId}:${entry.printRequestId}`;
    if (snapshotCacheByRequest.size >= MAX_CACHED_SNAPSHOTS) {
      const oldest = snapshotCacheByRequest.keys().next().value;
      if (oldest) snapshotCacheByRequest.delete(oldest);
    }
    snapshotCacheByRequest.set(key, entry);
  }
  if (entry.jobId) {
    const key = `${entry.locationId}:${entry.jobId}`;
    if (snapshotCacheByJobId.size >= MAX_CACHED_SNAPSHOTS) {
      const oldest = snapshotCacheByJobId.keys().next().value;
      if (oldest) snapshotCacheByJobId.delete(oldest);
    }
    snapshotCacheByJobId.set(key, entry);
  }
}

export function clearPrintSnapshotCacheForTests(): void {
  snapshotCacheByRequest.clear();
  snapshotCacheByJobId.clear();
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.printingExecute);
  if (error) return error;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const parsed = parsePrintRequest(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: parsed.status });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ ok: false, error: "printer_not_configured" }, { status: 404 });

  const documentType: PrintDocumentType =
    parsed.documentType ??
    (parsed.source.kind === "document"
      ? defaultDocumentTypeFor(parsed.source.document)
      : parsed.source.job.type === "test"
        ? parsed.source.job.kind
        : // The drawer hangs off the receipt printer (ESC p), so its plan is
          // the receipt plan — a caller does not have to say so.
          "receipt");

  // Refuse a document/type mismatch before the plan (and its queries) exist:
  // a caller asking to print a kitchen ticket as a receipt has asked for a
  // different document, not for a different printer.
  if (parsed.source.kind === "document" && !documentTypesFor(parsed.source.document).includes(documentType)) {
    return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
  }

  const requestedEntityRefId =
    parsed.source.kind === "document"
      ? (parsed.source.document.orderId ?? parsed.source.document.itemId ?? null)
      : null;

  const isFallbackAttempt = Boolean(parsed.failedPrinterId || parsed.previousJobId);
  let priorAttempt: PriorAttemptRecord | null = null;
  let boundSnapshot: PrintOperationSnapshot | null = null;

  if (isFallbackAttempt) {
    priorAttempt = await loadPriorAttemptForFallback({
      locationId: location.id,
      previousJobId: parsed.previousJobId ?? null,
      printRequestId: parsed.printRequestId,
      failedPrinterId: parsed.failedPrinterId ?? null,
      documentType,
    });

    const cached =
      (parsed.previousJobId ? snapshotCacheByJobId.get(`${location.id}:${parsed.previousJobId}`) : undefined) ??
      (parsed.printRequestId ? snapshotCacheByRequest.get(`${location.id}:${parsed.printRequestId}`) : undefined) ??
      null;

    if (priorAttempt) {
      // Enforce the strict one-fallback limit (at most 2 attempts per operation).
      if (priorAttempt.attempt_number >= 2 || priorAttempt.has_fallback_attempt) {
        return NextResponse.json({ ok: false, error: "printer_unavailable" }, { status: 409 });
      }
      // Delivery safety: never allow automatic fallback when attempt 1 was
      // already handed off, timed out, or had an ambiguous/unproven outcome.
      if (
        priorAttempt.status === "handed_off" ||
        priorAttempt.delivery_outcome === "handed_off" ||
        priorAttempt.delivery_outcome === "ambiguous" ||
        priorAttempt.delivery_outcome === "connector_unavailable" ||
        priorAttempt.error_code === "job_timeout" ||
        priorAttempt.error_code === "print_failed" ||
        (priorAttempt.status === "failed" &&
          priorAttempt.error_code != null &&
          !CONFIRMED_PRE_HANDOFF_ERRORS.has(priorAttempt.error_code as PrinterErrorCode))
      ) {
        return NextResponse.json({ ok: false, error: "job_timeout" }, { status: 409 });
      }
      if (priorAttempt.document_type !== documentType) {
        return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
      }
      if (
        parsed.failedPrinterId &&
        priorAttempt.printer_id &&
        priorAttempt.printer_id !== parsed.failedPrinterId
      ) {
        return NextResponse.json({ ok: false, error: "printer_unavailable" }, { status: 409 });
      }
      boundSnapshot = priorAttempt.render_snapshot ?? cached?.snapshot ?? null;
    } else if (cached) {
      if (cached.attemptNumber >= 2 || cached.hasFallbackAttempt) {
        return NextResponse.json({ ok: false, error: "printer_unavailable" }, { status: 409 });
      }
      if (cached.snapshot.documentType !== documentType) {
        return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
      }
      if (
        parsed.failedPrinterId &&
        cached.snapshot.primaryPrinterId &&
        cached.snapshot.primaryPrinterId !== parsed.failedPrinterId
      ) {
        return NextResponse.json({ ok: false, error: "printer_unavailable" }, { status: 409 });
      }
      boundSnapshot = cached.snapshot;
    }

    if (
      boundSnapshot &&
      requestedEntityRefId &&
      boundSnapshot.requestedEntityRefId &&
      boundSnapshot.requestedEntityRefId !== requestedEntityRefId
    ) {
      return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
    }
  }

  const effectiveFailedPrinterId =
    parsed.failedPrinterId ?? priorAttempt?.printer_id ?? boundSnapshot?.primaryPrinterId ?? null;

  const resolved = await resolvePrintPlan({
    locationId: location.id,
    documentType,
    requestedPrinterId: parsed.printerId,
    requestedTemplateId: boundSnapshot ? boundSnapshot.template.templateId : parsed.templateId,
    ...(effectiveFailedPrinterId ? { failedPrinterId: effectiveFailedPrinterId } : {}),
    ...(boundSnapshot
      ? {
          lockedTemplate: boundSnapshot.template,
          lockedBranding: boundSnapshot.branding,
        }
      : {}),
  });
  if (!resolved.ok) {
    const status = resolved.error === "printer_not_found" || resolved.error === "template_not_found" ? 404 : 409;
    return NextResponse.json({ ok: false, error: resolved.error }, { status });
  }
  const { plan } = resolved;

  const refusal = printerRefusal(plan.printer);
  if (refusal) return NextResponse.json({ ok: false, error: refusal }, { status: 409 });

  const target = printerTargetOf(plan.printer.connection);
  if (!target) return NextResponse.json({ ok: false, error: "reconnect_required" }, { status: 409 });

  // The document itself: on attempt 1 (or if no snapshot exists), loaded from
  // this branch's rows; on attempt 2 with a bound snapshot, reused verbatim so
  // concurrent edits to the order, item, template, or branding between attempt
  // 1 and attempt 2 are never silently reloaded.
  let job: PrintJob;
  let entityId: string | null;
  let documentSource: string;
  if (boundSnapshot) {
    job = boundSnapshot.job;
    entityId = boundSnapshot.entityId;
    documentSource = boundSnapshot.documentSource;
  } else if (parsed.source.kind === "document") {
    const loaded = await loadPrintDocument({
      businessId: session.businessId,
      locationId: location.id,
      document: parsed.source.document,
      documentType,
    });
    if (!loaded.ok) return NextResponse.json({ ok: false, error: loaded.error }, { status: loaded.status });
    job = loaded.document.job;
    entityId = loaded.document.entityId;
    documentSource = loaded.document.source;
  } else {
    job = parsed.source.job;
    entityId = null;
    documentSource = "sample";
  }

  const attemptNumber: 1 | 2 = isFallbackAttempt ? 2 : 1;
  const previousJobId: string | null = isFallbackAttempt
    ? (priorAttempt?.id ?? parsed.previousJobId ?? null)
    : null;
  const routeReason: JobRouteReason = isFallbackAttempt
    ? "runtime_fallback"
    : (plan.reason as JobRouteReason);
  const fallbackFromPrinterId: string | null = isFallbackAttempt
    ? (plan.fallbackPrinter?.id ?? priorAttempt?.printer_id ?? effectiveFailedPrinterId ?? null)
    : (plan.fallbackPrinter?.id ?? null);
  const fallbackFromPrinterName: string | null = isFallbackAttempt
    ? (plan.fallbackPrinter?.name ?? priorAttempt?.printer_name ?? boundSnapshot?.primaryPrinterName ?? null)
    : (plan.fallbackPrinter?.name ?? null);

  const snapshotToPersist: PrintOperationSnapshot = boundSnapshot ?? {
    documentType,
    entityId,
    requestedEntityRefId,
    documentSource,
    job,
    template: {
      template: plan.template,
      templateId: plan.templateId,
      templateKey: plan.templateKey,
      templateVersion: plan.templateVersion,
      saved: plan.templateId !== null,
      source: plan.templateSource,
    },
    branding: plan.branding,
    primaryPrinterId: String(plan.printer.id),
    primaryPrinterName: String(plan.printer.name),
    backupPrinterId: plan.backupPrinter ? String(plan.backupPrinter.id) : null,
    backupPrinterName: plan.backupPrinter ? String(plan.backupPrinter.name) : null,
  };

  const jobId = await openJobRow({
    locationId: location.id,
    documentType,
    entityId,
    plan,
    printRequestId: parsed.printRequestId,
    attemptNumber,
    previousJobId,
    routeReason,
    fallbackFromPrinterId,
    fallbackFromPrinterName,
    snapshot: snapshotToPersist,
  });

  if (attemptNumber === 1) {
    rememberAttemptSnapshot({
      jobId,
      locationId: location.id,
      printRequestId: parsed.printRequestId,
      attemptNumber: 1,
      hasFallbackAttempt: false,
      snapshot: snapshotToPersist,
    });
  } else {
    const existingByReq = parsed.printRequestId
      ? snapshotCacheByRequest.get(`${location.id}:${parsed.printRequestId}`)
      : undefined;
    if (existingByReq) existingByReq.hasFallbackAttempt = true;
    const existingByJob = previousJobId
      ? snapshotCacheByJobId.get(`${location.id}:${previousJobId}`)
      : undefined;
    if (existingByJob) existingByJob.hasFallbackAttempt = true;
  }

  try {
    const prepared = await preparePrint(plan, job);
    console.info(
      JSON.stringify({
        event: "print_render",
        locationId: location.id,
        printerId: plan.printer.id,
        documentType,
        documentSource,
        entityId,
        jobId,
        previousJobId,
        attemptNumber,
        templateId: plan.templateId,
        templateKey: plan.templateKey,
        templateVersion: plan.templateVersion,
        templateSource: plan.templateSource,
        route: plan.reason,
        routeReason,
        delivery: prepared.delivery,
        bytes: prepared.bytes.length,
      }),
    );
    return NextResponse.json({
      ok: true,
      jobId,
      previousJobId,
      attemptNumber,
      printRequestId: parsed.printRequestId,
      entityId,
      target,
      delivery: prepared.delivery,
      printerId: plan.printer.id,
      printerName: plan.printer.name,
      supportsDrawer: plan.routingPrinter.supportsDrawer,
      templateId: plan.templateId,
      templateKey: plan.templateKey,
      templateName: plan.template.name,
      templateVersion: plan.templateVersion,
      templateSource: plan.templateSource,
      route: plan.reason,
      routeReason,
      fallbackFromPrinterId,
      fallbackFromPrinterName,
      fallbackPrinterId: attemptNumber === 1 && plan.reason === "rule" ? (plan.backupPrinter?.id ?? null) : null,
      fallbackPrinterName: attemptNumber === 1 && plan.reason === "rule" ? (plan.backupPrinter?.name ?? null) : null,
      dataBase64: Buffer.from(prepared.bytes).toString("base64"),
    });
  } catch (err) {
    // A render that failed is a finished attempt, and it is recorded as one —
    // here, by the side that watched it fail, rather than hoping the browser
    // comes back to report it. The row closes even when nothing renders.
    console.error("print render failed", err);
    await closeJobAsFailed(jobId, "render_failed");
    return NextResponse.json({ ok: false, error: "render_failed", jobId }, { status: 502 });
  }
});

async function loadPriorAttemptForFallback(input: {
  locationId: string;
  previousJobId: string | null;
  printRequestId: string | null;
  failedPrinterId: string | null;
  documentType: string;
}): Promise<PriorAttemptRecord | null> {
  if (!input.previousJobId && !input.printRequestId && !input.failedPrinterId) {
    return null;
  }
  try {
    const { rows } = await query<PriorAttemptRecord>(
      `SELECT j.id,
              j.document_type,
              j.entity_id,
              j.printer_id,
              j.printer_name,
              j.template_id,
              j.template_key,
              j.template_version,
              j.template_name,
              j.template_paper,
              j.template_source,
              j.status,
              j.error_code,
              j.delivery_outcome,
              j.attempt_number,
              j.previous_job_id,
              j.print_request_id,
              j.render_snapshot,
              EXISTS (
                SELECT 1
                  FROM print_jobs child
                 WHERE child.location_id = j.location_id
                   AND (
                     child.previous_job_id = j.id
                     OR (
                       j.print_request_id IS NOT NULL
                       AND child.print_request_id = j.print_request_id
                       AND child.attempt_number >= 2
                     )
                   )
              ) AS has_fallback_attempt
         FROM print_jobs j
        WHERE j.location_id = $1
          AND (
            ($2::uuid IS NOT NULL AND j.id = $2::uuid)
            OR ($2::uuid IS NULL AND $3::text IS NOT NULL AND j.print_request_id = $3::text)
            OR ($2::uuid IS NULL AND $3::text IS NULL AND $4::uuid IS NOT NULL AND j.printer_id = $4::uuid AND j.document_type = $5)
          )
        ORDER BY j.attempt_number DESC, j.created_at DESC
        LIMIT 1`,
      [
        input.locationId,
        input.previousJobId,
        input.printRequestId,
        input.failedPrinterId,
        input.documentType,
      ],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("loading prior print attempt skipped", err);
    return null;
  }
}

/**
 * Open this attempt's history row before the render starts.
 *
 * Best-effort by contract — history is diagnostics and must never be the
 * reason a receipt does not print — but best-effort means "a failed insert is
 * logged and the print continues", not "only record the prints we feel like".
 * The row's id is what the browser closes the attempt with.
 */
async function openJobRow(input: {
  locationId: string;
  documentType: string;
  entityId: string | null;
  plan: PrintPlan;
  printRequestId: string | null;
  attemptNumber: 1 | 2;
  previousJobId: string | null;
  routeReason: JobRouteReason;
  fallbackFromPrinterId: string | null;
  fallbackFromPrinterName: string | null;
  snapshot: PrintOperationSnapshot;
}): Promise<string | null> {
  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO print_jobs
         (location_id,
          document_type,
          entity_id,
          printer_id,
          template_id,
          template_key,
          template_version,
          status,
          print_request_id,
          attempt_number,
          previous_job_id,
          route_reason,
          delivery_outcome,
          printer_name,
          fallback_from_printer_id,
          fallback_from_printer_name,
          template_name,
          template_paper,
          template_source,
          render_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'sending', $8, $9, $10, $11, 'pending', $12, $13, $14, $15, $16, $17, $18::jsonb)
       RETURNING id`,
      [
        input.locationId,
        input.documentType,
        input.entityId,
        input.plan.printer.id,
        input.plan.templateId,
        input.plan.templateKey,
        input.plan.templateVersion,
        input.printRequestId,
        input.attemptNumber,
        input.previousJobId,
        input.routeReason,
        input.plan.printer.name,
        input.fallbackFromPrinterId,
        input.fallbackFromPrinterName,
        input.plan.template.name,
        input.plan.template.paper,
        input.plan.templateSource,
        JSON.stringify(input.snapshot),
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error("print job row skipped", err);
    return null;
  }
}

/** Close an attempt the server itself saw fail. A row already terminal (swept, or closed by the browser) is left alone. */
async function closeJobAsFailed(jobId: string | null, code: PrinterErrorCode): Promise<void> {
  if (!jobId) return;
  try {
    await query(
      `UPDATE print_jobs
          SET status = 'failed',
              error_code = $2,
              delivery_outcome = 'not_delivered'
        WHERE id = $1
          AND status = 'sending'`,
      [jobId, code],
    );
  } catch (err) {
    console.error("closing the failed print job skipped", err);
  }
}
