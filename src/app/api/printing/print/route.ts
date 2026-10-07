import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { resolvePrintPlan, type PrintDocumentType } from "@/lib/printing/plan";
import { preparePrint, printerRefusal, type PrintJob } from "@/lib/printing/render-service";
import { printerTargetOf } from "@/lib/printing/types";
import { isDocType } from "@/lib/printing/routing";

/**
 * The one hardware print endpoint: resolve the print plan for the caller's
 * branch, render it to canonical bytes on the authenticated app server, and
 * hand them back for local delivery.
 *
 * The request is an **intent**, not output. It carries a document type, an
 * optional printer/template id and the document's own data; it can NOT carry
 * rendered HTML. That restriction is the whole security model of this route:
 * the server renders in Chromium, so accepting a client's HTML would make
 * every `printingExecute` role able to point that browser — and therefore the
 * server's network position — anywhere it liked. With the request limited to
 * documents the pipeline itself builds, the render context can stay hostile
 * by default (see printing/chromium.ts).
 *
 * Nor can the request name hardware: printer and template ids are resolved
 * against the caller's active location, so a hand-edited body can neither
 * print through another branch's printer nor aim the server at an arbitrary
 * IP, queue or port. The response records exactly which template revision and
 * which printer (primary or fallback) produced the job.
 */
export const runtime = "nodejs";

interface PrintRequestBody {
  printerId?: string;
  templateId?: string;
  printRequestId?: string;
  documentType?: string;
  entityId?: string;
  job?: {
    type?: string;
    receipt?: unknown;
    ticket?: unknown;
    label?: unknown;
    kind?: unknown;
  };
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.printingExecute);
  if (error) return error;

  let body: PrintRequestBody;
  try {
    body = (await request.json()) as PrintRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ ok: false, error: "printer_not_configured" }, { status: 404 });

  const job = parseJob(body.job);
  if (!job) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  const documentType = documentTypeOf(body, job);
  if (!documentType) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  const printerId = typeof body.printerId === "string" && body.printerId ? body.printerId : null;
  const templateId = typeof body.templateId === "string" && body.templateId ? body.templateId : null;

  const resolved = await resolvePrintPlan({
    locationId: location.id,
    documentType,
    requestedPrinterId: printerId,
    requestedTemplateId: templateId,
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

  const requestId = typeof body.printRequestId === "string" ? body.printRequestId.slice(0, 80) : "";
  const entityId = typeof body.entityId === "string" ? body.entityId.slice(0, 120) : null;

  try {
    const prepared = await preparePrint(plan, job);
    if (requestId) {
      try {
        await query(
          `INSERT INTO print_jobs
             (location_id, document_type, entity_id, printer_id, template_id, template_key, template_version, status, print_request_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'sending', $8)
           ON CONFLICT (location_id, print_request_id) DO NOTHING`,
          [
            location.id,
            documentType,
            entityId,
            plan.printer.id,
            plan.templateId,
            plan.templateKey,
            plan.templateVersion,
            requestId,
          ],
        );
      } catch (err) {
        // History is diagnostics, never a reason a receipt does not print.
        console.error("print job row skipped", err);
      }
    }
    console.info(
      JSON.stringify({
        event: "print_render",
        locationId: location.id,
        printerId: plan.printer.id,
        documentType,
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
    console.error("print render failed", err);
    return NextResponse.json({ ok: false, error: "render_failed" }, { status: 502 });
  }
});

function documentTypeOf(body: PrintRequestBody, job: PrintJob): PrintDocumentType | null {
  if (isDocType(body.documentType)) return body.documentType;
  switch (job.type) {
    case "receipt":
      return "receipt";
    case "kitchen-ticket":
      return "kitchen";
    case "label":
      return "label";
    case "test":
      return job.kind;
    case "drawer-kick":
      // The drawer hangs off the receipt printer (ESC p), so its plan is the
      // receipt plan — a caller does not have to say so.
      return "receipt";
    default:
      return null;
  }
}

/**
 * Parse the structured job payload. There is deliberately no `document`/`html`
 * branch: the only documents this endpoint renders are the ones the product
 * itself constructs from this data.
 */
function parseJob(raw: PrintRequestBody["job"]): PrintJob | null {
  if (!raw || typeof raw !== "object") return null;
  switch (raw.type) {
    case "receipt":
      return isRecord(raw.receipt) ? { type: "receipt", receipt: raw.receipt as never } : null;
    case "kitchen-ticket":
      return isRecord(raw.ticket) ? { type: "kitchen-ticket", ticket: raw.ticket as never } : null;
    case "label":
      return isRecord(raw.label) ? { type: "label", label: raw.label as never } : null;
    case "test": {
      const kind = raw.kind;
      if (isDocType(kind)) return { type: "test", kind };
      return null;
    }
    case "drawer-kick":
      return { type: "drawer-kick" };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
