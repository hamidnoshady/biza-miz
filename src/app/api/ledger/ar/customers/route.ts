import { parseSubledgerWindow } from "@/lib/subledger-pagination";
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
 * no paging or search parameters the route answers the whole list, exactly as it always did — the
 * directory's balance column and the assistant both read it that way, and a
 * silent 25-row default would have quietly truncated them.
 */

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  if (params.get("scope") === "directory") {
    return NextResponse.json({ customers: await listCustomerDirectory(session.businessId) });
  }

  let window: ReturnType<typeof parseSubledgerWindow>;
  try {
    window = parseSubledgerWindow(params);
  } catch {
    return NextResponse.json({ error: "invalid_pagination" }, { status: 400 });
  }
  if (!window) {
    return NextResponse.json({ customers: await listCustomerBalances(session.businessId) });
  }
  const q = params.get("q")?.trim() || null;

  return NextResponse.json(await listCustomerBalancePage(session.businessId, { q, ...window }));
});
