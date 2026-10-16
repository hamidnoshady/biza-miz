import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  AccountingDimensionError,
  deleteDimensionMapping,
  updateDimensionMapping,
  type DimensionMappingInput,
} from "@/lib/accounting-dimension-mappings-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Issue #868 — edits or removes one trading attribution rule. Only the fields
 * present in the body are applied. Posted history is never touched: journal
 * lines carry their stamped dimension values, not a reference to the rule.
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

  const patch: Partial<DimensionMappingInput> = {};
  if ("scope" in body) patch.scope = body.scope as DimensionMappingInput["scope"];
  if ("ref" in body) patch.ref = typeof body.ref === "string" ? body.ref : "";
  if ("dimensions" in body) patch.dimensions = (body.dimensions ?? {}) as DimensionMappingInput["dimensions"];
  if ("isActive" in body) {
    if (typeof body.isActive !== "boolean") return NextResponse.json({ error: "bad_request" }, { status: 400 });
    patch.isActive = body.isActive;
  }
  if ("effectiveFrom" in body) patch.effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom : null;
  if ("effectiveTo" in body) patch.effectiveTo = typeof body.effectiveTo === "string" ? body.effectiveTo : null;
  if ("note" in body) patch.note = typeof body.note === "string" ? body.note : null;

  try {
    const mapping = await updateDimensionMapping(session.businessId, id, patch);
    return NextResponse.json({ mapping });
  } catch (err) {
    if (err instanceof AccountingDimensionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});

export const DELETE = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    await deleteDimensionMapping(session.businessId, id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    if (err instanceof AccountingDimensionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
