import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { VoucherError, renumberEntry } from "@/lib/voucher-numbering-service";
import { isUuid } from "@/lib/uuid";

/**
 * Renumber an existing voucher (issue #867: "Renumbering must be privileged
 * and auditable").
 *
 * Privilege: `ledger.approve` — the same decision permission that approves a
 * manual journal or an opening set, never the ordinary post capability.
 * Audit: the service sets the transaction flag the 0217 trigger checks,
 * updates the entry and writes `voucher_renumber_log` in one transaction — a
 * renumber either has its log row or did not happen, and a direct SQL update
 * of the voucher columns is refused by the trigger for any other writer.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;

  let body: { entryId?: string; newSequenceNo?: number; newReference?: string | null; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const entryId = body.entryId;
  if (!entryId || !isUuid(entryId)) return NextResponse.json({ error: "entry_not_found" }, { status: 404 });
  if (typeof body.newSequenceNo !== "number") {
    return NextResponse.json({ error: "invalid_sequence" }, { status: 400 });
  }

  try {
    const result = await renumberEntry({
      businessId: session.businessId,
      entryId,
      newSequenceNo: body.newSequenceNo,
      newReference: body.newReference,
      reason: body.reason ?? "",
      actorId: session.sub,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof VoucherError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
