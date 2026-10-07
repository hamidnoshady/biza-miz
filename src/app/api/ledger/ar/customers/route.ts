import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listCustomerBalances, listCustomerBalancePage, listCustomerDirectory } from "@/lib/ar-service";

/**
 * `?scope=directory` → every customer record with its balance (what a picker
 * needs); default → only customers with a nonzero A/R balance, plus the
 * unattributed bucket (what the A/R report shows).
 *
 * They were one list, and every picker in the ledger was therefore limited to
 * customers who already owed money and could also offer the unattributed
 * bucket — whose id is the sentinel `"unknown"`, not a uuid. Same access as the
 * rest of the ledger surface either way.
 *
 * The report list also takes `?q=`, `?limit=` and `?offset=`. A screen with a
 * search box and a «بیشتر» button asks for one window and gets `total` (the
 * rows the search matches, before the window) plus `summary` (the whole
 * subledger's totals, deliberately unchanged by the search or the page). With
 * no `limit` the route answers the whole list, exactly as it always did — the
 * directory's balance column and the assistant both read it that way, and a
 * silent 25-row default would have quietly truncated them.
 */
const MAX_LIMIT = 200;
const MAX_OFFSET = 50_000;

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  if (params.get("scope") === "directory") {
    return NextResponse.json({ customers: await listCustomerDirectory(session.businessId) });
  }

  const limitParam = params.get("limit");
  if (limitParam === null) {
    // No window asked for: the unbounded list, with no totals to compute.
    return NextResponse.json({ customers: await listCustomerBalances(session.businessId) });
  }
  const requestedLimit = Number(limitParam);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_LIMIT) : MAX_LIMIT;
  const requestedOffset = Number(params.get("offset"));
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? Math.min(requestedOffset, MAX_OFFSET) : 0;
  const q = params.get("q")?.trim() || null;

  return NextResponse.json(await listCustomerBalancePage(session.businessId, { q, limit, offset }));
});
