import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { redeemGiftCard } from "@/lib/promotions-service";

/** Redeems (spends) part or all of a gift card, debiting its liability. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.giftCardsRedeem);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { code?: string; amount?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.code?.trim() || !body.amount) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await redeemGiftCard(client, {
      businessId: session.businessId,
      locationId: location.id,
      code: body.code,
      amount: Number(body.amount),
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, balance: result.balance });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: "redeem_failed", message: (err as Error).message }, { status: 400 });
  } finally {
    client.release();
  }
});
