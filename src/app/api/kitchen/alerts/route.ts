import { NextResponse } from "next/server";
import { requirePermission, requirePermissions, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { isModuleEnabled } from "@/lib/industry-guard";
import { parseKitchenAlertThresholds } from "@/lib/kitchen-alerts";
import {
  loadKitchenAlertThresholds,
  saveKitchenAlertThresholds,
} from "@/lib/kitchen-alert-service";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * The branch's persisted kitchen aging policy. GET is readable to every member
 * who can open the KDS; PUT is the ordinary `settings.manage` action, like the
 * kitchen workflow and print-behaviour routes. Thresholds are not a device
 * preference: two KDS screens on one pass must agree.
 */
export const GET = withTenantScope(async () => {
  const guard = await requirePermission(PERMISSIONS.kitchenView);
  if (guard.error) return guard.error;
  const location = await resolveActiveLocation(guard.session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await isModuleEnabled(guard.session.businessId, "kitchen"))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const layers = await loadKitchenAlertThresholds(guard.session.businessId, location.id);
  return NextResponse.json(
    {
      thresholds: layers.effective,
      canEdit: guard.membership.permissions.has(PERMISSIONS.settingsManage),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
});

export const PUT = withTenantScope(async (request: Request) => {
  // The same pair the kitchen workflow route uses: editing the pass's aging
  // policy is a kitchen-context settings action, not a detached back-office one.
  const guard = await requirePermissions(PERMISSIONS.kitchenView, PERMISSIONS.settingsManage);
  if (guard.error) return guard.error;
  const location = await resolveActiveLocation(guard.session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await isModuleEnabled(guard.session.businessId, "kitchen"))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body: { thresholds?: unknown } | null = await request.json().catch(() => null);
  const thresholds = parseKitchenAlertThresholds(body?.thresholds);
  if (!thresholds) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  await saveKitchenAlertThresholds(
    { query },
    {
      businessId: guard.session.businessId,
      locationId: location.id,
      thresholds,
    },
  );
  return NextResponse.json({ thresholds, canEdit: true });
});
