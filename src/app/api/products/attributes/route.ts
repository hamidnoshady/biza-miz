import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { parseAttributeDefinitionInput, readBoundedJson } from "@/lib/product-attributes";
import {
  createAttributeDefinition,
  listAttributeDefinitions,
} from "@/lib/product-attributes-service";

/** The attribute master follows the retail product catalog's inventory permissions. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ definitions: [] });

  const definitions = await listAttributeDefinitions(location.id);
  return NextResponse.json({ definitions });
});

/** Creates one branch-scoped attribute definition and its controlled values. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const body = await readBoundedJson(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.error === "payload_too_large" ? 413 : 400 });
  }
  const parsed = parseAttributeDefinitionInput(body.value, "create");
  if (!parsed.ok) {
    return NextResponse.json({ error: "validation_failed", issues: parsed.issues }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { definition, error: createError } = await createAttributeDefinition({
    businessId: session.businessId,
    locationId: location.id,
    name: parsed.data.name!,
    options: parsed.data.options ?? [],
    isActive: parsed.data.isActive ?? true,
  });
  if (createError) {
    const status = createError === "duplicate_name" ? 409 : 400;
    return NextResponse.json({ error: createError }, { status });
  }
  return NextResponse.json({ ok: true, definition });
});
