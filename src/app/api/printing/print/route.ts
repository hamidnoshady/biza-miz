import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { resolvePrintPlan, type PrintDocumentType } from "@/lib/printing/plan";
import { preparePrint, printerRefusal, type PrintJob } from "@/lib/printing/render-service";
import { printerTargetOf } from "@/lib/printing/types";
import { defaultDocumentTypeFor, documentTypesFor, parsePrintRequest } from "@/lib/printing/document-request";
import { loadPrintDocument } from "@/lib/printing/document-loader";
import type { PrinterErrorCode } from "@/lib/printing/errors";

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
 */
export const runtime = "nodejs";

/**
 * A request carries ids and a document reference — a few hundred bytes. The
 * ceiling exists so the endpoint cannot be used as a general-purpose upload
 * sink now that no document data travels through it at all.
 */
const MAX_BODY_BYTES = 16 * 1024;

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

  const resolved = await resolvePrintPlan({
    locationId: location.id,
    documentType,
    requestedPrinterId: parsed.printerId,
    requestedTemplateId: parsed.templateId,
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

  // The document itself: loaded from this branch's rows, or — for a test print
  // and a drawer kick — the product's own sample, which carries no data.
  let job: PrintJob;
  let entityId: string | null;
  let documentSource: string;
  if (parsed.source.kind === "document") {
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

  const jobId = await openJobRow({
    locationId: location.id,
    documentType,
    entityId,
    plan,
    printRequestId: parsed.printRequestId,
  });

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
        templateId: plan.templateId,
        templateKey: plan.templateKey,
        templateVersion: plan.templateVersion,
        templateSource: plan.templateSource,
        route: plan.reason,
        delivery: prepared.delivery,
        bytes: prepared.bytes.length,
      }),
    );
    return NextResponse.json({
      ok: true,
      jobId,
      printRequestId: parsed.printRequestId,
      entityId,
      target,
      delivery: prepared.delivery,
      printerId: plan.printer.id,
      printerName: plan.printer.name,
      supportsDrawer: plan.routingPrinter.supportsDrawer,
      templateId: plan.templateId,
      templateKey: plan.templateKey,
      templateVersion: plan.templateVersion,
      templateSource: plan.templateSource,
      route: plan.reason,
      fallbackFromPrinterId: plan.fallbackPrinter?.id ?? null,
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
  plan: { printer: { id: string }; templateId: string | null; templateKey: string; templateVersion: number };
  printRequestId: string | null;
}): Promise<string | null> {
  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO print_jobs
         (location_id, document_type, entity_id, printer_id, template_id, template_key, template_version, status, print_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'sending', $8)
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
      `UPDATE print_jobs SET status = 'failed', error_code = $2 WHERE id = $1 AND status = 'sending'`,
      [jobId, code],
    );
  } catch (err) {
    console.error("closing the failed print job skipped", err);
  }
}
