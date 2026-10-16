import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  AccountingDimensionError,
  createDimensionMapping,
  listDimensionMappings,
  type DimensionMappingInput,
} from "@/lib/accounting-dimension-mappings-service";

/**
 * Issue #868 — trading attribution rules: the list plus creation. A mapping is
 * configuration, not a fact: postings stamp their values (explicit or resolved
 * through these rules) on the journal lines and never point back at a rule, so
 * editing or deleting one never touches posted history.
 *
 * GET   → `ledger.view` — anyone who can read the ledger can see the rules.
 * POST  → `accounts.edit` — same write permission as the dimension manager.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const scopeParam = request.nextUrl.searchParams.get("scope");
  const scope = scopeParam === "item" || scopeParam === "product_category" || scopeParam === "supplier" || scopeParam === "sales_channel"
    ? scopeParam
    : undefined;
  const mappings = await listDimensionMappings(session.businessId, scope ? { scope } : undefined);
  return NextResponse.json({ mappings });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    // `createDimensionMapping` parses + validates the raw shape internally
    // (invalid scope/ref/dates/values → `AccountingDimensionError`).
    const mapping = await createDimensionMapping(
      session.businessId,
      body as unknown as DimensionMappingInput,
      session.sub,
    );
    return NextResponse.json({ mapping }, { status: 201 });
  } catch (err) {
    if (err instanceof AccountingDimensionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
