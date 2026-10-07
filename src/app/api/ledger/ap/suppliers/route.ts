import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listSupplierBalances, listSupplierBalancePage, listSupplierDirectory } from "@/lib/ap-service";

/**
 * `?scope=directory` → every supplier record with its balance (what a picker
 * needs); default → only suppliers with a nonzero A/P balance, plus the
 * unattributed bucket (what the A/P report shows). The mirror of
 * `/api/ledger/ar/customers`, including `?q=` / `?limit=` / `?offset=` and the
 * `total` + `summary` they answer with — see that route for why an absent
 * `limit` must keep meaning "the whole list".
 */
const MAX_LIMIT = 200;
const MAX_OFFSET = 50_000;

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  if (params.get("scope") === "directory") {
    return NextResponse.json({ suppliers: await listSupplierDirectory(session.businessId) });
  }

  const limitParam = params.get("limit");
  if (limitParam === null) {
    return NextResponse.json({ suppliers: await listSupplierBalances(session.businessId) });
  }
  const requestedLimit = Number(limitParam);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_LIMIT) : MAX_LIMIT;
  const requestedOffset = Number(params.get("offset"));
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? Math.min(requestedOffset, MAX_OFFSET) : 0;
  const q = params.get("q")?.trim() || null;

  return NextResponse.json(await listSupplierBalancePage(session.businessId, { q, limit, offset }));
});
