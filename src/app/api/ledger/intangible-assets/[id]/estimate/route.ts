import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  changeIntangibleEstimate,
  IntangibleAssetError,
  previewIntangibleEstimate,
} from "@/lib/intangible-assets-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * A prospective estimate change (issue #1326, ESH-163): revise the remaining
 * useful life and/or residual value from a stated effective date forward.
 *
 * Posted months and their vouchers are never rewritten — the change is a new
 * approved history row and the revised arithmetic prices only the periods from
 * its effective month. `GET` is a side-effect-free preview of the same change.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "intangible_asset_not_found" }, { status: 404 });

  let body: {
    effectiveDate?: string;
    usefulLifeType?: string;
    usefulLifeMonths?: number | null;
    residualValue?: number | null;
    reason?: string;
    evidenceReference?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await changeIntangibleEstimate({
      businessId: session.businessId,
      intangibleAssetId: id,
      effectiveDate: String(body.effectiveDate ?? ""),
      usefulLifeType: typeof body.usefulLifeType === "string" ? body.usefulLifeType : null,
      usefulLifeMonths:
        body.usefulLifeMonths === undefined || body.usefulLifeMonths === null
          ? null
          : Number(body.usefulLifeMonths),
      residualValue:
        body.residualValue === undefined || body.residualValue === null ? null : Number(body.residualValue),
      reason: String(body.reason ?? ""),
      evidenceReference: typeof body.evidenceReference === "string" ? body.evidenceReference : null,
      createdBy: session.sub,
      idempotencyKey: request.headers.get("Idempotency-Key"),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof IntangibleAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});

/** Preview the proposed estimate without writing anything. */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "intangible_asset_not_found" }, { status: 404 });

  const params = request.nextUrl.searchParams;
  const lifeType = params.get("usefulLifeType");
  try {
    const preview = await previewIntangibleEstimate({
      businessId: session.businessId,
      intangibleAssetId: id,
      effectiveDate: params.get("effectiveDate") ?? "",
      usefulLifeType: lifeType === "finite" || lifeType === "indefinite" ? lifeType : null,
      usefulLifeMonths: params.get("usefulLifeMonths") ? Number(params.get("usefulLifeMonths")) : null,
      residualValue: params.get("residualValue") ? Number(params.get("residualValue")) : null,
    });
    return NextResponse.json(preview);
  } catch (err) {
    if (err instanceof IntangibleAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
