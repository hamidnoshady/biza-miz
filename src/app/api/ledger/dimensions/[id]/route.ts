import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  AccountingDimensionError,
  deleteDimensionValue,
  updateDimensionValue,
  type DimensionValuePatch,
} from "@/lib/accounting-dimensions-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Renames, re-parents, re-dates, restricts, archives or restores one value. The
 * kind never changes. Only the fields present in the body are applied, and all
 * of them or none (one transaction).
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const patch: DimensionValuePatch = {};
  if ("code" in body) patch.code = typeof body.code === "string" ? body.code : "";
  if ("name" in body) patch.name = typeof body.name === "string" ? body.name : "";
  if ("parentId" in body) patch.parentId = typeof body.parentId === "string" ? body.parentId : null;
  if ("locationId" in body) patch.locationId = typeof body.locationId === "string" ? body.locationId : null;
  if ("effectiveFrom" in body) patch.effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom : null;
  if ("effectiveTo" in body) patch.effectiveTo = typeof body.effectiveTo === "string" ? body.effectiveTo : null;
  if ("isActive" in body) {
    if (typeof body.isActive !== "boolean") return NextResponse.json({ error: "bad_request" }, { status: 400 });
    patch.isActive = body.isActive;
  }

  try {
    const value = await updateDimensionValue(session.businessId, session.sub, id, patch);
    return NextResponse.json({ value });
  } catch (err) {
    if (err instanceof AccountingDimensionError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
});

/**
 * Removes a value nobody has posted to; archives one that has. The response says
 * which happened, so the screen can tell the person why the row stayed.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    const result = await deleteDimensionValue(session.businessId, id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AccountingDimensionError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
});
