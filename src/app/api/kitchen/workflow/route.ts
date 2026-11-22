import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { isModuleEnabled } from "@/lib/industry-guard";
import { getKitchenWorkflow, isKitchenWorkflow } from "@/lib/kitchen-workflow";
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
  const { rows } = await query<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE business_id = $1 AND location_id = $2
       AND key IN ('kitchen.clearAfterPayment', 'kitchen.clearAfterMinutes', 'kitchen.clearAfterShift')`,
    [session.businessId, location.id],
  );
  return NextResponse.json({
    workflow,
    clearAfterPayment: rows.find((row) => row.key === "kitchen.clearAfterPayment")?.value === true,
    clearAfterMinutes: rows.find((row) => row.key === "kitchen.clearAfterMinutes")?.value ?? null,
    clearAfterShift: rows.find((row) => row.key === "kitchen.clearAfterShift")?.value === true,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
});

export const PUT = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermissions(PERMISSIONS.kitchenView, PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location || !await isModuleEnabled(session.businessId, "kitchen")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body: { workflow?: unknown; clearAfterPayment?: unknown; clearAfterMinutes?: unknown; clearAfterShift?: unknown } | null =
    await request.json().catch(() => null);
  const workflow = body?.workflow;
  const minutes = body?.clearAfterMinutes;
  if (!isKitchenWorkflow(workflow) || typeof body?.clearAfterPayment !== "boolean" || typeof body.clearAfterShift !== "boolean" ||
    (minutes !== null && (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  await query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, $2, 'kitchen.workflow', to_jsonb($3::text)),
            ($1, $2, 'kitchen.clearAfterPayment', to_jsonb($4::boolean)),
            ($1, $2, 'kitchen.clearAfterMinutes', $5::jsonb),
            ($1, $2, 'kitchen.clearAfterShift', to_jsonb($6::boolean))
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [session.businessId, location.id, workflow, body.clearAfterPayment, JSON.stringify(minutes), body.clearAfterShift],
  );
  return NextResponse.json({
    workflow,
    clearAfterPayment: body.clearAfterPayment,
    clearAfterMinutes: minutes,
    clearAfterShift: body.clearAfterShift,
  });
});
