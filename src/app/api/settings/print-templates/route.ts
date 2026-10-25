import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createPrintTemplate, listPrintTemplates } from "@/lib/print-templates-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  availableBuiltInTemplates,
  eligibleTemplates,
  templateUnavailableReason,
} from "@/lib/printing/template-catalog";
import { loadTemplateAccessContext } from "@/lib/printing/template-catalog-server";

/** The branch's saved templates plus the currently eligible built-ins. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ templates: [], builtIns: [], unavailableTemplates: [] });
  const resolvedContext = await loadTemplateAccessContext(location.id);
  if (!resolvedContext) return NextResponse.json({ error: "business_type_unavailable" }, { status: 403 });
  const wooPermission = await requirePermission(PERMISSIONS.woocommerceView);
  const accessContext = { ...resolvedContext, wooEnabled: resolvedContext.wooEnabled && !wooPermission.error };
  const saved = await listPrintTemplates(location.id);
  const templates = eligibleTemplates(saved, accessContext);
  const unavailableTemplates = saved
    .filter((template) => (wooPermission.error ? template.docType !== "shipping_label" && template.docType !== "woo_invoice" : true))
    .filter((template) => templateUnavailableReason(template, accessContext) !== null)
    .map((template) => ({
      id: template.id,
      name: template.name,
      docType: template.docType,
      reason: templateUnavailableReason(template, accessContext),
    }));
  return NextResponse.json({
    templates,
    builtIns: availableBuiltInTemplates(accessContext),
    unavailableTemplates,
    industry: accessContext.industry,
  }, { headers: { "Cache-Control": "private, no-store" } });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const resolvedContext = await loadTemplateAccessContext(location.id);
  if (!resolvedContext) return NextResponse.json({ error: "business_type_unavailable" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const candidate = body.template && typeof body.template === "object" ? body.template as Record<string, unknown> : null;
  const needsWooPermission = candidate?.docType === "shipping_label" || candidate?.docType === "woo_invoice";
  const wooPermission = needsWooPermission ? await requirePermission(PERMISSIONS.woocommerceView) : null;
  if (wooPermission?.error) return wooPermission.error;
  const accessContext = { ...resolvedContext, wooEnabled: resolvedContext.wooEnabled && (!needsWooPermission || !wooPermission?.error) };

  const result = await createPrintTemplate({
    locationId: location.id,
    template: body.template,
    isDefault: body.isDefault === true,
    accessContext,
  });
  if (result.error) {
    const status = result.error === "duplicate_template_name" ? 409 : result.error === "template_not_available" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ template: result.template }, { status: 201 });
});
