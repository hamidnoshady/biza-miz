import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  createWeightBarcodeTemplate,
  listWeightBarcodeTemplates,
} from "@/lib/weight-barcode-templates-service";

/** Every weight-barcode pattern the shop has defined, oldest first. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.menuView);
  if (error) return error;
  const inventory = await requirePermission(PERMISSIONS.inventoryView);
  if (inventory.error) return inventory.error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ templates: [] });

  const templates = await listWeightBarcodeTemplates(location.id);
  return NextResponse.json({ templates });
});

/** Registers one pattern: a two-digit prefix plus the weight unit. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const inventory = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (inventory.error) return inventory.error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: { prefix?: string; weightUnit?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { template, error: createError } = await createWeightBarcodeTemplate({
    locationId: location.id,
    prefix: body.prefix ?? "",
    weightUnit: body.weightUnit ?? "grams",
  });
  if (createError) {
    const status = createError === "duplicate_prefix" ? 409 : 400;
    return NextResponse.json({ error: createError }, { status });
  }
  return NextResponse.json({ ok: true, template });
});
