import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listRates, MulticurrencyError, recordRate } from "@/lib/multicurrency-service";
import { parseRatePayload } from "@/lib/multicurrency";

/**
 * The business's exchange-rate book — append-only, effective-dated, audited.
 *
 * `?currency=USD&limit=100` reads one currency's history (newest first); no
 * currency reads the whole book. Every row shows who recorded it, when, what
 * it superseded, and whether it has been voided — the audit trail the manual
 * rates need.
 *
 * Recording a rate is a ledger-posting act (`ledger.post`), not a settings
 * act: the rate is what the next foreign document converts at, so the same
 * people who may post documents are the people who may set their price. Rates
 * are immutable once recorded; a mistake is voided (see …/rates/[id]/void),
 * never edited.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const currency = params.get("currency");
  const limitRaw = Number(params.get("limit"));
  try {
    const rates = await listRates(
      session.businessId,
      currency ? currency.toUpperCase() : null,
      Number.isSafeInteger(limitRaw) && limitRaw > 0 ? limitRaw : 100,
    );
    return NextResponse.json({ rates });
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseRatePayload(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.problem }, { status: 400 });

  try {
    const rate = await recordRate({
      businessId: session.businessId,
      currencyCode: parsed.value.currencyCode,
      rate: parsed.value.rate,
      effectiveFrom: parsed.value.effectiveFrom,
      actorId: session.sub,
      source: "manual",
    });
    return NextResponse.json({ rate }, { status: 201 });
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
