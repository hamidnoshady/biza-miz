import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { isModuleEnabled } from "@/lib/industry-guard";
import { getKitchenWorkflow } from "@/lib/kitchen-workflow";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermissions(PERMISSIONS.kitchenView, PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location || !await isModuleEnabled(session.businessId, "kitchen")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const workflow = await getKitchenWorkflow(session.businessId, location.id);
  return NextResponse.json({ workflow }, { headers: { "Cache-Control": "no-store" } });
});

export const PUT = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermissions(PERMISSIONS.kitchenView, PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location || !await isModuleEnabled(session.businessId, "kitchen")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body: { workflow?: unknown } | null = await request.json().catch(() => null);
  const workflow = body?.workflow;
  if (workflow !== "kitchen_team" && workflow !== "ready_on_send") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  await query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, $2, 'kitchen.workflow', to_jsonb($3::text))
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [session.businessId, location.id, workflow],
  );
  return NextResponse.json({ workflow });
});
