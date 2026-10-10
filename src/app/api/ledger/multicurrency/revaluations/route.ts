import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { MulticurrencyError, runFxRevaluation } from "@/lib/multicurrency-service";

/**
 * Unrealized revaluation — optional, explicit, idempotent.
 *
 * POST restates every foreign-currency account of one currency at one rate as
 * of one date and posts the difference through 4935/5875. The posted entry is
 * a base-only adjustment (`source_type='fx_revaluation'`), the run and its
 * per-account figures are kept in `fx_revaluations`/`fx_revaluation_lines`,
 * and `idempotencyKey` (the client's, or its own retry key) returns an
 * already-run revaluation instead of posting it twice.
 *
 * GET lists the runs, newest first — what was restated, at what rate, with
 * what gain/loss, and which entry carried it.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const currency = params.get("currency");
  const limitRaw = Number(params.get("limit"));
  const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  const { rows } = await query<Record<string, unknown>>(
    `SELECT r.id::text AS id, r.currency_code, r.as_of::text AS as_of,
            r.rate::text AS rate, r.rate_id::text AS rate_id,
            r.rounding_version, r.total_gain::text AS total_gain, r.total_loss::text AS total_loss,
            r.entry_id::text AS entry_id, u.full_name AS created_by_name, r.created_at
       FROM fx_revaluations r
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.business_id = $1
        AND ($2::text IS NULL OR r.currency_code = $2::text)
      ORDER BY r.as_of DESC, r.created_at DESC
      LIMIT $3`,
    [session.businessId, currency ? currency.toUpperCase() : null, limit],
  );
  return NextResponse.json({ revaluations: rows });
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
  const input = body as Record<string, unknown>;
  if (typeof input.currencyCode !== "string") {
    return NextResponse.json({ error: "invalid_currency" }, { status: 400 });
  }
  if (typeof input.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.asOf)) {
    return NextResponse.json({ error: "invalid_as_of" }, { status: 400 });
  }
  if (
    input.idempotencyKey != null &&
    (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 128)
  ) {
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  }

  try {
    const result = await runFxRevaluation({
      businessId: session.businessId,
      currencyCode: input.currencyCode,
      asOf: input.asOf,
      rateId: typeof input.rateId === "string" ? input.rateId : null,
      actorId: session.sub,
      idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : null,
    });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
