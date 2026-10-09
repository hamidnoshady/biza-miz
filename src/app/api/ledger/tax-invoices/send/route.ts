import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { queueAndSend } from "@/lib/tax-invoice-service";
import { readJsonBody, stringArray, taxErrorResponse } from "@/lib/tax-invoice-http";

/**
 * Queue prepared records and send them now. The send is the irreversible step:
 * it hands the stored snapshot to the authority under the record's uid, and a
 * record that cannot be confirmed goes to inquiry rather than being sent again.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxSend);
  if (error) return error;
  const body = await readJsonBody<{ ids?: unknown }>(request);
  const ids = stringArray(body?.ids, 50);
  if (!ids) return NextResponse.json({ error: "ids_required" }, { status: 400 });
  try {
    const results = await queueAndSend({ businessId: session.businessId, userId: session.sub }, ids);
    return NextResponse.json({ results });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
