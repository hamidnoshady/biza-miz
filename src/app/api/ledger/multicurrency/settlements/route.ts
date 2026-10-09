import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { MulticurrencyError, settleForeignDocument } from "@/lib/multicurrency-service";
import { parseSettlementPayload } from "@/lib/multicurrency";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Settles foreign receivables/payables — the realized-FX event.
 *
 * Foreign open items are consumed FIFO (or entry-by-entry, when the caller
 * picks them), valued at the current (or pinned) rate against their booked
 * base, and the exact difference posts through 4930 «سود تسعیر ارز» /
 * 5870 «زیان تسعیر ارز». Every consumed lot is recorded in
 * `fx_settlement_applications`, so «این فاکتور چقدر تسویه شده» stays a query.
 *
 * Idempotent by `idempotencyKey`: a retried settlement returns the one that
 * already posted, never a double settlement.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseSettlementPayload(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.problem }, { status: 400 });

  const location = await resolveActiveLocation(session);

  try {
    const settlement = await settleForeignDocument({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      direction: parsed.value.direction,
      partyId: parsed.value.partyId,
      currencyCode: parsed.value.currencyCode,
      rateId: parsed.value.rateId,
      settlementAccountId: parsed.value.settlementAccountId,
      autoAmount: parsed.value.autoAmount,
      items: parsed.value.items,
      entryDate: parsed.value.entryDate,
      memo: parsed.value.memo,
      actorId: session.sub,
      idempotencyKey: parsed.value.idempotencyKey,
    });
    return NextResponse.json(settlement, { status: settlement.duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
