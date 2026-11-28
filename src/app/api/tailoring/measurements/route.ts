import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  eraseMeasurements,
  exportMeasurements,
  getRetentionDays,
  measurementAccessLog,
  purgeExpiredMeasurements,
  recordMeasurements,
  setRetentionDays,
  viewMeasurements,
} from "@/lib/tailoring-service";
import { tailoringFailure, tailoringScope, uuidSchema } from "@/lib/tailoring-http";
import { parseAccessPurpose } from "@/lib/tailoring-workflow";

/**
 * GH #1567 6A — a customer's body measurements. One route on purpose (each
 * route adds ~0.15 MiB to the desktop runtime, which sits at its size gate):
 *
 * - `GET ?partyId&purpose` — open the measurements. Needs `tailoring.measurements`
 *   and a stated purpose; every access is logged.
 * - `GET ?view=log&partyId` — who opened them, when and why (no values).
 * - `GET ?view=export&partyId` — data-subject export of every version, logged
 *   as `export`; also needs `crm.export`.
 * - `POST` — record a new version (never overwrites).
 * - `GET ?view=retention` — the retention period and a dry-run of the purge;
 *   `POST ?view=retention` `{action:"set",days}` | `{action:"purge",confirm:true}`.
 *   Both also need `settings.manage`.
 * - `DELETE` — erase every version's values (rows and access log remain);
 *   also needs `crm.delete` and `confirm: true`.
 *
 * Not an AI/MCP surface (coverage map: route-only by design).
 */
export const GET = withTenantScope(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const view = params.get("view");
  if (view !== null && view !== "log" && view !== "export" && view !== "retention") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const scope = await tailoringScope(view === "export"
    ? await requirePermissions(PERMISSIONS.tailoringMeasurements, PERMISSIONS.crmExport)
    : view === "retention"
      ? await requirePermissions(PERMISSIONS.tailoringMeasurements, PERMISSIONS.settingsManage)
      : await requirePermissions(PERMISSIONS.tailoringMeasurements));
  if (scope.error) return scope.error;
  if (view === "retention") {
    try {
      return NextResponse.json({
        retentionDays: await getRetentionDays(scope.actor.businessId),
        preview: await purgeExpiredMeasurements(scope.actor, { apply: false }),
      });
    } catch (error) {
      return tailoringFailure(error);
    }
  }
  const partyId = uuidSchema.safeParse(params.get("partyId"));
  if (!partyId.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    if (view === "log") {
      return NextResponse.json({ entries: await measurementAccessLog(scope.actor, partyId.data) });
    }
    if (view === "export") {
      const body = await exportMeasurements(scope.actor, partyId.data);
      return new NextResponse(JSON.stringify(body, null, 2), { headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="measurements-${partyId.data}.json"`,
        "Cache-Control": "no-store",
      } });
    }
    const purpose = parseAccessPurpose(params.get("purpose"));
    if (!purpose) return NextResponse.json({ error: "tailoring_purpose_required" }, { status: 400 });
    return NextResponse.json(await viewMeasurements(scope.actor, partyId.data, purpose),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return tailoringFailure(error);
  }
});

const recordBody = z.object({ partyId: uuidSchema, measurements: z.unknown() }).strict();
const retentionCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), days: z.number().int().min(30).max(3650) }).strict(),
  z.object({ action: z.literal("purge"), confirm: z.literal(true) }).strict(),
]);

export const POST = withTenantScope(async (request: Request) => {
  const view = new URL(request.url).searchParams.get("view");
  if (view !== null && view !== "retention") return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (view === "retention") {
    const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringMeasurements, PERMISSIONS.settingsManage));
    if (scope.error) return scope.error;
    const parsed = retentionCommand.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    try {
      if (parsed.data.action === "set") return NextResponse.json(await setRetentionDays(scope.actor, parsed.data.days));
      return NextResponse.json(await purgeExpiredMeasurements(scope.actor, { apply: true }));
    } catch (error) {
      return tailoringFailure(error);
    }
  }
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringMeasurements));
  if (scope.error) return scope.error;
  const body = recordBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ version: await recordMeasurements(scope.actor, body.data.partyId, body.data.measurements) }, { status: 201 });
  } catch (error) {
    return tailoringFailure(error);
  }
});

const eraseBody = z.object({ partyId: uuidSchema, reason: z.string().trim().min(3).max(500), confirm: z.literal(true) }).strict();

export const DELETE = withTenantScope(async (request: Request) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringMeasurements, PERMISSIONS.crmDelete));
  if (scope.error) return scope.error;
  const parsed = eraseBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json(await eraseMeasurements(scope.actor, parsed.data.partyId, parsed.data.reason));
  } catch (error) {
    return tailoringFailure(error);
  }
});
