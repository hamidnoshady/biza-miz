import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { wooConnectionForPrint } from "@/lib/integrations/woo-order-detail-service";
import { UUID_ID } from "@/lib/integrations/woo-order-snapshot";
import { resolveActiveLocation } from "@/lib/setup-state";
import { builtInTemplate, type DocType, type PaperKey } from "@/lib/print-template";
import { getPrintTemplate } from "@/lib/print-templates-service";
import { loadRoutablePrinters, resolvePrintPlan } from "@/lib/printing/plan";
import { isDocType, printerAcceptsDocument, printerAcceptsTemplate } from "@/lib/printing/routing";

/**
 * Branch print rules: which template and printer each document type uses.
 *
 * This is the authoritative routing source. The route validates both halves
 * against this branch — a template must be a built-in of the same document
 * type or a saved template OF THIS LOCATION, and a printer must be one this
 * branch owns and that can physically carry the document. The same predicates
 * the runtime resolver uses are applied here, so a rule that saves is a rule
 * that prints.
 *
 * GET also answers "what would actually happen?" per document type — the
 * template that would win, and its source — which is what the rules screen
 * shows and what support asks when a receipt prints the wrong layout.
 */

const DOCUMENT_TYPES: DocType[] = ["receipt", "invoice", "kitchen", "label", "shipping_label", "woo_invoice"];

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ rules: [], resolved: {} });

  const connectionId = new URL(request.url).searchParams.get("connectionId");
  if (connectionId && !await wooConnectionForPrint(session.businessId, location.id, connectionId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const { rows } = await query<{
      document_type: string;
      template_key: string | null;
      template_id: string | null;
      printer_id: string | null;
      fallback_printer_id: string | null;
    }>(
      `SELECT document_type, template_key, template_id, printer_id, fallback_printer_id
         FROM print_rules WHERE location_id = $1 AND connection_id IS NOT DISTINCT FROM $2::uuid ORDER BY document_type`,
      [location.id, connectionId],
    );

    // What each document type would print right now — resolved with the very
    // same function the till calls, branding skipped because this is a view.
    const resolved: Record<string, unknown> = {};
    for (const documentType of DOCUMENT_TYPES) {
      const plan = await resolvePrintPlan({ locationId: location.id, documentType, connectionId, includeBranding: false });
      resolved[documentType] = plan.ok
        ? {
            ok: true,
            printerId: plan.plan.printer.id,
            printerName: plan.plan.printer.name,
            route: plan.plan.reason,
            fallbackPrinterName: plan.plan.fallbackPrinter?.name ?? null,
            templateKey: plan.plan.templateKey,
            templateId: plan.plan.templateId,
            templateName: plan.plan.template.name,
            templateVersion: plan.plan.templateVersion,
            templateSource: plan.plan.templateSource,
          }
        : { ok: false, error: plan.error };
    }

    const normalizedRows = rows.map((row) => ({
      ...row,
      fallback_printer_id: row.printer_id ? row.fallback_printer_id : null,
    }));

    const { rows: stores } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM integration_connections WHERE business_id = $1 AND location_id = $2 AND provider = 'woocommerce' ORDER BY name`,
      [session.businessId, location.id],
    );
    return NextResponse.json({ rules: normalizedRows, resolved, stores });
  } catch (err) {
    console.error("listing print rules failed", err);
    return NextResponse.json({ error: "print_rules_failed", rules: [], resolved: {} }, { status: 500 });
  }
});

interface RuleBody {
  documentType?: string;
  connectionId?: string | null;
  /** A built-in preset key. */
  templateKey?: string | null;
  /** A saved template of this branch. Wins over `templateKey` when both are sent. */
  templateId?: string | null;
  printerId?: string | null;
  fallbackPrinterId?: string | null;
}

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  let body: RuleBody;
  try {
    body = (await request.json()) as RuleBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isDocType(body.documentType)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const documentType = body.documentType;
  const connectionId = body.connectionId === "" ? null : body.connectionId ?? null;
  if (connectionId !== null && (typeof connectionId !== "string" || !UUID_ID.test(connectionId) ||
    (documentType !== "shipping_label" && documentType !== "woo_invoice") ||
    !await wooConnectionForPrint(session.businessId, location.id, connectionId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  for (const value of [body.templateId, body.printerId, body.fallbackPrinterId]) {
    if (value != null && value !== "" && (typeof value !== "string" || !UUID_ID.test(value))) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // ── the template ──
  let templateKey: string | null = null;
  let templateId: string | null = null;
  let templatePaper: PaperKey | null = null;
  const requestedId = typeof body.templateId === "string" && body.templateId.trim() ? body.templateId.trim() : null;
  const requestedKey = typeof body.templateKey === "string" && body.templateKey.trim() ? body.templateKey.trim() : null;
  if (requestedId) {
    const saved = await getPrintTemplate(location.id, requestedId);
    if (!saved) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
    if (saved.docType !== documentType) return NextResponse.json({ error: "incompatible_template" }, { status: 400 });
    templateId = saved.id;
    templatePaper = saved.paper ?? null;
  } else if (requestedKey) {
    const builtIn = builtInTemplate(requestedKey);
    if (builtIn) {
      if (builtIn.docType !== documentType) return NextResponse.json({ error: "incompatible_template" }, { status: 400 });
      templateKey = builtIn.key;
      templatePaper = builtIn.paper;
    } else {
      // Tolerate the pre-unification spelling where a saved template's id was
      // sent as the key; it is the same choice, stored in the right column.
      if (!UUID_ID.test(requestedKey)) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
      const saved = await getPrintTemplate(location.id, requestedKey);
      if (!saved) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
      if (saved.docType !== documentType) return NextResponse.json({ error: "incompatible_template" }, { status: 400 });
      templateId = saved.id;
      templatePaper = saved.paper ?? null;
    }
  }

  // ── the printers ──
  const { routable } = await loadRoutablePrinters(location.id);
  const printerId = typeof body.printerId === "string" && body.printerId ? body.printerId : null;
  const rawFallbackPrinterId =
    typeof body.fallbackPrinterId === "string" && body.fallbackPrinterId ? body.fallbackPrinterId : null;

  const validatePrinter = (id: string | null, role: "primary" | "fallback"): NextResponse | null => {
    if (!id) return null;
    const printer = routable.find((item) => item.id === id);
    if (!printer) return NextResponse.json({ error: "printer_not_found", role }, { status: 404 });
    if (!printerAcceptsDocument(printer, documentType)) {
      return NextResponse.json({ error: "incompatible_printer", role, printerName: printer.name }, { status: 400 });
    }
    if (templatePaper && !printerAcceptsTemplate(printer, documentType, templatePaper)) {
      return NextResponse.json({ error: "incompatible_template", role, printerName: printer.name }, { status: 400 });
    }
    return null;
  };
  const primaryError = validatePrinter(printerId, "primary");
  if (primaryError) return primaryError;
  const fallbackError = validatePrinter(rawFallbackPrinterId, "fallback");
  if (fallbackError) return fallbackError;
  if (printerId && rawFallbackPrinterId && printerId === rawFallbackPrinterId) {
    // A fallback that IS the primary is not a fallback; it would silently
    // double-print to a printer the operator expected to be spared.
    return NextResponse.json({ error: "duplicate_fallback_printer" }, { status: 400 });
  }
  // Automatic routing (`printerId === null`, «انتخاب خودکار») has no fixed
  // primary printer to fall back from, so `fallback_printer_id` is cleared.
  const fallbackPrinterId = printerId ? rawFallbackPrinterId : null;

  try {
    await query(
      `INSERT INTO print_rules (location_id, document_type, template_key, template_id, printer_id, fallback_printer_id, connection_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ${connectionId ? "(location_id, document_type, connection_id) WHERE connection_id IS NOT NULL" : "(location_id, document_type) WHERE connection_id IS NULL"} DO UPDATE
         SET template_key = EXCLUDED.template_key,
             template_id = EXCLUDED.template_id,
             printer_id = EXCLUDED.printer_id,
             fallback_printer_id = EXCLUDED.fallback_printer_id,
             updated_at = now()`,
      [location.id, documentType, templateKey, templateId, printerId, fallbackPrinterId, connectionId],
    );
    return NextResponse.json({ ok: true, rule: { documentType, templateKey, templateId, printerId, fallbackPrinterId, connectionId } });
  } catch (err) {
    console.error("saving print rule failed", err);
    return NextResponse.json({ error: "print_rules_failed" }, { status: 500 });
  }
});
