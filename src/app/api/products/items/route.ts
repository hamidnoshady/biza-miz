import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { BarcodeConflictError } from "@/lib/item-barcodes-service";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { createProductRecord, ProductAttributeValidationError } from "@/lib/product-creation-service";
import { parseProductCreateInput } from "@/lib/product-input";
import { PRODUCT_CREATE_REQUEST_MAX_BYTES, readBoundedJson } from "@/lib/product-attributes";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Creates one simple product or one complete variant family.
 *
 * Validation is shared with the form and finishes before the first write. The
 * service then commits the parent, children, scanner barcodes and opening
 * values in one transaction, so a conflict cannot leave a partial product.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const body = await readBoundedJson(request, PRODUCT_CREATE_REQUEST_MAX_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.error === "payload_too_large" ? 413 : 400 });
  }

  const parsed = parseProductCreateInput(body.value);
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
    if (creationError instanceof ProductAttributeValidationError) {
      return NextResponse.json(
        {
          error: "validation_failed",
          message: creationError.issues[0]?.message ?? "ویژگی‌های تنوع معتبر نیستند.",
          issues: creationError.issues,
          refreshDefinitions: true,
        },
        { status: 400 },
      );
    }
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
