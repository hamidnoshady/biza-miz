import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isDimensionKind, type DimensionKind } from "@/lib/accounting-dimensions";
import {
  AccountingDimensionError,
  createDimensionValue,
  listDimensionSettings,
  listDimensionValues,
  type DimensionValueInput,
} from "@/lib/accounting-dimensions-service";

/**
 * «ابعاد حسابداری»: the settings (which kinds are on) and the value records.
 *
 * Reading is `ledger.view` — the same door as the journal and the trial balance,
 * because a line's dimension is part of what a reader is entitled to see. Writing
 * is `accounts.edit`: a dimension is the structure of the chart's reporting, and
 * the people who may restructure the chart are the people who may restructure
 * this. Posting with a dimension needs nothing more than the posting itself.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const kindParam = params.get("kind");
  if (kindParam && !isDimensionKind(kindParam)) {
    return NextResponse.json({ error: "unknown_dimension_kind" }, { status: 400 });
  }
  const [settings, values] = await Promise.all([
    listDimensionSettings(session.businessId),
    listDimensionValues(session.businessId, {
      kind: kindParam ? (kindParam as DimensionKind) : undefined,
      includeArchived: params.get("includeArchived") === "1",
    }),
  ]);
  return NextResponse.json({ settings, values });
});

/** Creates one value. Its kind must be one of the four; its code is unique per business and kind. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  let body: Partial<DimensionValueInput>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const value = await createDimensionValue(session.businessId, session.sub, {
      kind: String(body.kind ?? ""),
      code: typeof body.code === "string" ? body.code : "",
      name: typeof body.name === "string" ? body.name : "",
      parentId: typeof body.parentId === "string" ? body.parentId : null,
      locationId: typeof body.locationId === "string" ? body.locationId : null,
      effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : null,
      effectiveTo: typeof body.effectiveTo === "string" ? body.effectiveTo : null,
      isActive: typeof body.isActive === "boolean" ? body.isActive : true,
    });
    return NextResponse.json({ value }, { status: 201 });
  } catch (err) {
    if (err instanceof AccountingDimensionError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
});
