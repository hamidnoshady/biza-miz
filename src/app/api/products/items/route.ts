import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { BarcodeConflictError } from "@/lib/item-barcodes-service";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { createProductRecord } from "@/lib/product-creation-service";
import { parseProductCreateInput } from "@/lib/product-input";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Creates one simple product or one complete variant family.
 *
 * Validation is shared with the form and finishes before the first write. The
 * service then commits the parent, children, scanner barcodes and opening
 * values in one transaction, so a conflict cannot leave a partial product.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = parseProductCreateInput(raw);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error: "validation_failed",
        message: parsed.issues[0]?.message ?? "اطلاعات محصول معتبر نیست.",
        issues: parsed.issues,
      },
      { status: 400 },
    );
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const created = await createProductRecord(location.id, parsed.data, {
      businessId: session.businessId,
      userId: session.sub,
      recommendation: parsed.data.priceRecommendation,
    });
    return NextResponse.json({ ok: true, ...created }, { status: 201 });
  } catch (creationError) {
    if (creationError instanceof BarcodeConflictError) {
      return NextResponse.json(
        {
          error: "duplicate_barcode",
          message: "این بارکد قبلاً برای محصول دیگری در همین شعبه ثبت شده است.",
        },
        { status: 409 },
      );
    }
    throw creationError;
  }
});
