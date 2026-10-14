import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { builtInTemplate, type DocType } from "@/lib/print-template";
import { getPrintTemplate, loadRoutablePrinters, resolvePrintPlan } from "@/lib/printing/plan";
import { isDocType, printerAcceptsDocument } from "@/lib/printing/routing";

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

const DOCUMENT_TYPES: DocType[] = ["receipt", "invoice", "kitchen", "label"];

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ rules: [], resolved: {} });

  try {
    const { rows } = await query<{
      document_type: string;
      template_key: string | null;
      template_id: string | null;
      printer_id: string | null;
      fallback_printer_id: string | null;
    }>(
      `SELECT document_type, template_key, template_id, printer_id, fallback_printer_id
         FROM print_rules WHERE location_id = $1 ORDER BY document_type`,
      [location.id],
    );

    // What each document type would print right now — resolved with the very
    // same function the till calls, branding skipped because this is a view.
    const resolved: Record<string, unknown> = {};
    for (const documentType of DOCUMENT_TYPES) {
      const plan = await resolvePrintPlan({ locationId: location.id, documentType, includeBranding: false });
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

    return NextResponse.json({ rules: rows, resolved });
  } catch (err) {
    console.error("listing print rules failed", err);
    return NextResponse.json({ error: "print_rules_failed", rules: [], resolved: {} }, { status: 500 });
  }
});

interface RuleBody {
  documentType?: string;
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

  // ── the template ──
  let templateKey: string | null = null;
  let templateId: string | null = null;
  const requestedId = typeof body.templateId === "string" && body.templateId.trim() ? body.templateId.trim() : null;
  const requestedKey = typeof body.templateKey === "string" && body.templateKey.trim() ? body.templateKey.trim() : null;
  if (requestedId) {
    const saved = await getPrintTemplate(location.id, requestedId);
    if (!saved) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
    if (saved.docType !== documentType) return NextResponse.json({ error: "incompatible_template" }, { status: 400 });
    templateId = saved.id;
  } else if (requestedKey) {
    const builtIn = builtInTemplate(requestedKey);
    if (builtIn) {
      if (builtIn.docType !== documentType) return NextResponse.json({ error: "incompatible_template" }, { status: 400 });
      templateKey = builtIn.key;
    } else {
      // Tolerate the pre-unification spelling where a saved template's id was
      // sent as the key; it is the same choice, stored in the right column.
      const saved = await getPrintTemplate(location.id, requestedKey);
      if (!saved) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
      if (saved.docType !== documentType) return NextResponse.json({ error: "incompatible_template" }, { status: 400 });
      templateId = saved.id;
    }
  }

  // ── the printers ──
  const { routable } = await loadRoutablePrinters(location.id);
  const printerId = typeof body.printerId === "string" && body.printerId ? body.printerId : null;
  const fallbackPrinterId =
    typeof body.fallbackPrinterId === "string" && body.fallbackPrinterId ? body.fallbackPrinterId : null;

  const validatePrinter = (id: string | null, role: "primary" | "fallback"): NextResponse | null => {
    if (!id) return null;
    const printer = routable.find((item) => item.id === id);
    if (!printer) return NextResponse.json({ error: "printer_not_found", role }, { status: 404 });
    if (!printerAcceptsDocument(printer, documentType)) {
      return NextResponse.json({ error: "incompatible_printer", role, printerName: printer.name }, { status: 400 });
    }
    return null;
  };
  const primaryError = validatePrinter(printerId, "primary");
  if (primaryError) return primaryError;
  const fallbackError = validatePrinter(fallbackPrinterId, "fallback");
  if (fallbackError) return fallbackError;
  if (printerId && fallbackPrinterId && printerId === fallbackPrinterId) {
    // A fallback that IS the primary is not a fallback; it would silently
    // double-print to a printer the operator expected to be spared.
    return NextResponse.json({ error: "duplicate_fallback_printer" }, { status: 400 });
  }

  try {
    await query(
      `INSERT INTO print_rules (location_id, document_type, template_key, template_id, printer_id, fallback_printer_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (location_id, document_type) DO UPDATE
         SET template_key = EXCLUDED.template_key,
             template_id = EXCLUDED.template_id,
             printer_id = EXCLUDED.printer_id,
             fallback_printer_id = EXCLUDED.fallback_printer_id,
             updated_at = now()`,
      [location.id, documentType, templateKey, templateId, printerId, fallbackPrinterId],
    );
    return NextResponse.json({ ok: true, rule: { documentType, templateKey, templateId, printerId, fallbackPrinterId } });
  } catch (err) {
    console.error("saving print rule failed", err);
    return NextResponse.json({ error: "print_rules_failed" }, { status: 500 });
  }
});
