import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { loadWooOrderDetail } from "@/lib/integrations/woo-order-detail-service";
import { loadPrintRules, loadRoutablePrinters, resolvePrintPlan } from "@/lib/printing/plan";
import { listPrintTemplates } from "@/lib/print-templates-service";
import { BUILT_IN_TEMPLATES } from "@/lib/print-template";
import { printerAcceptsDocument, selectPrintRule } from "@/lib/printing/routing";
import { query } from "@/lib/db";

/** Stored revision only: opening/printing details never refreshes Woo or imports a sale. */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string; remoteId: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;
  const { id, remoteId } = await context.params;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "document_not_found" }, { status: 404 });
  const loaded = await loadWooOrderDetail({ businessId: session.businessId, locationId: location.id, connectionId: id, remoteId });
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const printGuard = await requirePermission(PERMISSIONS.printingExecute);
  const canPrint = !printGuard.error;
  let printing: Record<string, unknown> | null = null;
  if (canPrint) {
    const [{ routable }, saved, rules] = await Promise.all([loadRoutablePrinters(location.id), listPrintTemplates(location.id), loadPrintRules(location.id)]);
    const plans: Record<string, unknown> = {};
    for (const documentType of ["shipping_label", "woo_invoice"] as const) {
      const result = await resolvePrintPlan({ locationId: location.id, documentType, connectionId: id, includeBranding: false });
      plans[documentType] = result.ok ? { ok: true, printerId: result.plan.printer.id, printerName: result.plan.printer.name,
        templateName: result.plan.template.name, paper: result.plan.template.paper, templateVersion: result.plan.templateVersion } : result;
    }
    // Retain encrypted fallback payloads for at most 30 days. Plain history
    // metadata remains useful afterwards without keeping recipient PII there.
    await query(`UPDATE print_jobs SET render_snapshot = NULL WHERE location_id = $1 AND connection_id = $2
      AND created_at < now() - interval '30 days' AND render_snapshot IS NOT NULL`, [location.id, id]);
    const { rows: jobs } = await query(`SELECT id, document_type, status, error_code, printer_name, template_name, template_version,
      source_revision, initiated_by, print_request_id, created_at FROM print_jobs WHERE location_id = $1 AND connection_id = $2 AND document_ref = $3
      ORDER BY created_at DESC LIMIT 12`, [location.id, id, remoteId]);
    printing = {
      plans, jobs,
      printers: routable.filter(p => printerAcceptsDocument(p, "shipping_label") || printerAcceptsDocument(p, "woo_invoice"))
        .map(p => ({ id: p.id, name: p.name, paper: p.paper, documentTypes: ["shipping_label", "woo_invoice"].filter(t => printerAcceptsDocument(p, t as "shipping_label" | "woo_invoice")) })),
      templates: [...saved, ...BUILT_IN_TEMPLATES].filter(t => t.docType === "shipping_label" || t.docType === "woo_invoice")
        .map(t => ({ id: "id" in t ? t.id : null, key: t.key, name: t.name, docType: t.docType, paper: t.paper })),
      rules: ["shipping_label", "woo_invoice"].map(t => selectPrintRule(rules, t as "shipping_label" | "woo_invoice", id)),
    };
  }
  return NextResponse.json({ detail: loaded.detail, canPrint, printing }, { headers: { "Cache-Control": "private, no-store" } });
});
