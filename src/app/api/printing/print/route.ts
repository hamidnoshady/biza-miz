import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PAPERS } from "@/lib/print-template";
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
import { isWooDocument, printEntityRef, type PrintDocumentKind, type PrintDocumentRef, defaultDocumentTypeFor, documentTypesFor, parsePrintRequest } from "@/lib/printing/document-request";
import { wooConnectionForPrint } from "@/lib/integrations/woo-order-detail-service";
import { protectWooJob, restoreWooJob, type StoredPrintJob } from "@/lib/printing/woo-snapshot-privacy";
import { loadPrintDocument } from "@/lib/printing/document-loader";
import {
  CONFIRMED_PRE_HANDOFF_ERROR_LIST,
  isConfirmedNonDeliveryAttempt,
  type PrinterErrorCode,
} from "@/lib/printing/errors";

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
 * 2 requires a durable parent attempt in the caller's branch with positively
 * confirmed pre-handoff non-delivery (`status = 'failed'`, `delivery_outcome =
 * 'not_delivered'`), a valid persisted `render_snapshot`, and an atomic
 * reservation in `print_jobs` (`idx_print_jobs_unique_previous_job`) before
 * rendering and returning printable bytes.
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
  | "none"
  | "unknown";

export interface PrintOperationSnapshot {
  documentType: PrintDocumentType;
  entityId: string | null;
  requestedEntityRefId: string | null;
  documentSource: string;
  job: StoredPrintJob;
  documentRef?: PrintDocumentRef;
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

function isValidPrintOperationSnapshot(value: unknown): value is PrintOperationSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PrintOperationSnapshot>;
  if (typeof candidate.documentType !== "string" || candidate.documentType.length === 0) return false;
  if (typeof candidate.documentSource !== "string" || candidate.documentSource.length === 0) return false;
  if (typeof candidate.primaryPrinterId !== "string" || candidate.primaryPrinterId.length === 0) return false;
  if (!candidate.job || typeof candidate.job !== "object") return false;
  if (typeof (candidate.job as { type?: unknown }).type !== "string") return false;
  if (!candidate.template || typeof candidate.template !== "object") return false;
  const tpl = candidate.template as Partial<ResolvedTemplate>;
  if (!tpl.template || typeof tpl.template !== "object") return false;
  if (typeof tpl.template.name !== "string" || typeof tpl.template.paper !== "string") return false;
  if (!Array.isArray(tpl.template.blocks)) return false;
  if (typeof tpl.templateKey !== "string" || typeof tpl.templateVersion !== "number") return false;
  if (!candidate.branding || typeof candidate.branding !== "object") return false;
  return true;
}

