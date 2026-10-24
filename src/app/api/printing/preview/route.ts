import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isWooDocument, parsePrintRequest, defaultDocumentTypeFor, documentTypesFor } from "@/lib/printing/document-request";
import { loadPrintDocument } from "@/lib/printing/document-loader";
import { resolvePrintPlan } from "@/lib/printing/plan";
import { preparePrint } from "@/lib/printing/render-service";
import { wooConnectionForPrint } from "@/lib/integrations/woo-order-detail-service";
import { PAPERS } from "@/lib/print-template";

export const runtime = "nodejs";
/** First-party preview of an authorized identity, through the same plan/data/render pipeline.
 * No browser HTML, no raw totals/addresses, no hardware handoff and no print-job side effect.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.printingExecute);
  if (guard.error) return guard.error;
  let raw: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 16 * 1024) return NextResponse.json({ error: "bad_request" }, { status: 413 });
    raw = JSON.parse(text);
  } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const parsed = parsePrintRequest(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  if (parsed.source.kind !== "document" || !isWooDocument(parsed.source.document) || parsed.failedPrinterId || parsed.previousJobId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const wooGuard = await requirePermission(PERMISSIONS.woocommerceView);
  if (wooGuard.error) return wooGuard.error;
  const location = await resolveActiveLocation(guard.session);
  const ref = parsed.source.document;
  if (!location || !await wooConnectionForPrint(guard.session.businessId, location.id, ref.connectionId)) {
    return NextResponse.json({ error: "document_not_found" }, { status: 404 });
  }
  const documentType = parsed.documentType ?? defaultDocumentTypeFor(ref);
  if (!documentTypesFor(ref).includes(documentType)) return NextResponse.json({ error: "document_type_mismatch" }, { status: 409 });
  const loaded = await loadPrintDocument({ businessId: guard.session.businessId, locationId: location.id, document: ref, documentType });
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const resolved = await resolvePrintPlan({ locationId: location.id, connectionId: ref.connectionId, documentType,
    requestedPrinterId: parsed.printerId, requestedTemplateId: parsed.templateId, requestedTemplateKey: parsed.templateKey });
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 409 });
  const plan = resolved.plan;
  try {
    // Exactly the production renderer (including QR, DPI and overflow checks),
    // without the /print route's job reservation or any local handoff.
    const prepared = await preparePrint(plan, loaded.document.job);
    if (prepared.delivery !== "page") throw new Error("render_failed");
    const image = prepared.bytes;
    const paper = PAPERS[plan.paper];
    return NextResponse.json({ ok: true, imageBase64: image.toString("base64"), paper: { key: paper.key, widthMm: paper.widthMm, heightMm: paper.heightMm },
      templateName: plan.template.name, templateVersion: plan.templateVersion, printerName: plan.printer.name },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const code = (error as Error).message === "shipping_label_overflow" ? "shipping_label_overflow" : "render_failed";
    return NextResponse.json({ error: code }, { status: code === "shipping_label_overflow" ? 409 : 502 });
  }
});
