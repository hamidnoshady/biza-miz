import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { bulkUpdateVariantMatrix, withMerchandisingTransaction, type MatrixVariantUpdate } from "@/lib/merchandising-service";
import { PRODUCT_WORKSPACE_INDUSTRIES } from "@/lib/product-workspace";

// The variant-board trades, declared once in product-workspace.ts. The
// coverage guard (industry-coverage.test.ts) fails the build on a restated
// industry list, so this must stay an import.
const MATRIX_TRADES = PRODUCT_WORKSPACE_INDUSTRIES;

/** Sets price and/or stock across a whole variant grid in one transaction; a failure on one cell rolls back the whole grid. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  const industry = await getBusinessIndustry(session.businessId);
  if (!industry || !(MATRIX_TRADES as readonly string[]).includes(industry)) {
    return NextResponse.json({ error: "industry_unavailable" }, { status: 403 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { updates?: MatrixVariantUpdate[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!Array.isArray(body.updates) || body.updates.length === 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    await withMerchandisingTransaction((client) =>
      bulkUpdateVariantMatrix(client, {
        businessId: session.businessId,
        locationId: location.id,
        updates: body.updates!,
        createdBy: session.sub,
      }),
    );
    return NextResponse.json({ ok: true, count: body.updates.length });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