function documentKindMatchesSource(
  requestDocumentKind: PrintDocumentKind,
  snapshotSource: string,
): boolean {
  if (requestDocumentKind === "order-receipt") {
    return snapshotSource === "order-receipt" || snapshotSource === "retail-invoice";
  }
  return snapshotSource === requestDocumentKind;
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

  const wooRef = parsed.source.kind === "document" && isWooDocument(parsed.source.document) ? parsed.source.document : null;
  const wooConnectionId = wooRef?.connectionId ?? parsed.connectionId;
  if (wooConnectionId) {
    const wooGuard = await requirePermission(PERMISSIONS.woocommerceView);
    if (wooGuard.error) return wooGuard.error;
    if (!await wooConnectionForPrint(session.businessId, location.id, wooConnectionId)) {
      return NextResponse.json({ ok: false, error: "document_not_found" }, { status: 404 });
    }
  }

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
  // A sample print has no connection id, but it still exercises a Woo-specific
  // document/template. Do not let a printing-only member bypass the live Woo
  // permission gate by changing the request to a synthetic test job.
  if (!wooConnectionId && (documentType === "shipping_label" || documentType === "woo_invoice")) {
    const wooGuard = await requirePermission(PERMISSIONS.woocommerceView);
    if (wooGuard.error) return wooGuard.error;
  }

  const requestedEntityRefId =
    parsed.source.kind === "document"
      ? printEntityRef(parsed.source.document)
      : null;

  const isFallbackAttempt = Boolean(parsed.failedPrinterId || parsed.previousJobId);
  let priorAttempt: PriorAttemptRecord | null = null;
  let boundSnapshot: PrintOperationSnapshot | null = null;

  if (isFallbackAttempt) {
    if (!parsed.failedPrinterId) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    if (parsed.printerId) {
      return NextResponse.json({ ok: false, error: "printer_unavailable" }, { status: 409 });
    }
    if (!parsed.previousJobId && !parsed.printRequestId) {
      return NextResponse.json({ ok: false, error: "fallback_parent_not_found" }, { status: 409 });
    }

    const priorLookup = await loadPriorAttemptForFallback({
      locationId: location.id,
      previousJobId: parsed.previousJobId ?? null,
      printRequestId: parsed.printRequestId,
    });
    if (!priorLookup.ok) {
      if (priorLookup.reason === "lookup_failed") {
        return NextResponse.json({ ok: false, error: "printer_unavailable" }, { status: 503 });
      }
      return NextResponse.json({ ok: false, error: "fallback_parent_not_found" }, { status: 409 });
    }
    priorAttempt = priorLookup.row;

    // Enforce the strict one-fallback limit and reject duplicate fallback reservations.
    if (priorAttempt.attempt_number >= 2 || priorAttempt.previous_job_id !== null) {
      const isSecondFallback = priorAttempt.printer_id === parsed.failedPrinterId;
      return NextResponse.json(
        { ok: false, error: isSecondFallback ? "printer_unavailable" : "fallback_already_reserved" },
        { status: 409 },
      );
    }
    if (priorAttempt.has_fallback_attempt) {
      return NextResponse.json({ ok: false, error: "fallback_already_reserved" }, { status: 409 });
    }

    // Parent identity must match the requested document type and failed printer.
    if (priorAttempt.document_type !== documentType) {
      return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
    }
    if (!priorAttempt.printer_id || priorAttempt.printer_id !== parsed.failedPrinterId) {
      return NextResponse.json({ ok: false, error: "printer_unavailable" }, { status: 409 });
    }
    if (
      parsed.printRequestId &&
      priorAttempt.print_request_id &&
      priorAttempt.print_request_id !== parsed.printRequestId
    ) {
      return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
    }

    // Delivery safety: reject pending/sending, handed_off, ambiguous, or unproven parent attempts.
    if (
      priorAttempt.status === "sending" ||
      priorAttempt.status === "created" ||
      priorAttempt.status === "preparing" ||
      priorAttempt.status === "routing" ||
      priorAttempt.delivery_outcome === "pending"
    ) {
      return NextResponse.json({ ok: false, error: "fallback_parent_pending" }, { status: 409 });
    }
    if (!isConfirmedNonDeliveryAttempt(priorAttempt)) {
      return NextResponse.json({ ok: false, error: "job_timeout" }, { status: 409 });
    }

    // Require a valid immutable snapshot from the parent attempt; never reload mutable data.
    if (!isValidPrintOperationSnapshot(priorAttempt.render_snapshot)) {
      return NextResponse.json({ ok: false, error: "fallback_snapshot_missing" }, { status: 409 });
    }
    boundSnapshot = priorAttempt.render_snapshot;

    if (
      boundSnapshot.documentType !== documentType ||
      boundSnapshot.primaryPrinterId !== priorAttempt.printer_id
    ) {
      return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
    }
    if (
      parsed.templateId &&
      boundSnapshot.template.templateId !== parsed.templateId &&
      boundSnapshot.template.templateKey !== parsed.templateId
    ) {
      return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
    }
    if (parsed.templateKey && parsed.templateKey !== boundSnapshot.template.templateKey) {
      return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
    }
    if (priorAttempt.entity_id !== null && boundSnapshot.entityId !== priorAttempt.entity_id) {
      return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
    }
    // JSONB does not preserve object key order. Compare reference fields, not JSON strings.
    if (wooRef && (!boundSnapshot.documentRef || ["kind", "connectionId", "remoteId", "snapshotId", "shipmentIndex", "packageIndex", "packageCount"].some(
      field => boundSnapshot!.documentRef![field as keyof PrintDocumentRef] !== wooRef[field as keyof PrintDocumentRef],
    ))) {
      return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
    }
    if (parsed.source.kind === "document") {
      const expectedRefId =
        boundSnapshot.requestedEntityRefId ?? boundSnapshot.entityId ?? priorAttempt.entity_id;
      if (
        !requestedEntityRefId ||
        !expectedRefId ||
        requestedEntityRefId !== expectedRefId ||
        !documentKindMatchesSource(parsed.source.document.kind, boundSnapshot.documentSource)
      ) {
        return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
      }
    } else if (
      boundSnapshot.documentSource !== "sample" ||
      boundSnapshot.job.type !== parsed.source.job.type
    ) {
      return NextResponse.json({ ok: false, error: "document_type_mismatch" }, { status: 409 });
    }
  }

  const effectiveFailedPrinterId = isFallbackAttempt ? parsed.failedPrinterId ?? null : null;

  const resolved = await resolvePrintPlan({
    locationId: location.id,
    documentType,
    ...(wooConnectionId ? { connectionId: wooConnectionId } : {}),
    requestedPrinterId: isFallbackAttempt ? null : parsed.printerId,
    requestedTemplateId: boundSnapshot ? boundSnapshot.template.templateId : parsed.templateId,
    ...(!boundSnapshot && parsed.templateKey ? { requestedTemplateKey: parsed.templateKey } : {}),
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

  if (isFallbackAttempt && (plan.reason !== "fallback" || plan.printer.id === effectiveFailedPrinterId)) {
    return NextResponse.json({ ok: false, error: "printer_unavailable" }, { status: 409 });
  }

  const refusal = printerRefusal(plan.printer);
  if (refusal) return NextResponse.json({ ok: false, error: refusal }, { status: 409 });

  const target = printerTargetOf(plan.printer.connection);
  if (!target) return NextResponse.json({ ok: false, error: "reconnect_required" }, { status: 409 });

  // The document itself: on attempt 1, loaded from this branch's rows; on
  // attempt 2, reused verbatim from the parent attempt's immutable snapshot so
  // concurrent edits to the order, item, template, or branding between attempt
  // 1 and attempt 2 are never silently reloaded.
  let job: PrintJob;
  let entityId: string | null;
  let documentSource: string;
  if (boundSnapshot) {
    try {
      job = restoreWooJob(boundSnapshot.job, `${session.businessId}:${location.id}:${requestedEntityRefId}`);
    } catch {
      return NextResponse.json({ ok: false, error: "fallback_snapshot_missing" }, { status: 409 });
    }
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
  const previousJobId: string | null = isFallbackAttempt ? priorAttempt!.id : null;
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
    ...(wooRef ? { documentRef: wooRef } : {}),
    job: protectWooJob(job, `${session.businessId}:${location.id}:${requestedEntityRefId}`),
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

  let jobId: string | null = null;
  if (isFallbackAttempt) {
    const reservation = await reserveFallbackJobRow({
      locationId: location.id,
      provenance: { actorId: wooRef ? session.sub : null, connectionId: wooRef?.connectionId ?? null,
        remoteId: wooRef?.remoteId ?? null, revision: job.type === "woo-order" ? job.data.sourceRevision?.id ?? null : null },
      documentType,
      entityId,
      plan,
      printRequestId: parsed.printRequestId ?? priorAttempt?.print_request_id ?? null,
      previousJobId: priorAttempt!.id,
      routeReason,
      fallbackFromPrinterId: priorAttempt!.printer_id!,
      fallbackFromPrinterName,
      snapshot: snapshotToPersist,
    });
    if (!reservation.ok) {
      if (reservation.reason === "conflict") {
        return NextResponse.json({ ok: false, error: "fallback_already_reserved" }, { status: 409 });
      }
      return NextResponse.json({ ok: false, error: "printer_unavailable" }, { status: 503 });
    }
    jobId = reservation.jobId;
  } else {
    jobId = await openJobRow({
      locationId: location.id,
      provenance: { actorId: wooRef ? session.sub : null, connectionId: wooRef?.connectionId ?? null,
        remoteId: wooRef?.remoteId ?? null, revision: job.type === "woo-order" ? job.data.sourceRevision?.id ?? null : null },
      documentType,
      entityId,
      plan,
      printRequestId: parsed.printRequestId,
      attemptNumber: 1,
      previousJobId: null,
      routeReason,
      fallbackFromPrinterId,
      fallbackFromPrinterName,
      snapshot: snapshotToPersist,
    });
  }

  if (wooRef && (!jobId || jobId === "duplicate_pending")) {
    return NextResponse.json({ ok: false, error: jobId === "duplicate_pending" ? "print_already_pending" : "print_failed" }, { status: jobId ? 409 : 503 });
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
      ...(wooRef ? { pageGeometry: { widthMm: PAPERS[plan.template.paper].widthMm, heightMm: PAPERS[plan.template.paper].heightMm } } : {}),
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
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    // A render that failed is a finished attempt, and it is recorded as one —
    // here, by the side that watched it fail, rather than hoping the browser
    // comes back to report it. The row closes even when nothing renders.
    console.error("print render failed", err);
    const code = (err as Error).message === "shipping_label_overflow" ? "shipping_label_overflow" : "render_failed";
    await closeJobAsFailed(jobId, code);
    return NextResponse.json({ ok: false, error: code, jobId }, { status: 502 });
  }
});

async function loadPriorAttemptForFallback(input: {
  locationId: string;
  previousJobId: string | null;
  printRequestId: string | null;
}): Promise<
  | { ok: true; row: PriorAttemptRecord }
  | { ok: false; reason: "not_found" | "lookup_failed" }
> {
  if (!input.previousJobId && !input.printRequestId) {
    return { ok: false, reason: "not_found" };
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
                   AND child.previous_job_id = j.id
              ) AS has_fallback_attempt
         FROM print_jobs j
        WHERE j.location_id = $1
          AND (j.document_type NOT IN ('shipping_label', 'woo_invoice') OR j.created_at >= now() - interval '30 days')
          AND (
            ($2::uuid IS NOT NULL AND j.id = $2::uuid)
            OR ($2::uuid IS NULL AND $3::text IS NOT NULL AND j.print_request_id = $3::text)
          )
        ORDER BY j.created_at DESC, j.attempt_number DESC, j.id DESC
        LIMIT 1`,
      [input.locationId, input.previousJobId, input.printRequestId],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: "not_found" };
    return { ok: true, row };
  } catch (err) {
    console.error("loading prior print attempt failed", err);
    return { ok: false, reason: "lookup_failed" };
  }
}

/**
 * Atomically reserve the single fallback attempt for a confirmed-non-delivered
 * primary attempt BEFORE rendering.
 *
 * Uses `SELECT ... FOR UPDATE` on the parent attempt row inside a single-statement
 * CTE so concurrent fallback requests serialize on the parent row without holding
 * a transaction open across Chromium rendering, and `idx_print_jobs_unique_previous_job`
 * enforces at most one child row per parent at the database constraint level.
 */
async function reserveFallbackJobRow(input: {
  locationId: string;
  provenance?: { actorId: string | null; connectionId: string | null; remoteId: string | null; revision: string | null };
  documentType: string;
  entityId: string | null;
  plan: PrintPlan;
  printRequestId: string | null;
  previousJobId: string;
  routeReason: JobRouteReason;
  fallbackFromPrinterId: string;
  fallbackFromPrinterName: string | null;
  snapshot: PrintOperationSnapshot;
}): Promise<
  | { ok: true; jobId: string }
  | { ok: false; reason: "conflict" | "db_error" }
> {
  try {
    const { rows } = await query<{ id: string }>(
      `WITH locked_parent AS (
         SELECT id
           FROM print_jobs
          WHERE id = $10::uuid
            AND location_id = $1
            AND document_type = $2
            AND printer_id = $13::uuid
            AND attempt_number = 1
            AND previous_job_id IS NULL
            AND status = 'failed'
            AND delivery_outcome = 'not_delivered'
            AND error_code = ANY($19::text[])
            AND render_snapshot IS NOT NULL
          FOR UPDATE
       )
       INSERT INTO print_jobs
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
          render_snapshot, initiated_by, connection_id, document_ref, source_revision)
       SELECT
         $1, $2, $3, $4, $5, $6, $7, 'sending', $8, $9, locked_parent.id, $11, 'pending',
         $12, $13, $14, $15, $16, $17, $18::jsonb, $20, $21, $22, $23
       FROM locked_parent
       WHERE NOT EXISTS (
         SELECT 1
           FROM print_jobs existing
          WHERE existing.previous_job_id = locked_parent.id
       )
       ON CONFLICT (previous_job_id) WHERE previous_job_id IS NOT NULL DO NOTHING
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
        2,
        input.previousJobId,
        input.routeReason,
        input.plan.printer.name,
        input.fallbackFromPrinterId,
        input.fallbackFromPrinterName,
        input.plan.template.name,
        input.plan.template.paper,
        input.plan.templateSource,
        JSON.stringify(input.snapshot),
        CONFIRMED_PRE_HANDOFF_ERROR_LIST,
        input.provenance?.actorId ?? null, input.provenance?.connectionId ?? null, input.provenance?.remoteId ?? null, input.provenance?.revision ?? null,
      ],
    );
    const id = rows[0]?.id;
    if (!id) {
      return { ok: false, reason: "conflict" };
    }
    return { ok: true, jobId: id };
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode === "23505") {
      return { ok: false, reason: "conflict" };
    }
    console.error("fallback print job reservation failed", err);
    return { ok: false, reason: "db_error" };
  }
}

/**
 * Open a primary attempt's history row before the render starts.
 *
 * Best-effort by contract — history is diagnostics and must never be the
 * reason a primary receipt does not print — but best-effort means "a failed
 * insert is logged and the print continues", not "only record the prints we
 * feel like". The row's id is what the browser closes the attempt with.
 */
async function openJobRow(input: {
  locationId: string;
  provenance?: { actorId: string | null; connectionId: string | null; remoteId: string | null; revision: string | null };
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
          render_snapshot, initiated_by, connection_id, document_ref, source_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'sending', $8, $9, $10, $11, 'pending', $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22)
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
        input.provenance?.actorId ?? null, input.provenance?.connectionId ?? null, input.provenance?.remoteId ?? null, input.provenance?.revision ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    if (input.provenance?.connectionId && (err as { code?: string }).code === "23505") return "duplicate_pending";
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
