import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi, getBusinessIndustry } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { readBoundedJson } from "@/lib/product-attributes";
import { attributeTemplateByKey } from "@/lib/product-attribute-templates";
import { applyAttributeTemplate } from "@/lib/product-attributes-service";
import { withTenantTransaction } from "@/lib/db";

/**
 * POST /api/products/attributes/apply-template — applies one per-category
 * attribute template to the active branch (#1567 P0 2.2–2.3).
 *
 * Idempotent by construction: definitions the branch already owns are
 * skipped, never overwritten, so pressing the button twice (or after the
 * shop renamed a seeded value) changes nothing the tenant did not ask for.
 * A template key that does not exist, or is not offered to this business's
 * industry, answers the same 404 — the catalog is small and public in the
 * client bundle anyway, there is nothing to hide behind a distinct error.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const body = await readBoundedJson(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.error === "payload_too_large" ? 413 : 400 });
  }
  const raw = body.value;
  const templateKey = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as { templateKey?: unknown }).templateKey
    : undefined;
  if (typeof templateKey !== "string" || !templateKey.trim()) {
    return NextResponse.json({ error: "template_key_required" }, { status: 400 });
  }

  const template = attributeTemplateByKey(templateKey.trim());
  const industry = await getBusinessIndustry(session.businessId);
  if (!template || !industry || !template.industries.includes(industry)) {
    return NextResponse.json({ error: "unknown_template" }, { status: 404 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const result = await withTenantTransaction(
    session.businessId,
    (client) => applyAttributeTemplate(client, { locationId: location.id, template }),
    { locationId: location.id },
  );
  return NextResponse.json({ ok: true, ...result });
});
