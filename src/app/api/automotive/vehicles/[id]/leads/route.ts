import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import {
  linkLeadVehicle,
  listLeadsInterestedInVehicle,
  unlinkLeadVehicle,
  VehicleLeadError,
  type LeadVehicleLinkPurpose,
} from "@/lib/automotive-lead-service";
import { handleAutomotiveError, readBody } from "../../../guard";

/**
 * §12 — the lot-to-lead direction: *which open leads are looking for this car*,
 * and which cars have been shown to which lead.
 *
 * The match is a query over the typed preferences 0213 stores (make/model,
 * new-or-used, year and budget ranges), not a text search over a note — which
 * is the whole reason those fields are columns. A lead already linked to this
 * car is listed first, with the reason it was linked.
 *
 * Reading needs `crm.view`, writing needs `crm.manage`: the rows belong to a
 * lead, so the CRM's keys gate them.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;

  try {
    const leads = await listLeadsInterestedInVehicle(session.businessId, id);
    return NextResponse.json({ leads });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});

/** Links a car to a lead ("shown this unit"), updating the reason on a repeat. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmManage);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readBody(request);
  const leadId = typeof body.leadId === "string" ? body.leadId : "";
  if (!leadId) return NextResponse.json({ error: "missing_lead" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const link = await linkLeadVehicle(client, {
      businessId: session.businessId,
      leadId,
      serialId: id,
      purpose: (body.purpose as LeadVehicleLinkPurpose) ?? "interest",
      note: typeof body.note === "string" ? body.note : null,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...link });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof VehicleLeadError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});

/** Removes one link. */
export const DELETE = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmManage);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const leadId = new URL(request.url).searchParams.get("leadId") ?? "";
  if (!leadId) return NextResponse.json({ error: "missing_lead" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const removed = await unlinkLeadVehicle(client, { businessId: session.businessId, leadId, serialId: id });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
