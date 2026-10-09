import { parseSubledgerWindow } from "@/lib/subledger-pagination";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listSupplierBalances, listSupplierBalancePage, listSupplierDirectory } from "@/lib/ap-service";

/**
 * `?scope=directory` → every supplier record with its balance (what a picker
 * needs); default → only suppliers with a nonzero A/P balance, plus the
 * unattributed bucket (what the A/P report shows). The mirror of
 * `/api/ledger/ar/customers`, including `?q=` / `?limit=` / `?offset=` and the
 * `total` + `summary` they answer with — see that route for why a request
 * without search or paging parameters must keep meaning "the whole list".
 */

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  if (params.get("scope") === "directory") {
    return NextResponse.json({ suppliers: await listSupplierDirectory(session.businessId) });
  }

  let window: ReturnType<typeof parseSubledgerWindow>;
  try {
    window = parseSubledgerWindow(params);
  } catch {
    return NextResponse.json({ error: "invalid_pagination" }, { status: 400 });
  }
  if (!window) {
    return NextResponse.json({ suppliers: await listSupplierBalances(session.businessId) });
  }
  const q = params.get("q")?.trim() || null;

  return NextResponse.json(await listSupplierBalancePage(session.businessId, { q, ...window }));
});
