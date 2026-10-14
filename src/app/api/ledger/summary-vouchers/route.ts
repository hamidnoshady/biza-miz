import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  VoucherError,
  generateSummaryVoucher,
  listSummaryVouchers,
  type SummaryVoucherScope,
} from "@/lib/voucher-numbering-service";

/**
 * «سند خلاصه» — summary vouchers over a defined source set (issue #867).
 *
 * GET lists the business's summary vouchers. POST generates one: the scope
 * must define its set completely (explicit entries, or source types with a
 * date cutoff), the set must balance as a whole, and no source may already
 * sit in another summary voucher (the double-inclusion guard). An
 * idempotency key makes a retry return the original. The underlying journal
 * detail is never touched — the voucher links its sources with snapshots.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  return NextResponse.json(await listSummaryVouchers(session.businessId));
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  let body: {
    label?: string;
    scope?: SummaryVoucherScope;
    idempotencyKey?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.scope || typeof body.scope !== "object") {
    return NextResponse.json({ error: "scope_invalid" }, { status: 400 });
  }

  try {
    const result = await generateSummaryVoucher({
      businessId: session.businessId,
      label: body.label ?? "",
      scope: body.scope,
      idempotencyKey: body.idempotencyKey,
      actorId: session.sub,
    });
    return NextResponse.json({ ok: true, ...result }, { status: result.idempotent ? 200 : 201 });
  } catch (err) {
    if (err instanceof VoucherError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
