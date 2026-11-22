import { NextResponse } from "next/server";
import { getSession, requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { isAbsoluteRole, PERMISSIONS } from "@/lib/permissions";
import type { Role } from "@/lib/auth-edge";
import { resolveActiveLocation } from "@/lib/setup-state";
import { parsePrintPolicy } from "@/lib/printing/behavior";
import { loadPrintBehavior } from "@/lib/printing/behavior-service";

function canEditDefaults(session: { role: Role; locationId?: string | null }): boolean {
  return isAbsoluteRole(session.role) && !session.locationId;
}

export const GET = withTenantScope(async () => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  return NextResponse.json({
    ...await loadPrintBehavior(session.businessId, location.id),
    canEditDefaults: canEditDefaults(session),
  }, {
    headers: { "Cache-Control": "private, no-store" },
  });
});

export const PUT = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const body: { scope?: unknown; policy?: unknown } | null = await request.json().catch(() => null);
  // Location-constrained staff may edit their own branch. Business defaults
  // apply to every location and require an unrestricted owner.
  if (body?.scope === "business" && !canEditDefaults(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const policy = parsePrintPolicy(body?.policy);
  if (!policy || (body?.scope !== "business" && body?.scope !== "branch")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  await query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, $2, 'printing.behavior', $3::jsonb)
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [session.businessId, body.scope === "business" ? null : location.id, JSON.stringify(policy)],
  );
  return NextResponse.json({
    ...await loadPrintBehavior(session.businessId, location.id),
    canEditDefaults: canEditDefaults(session),
  });
});
