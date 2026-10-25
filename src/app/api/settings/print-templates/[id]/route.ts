import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deletePrintTemplate, getPrintTemplate, updatePrintTemplate } from "@/lib/print-templates-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { loadTemplateAccessContext } from "@/lib/printing/template-catalog-server";

export const PUT = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const resolvedContext = await loadTemplateAccessContext(location.id);
  if (!resolvedContext) return NextResponse.json({ error: "business_type_unavailable" }, { status: 403 });
  const { id } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const existing = await getPrintTemplate(location.id, id);
  if (!existing) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  const candidate = body.template && typeof body.template === "object" ? body.template as Record<string, unknown> : null;
  const isWooTemplate = candidate?.docType === "shipping_label" || candidate?.docType === "woo_invoice" ||
    existing.docType === "shipping_label" || existing.docType === "woo_invoice";
  const wooPermission = isWooTemplate ? await requirePermission(PERMISSIONS.woocommerceView) : null;
  if (wooPermission?.error) return wooPermission.error;
  const accessContext = { ...resolvedContext, wooEnabled: resolvedContext.wooEnabled && (!isWooTemplate || !wooPermission?.error) };

  const result = await updatePrintTemplate({
    locationId: location.id,
    id,
    template: body.template,
    isDefault: typeof body.isDefault === "boolean" ? body.isDefault : undefined,
    accessContext,
  });
  if (result.error) {
    const status = result.error === "template_not_found" ? 404 : result.error === "duplicate_template_name" ? 409 : result.error === "template_not_available" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ template: result.template });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const { id } = await context.params;
  const existing = await getPrintTemplate(location.id, id);
  if (!existing) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  if (existing.docType === "shipping_label" || existing.docType === "woo_invoice") {
    const wooPermission = await requirePermission(PERMISSIONS.woocommerceView);
    if (wooPermission.error) return wooPermission.error;
  }
  const removed = await deletePrintTemplate(location.id, id);
  if (!removed) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
