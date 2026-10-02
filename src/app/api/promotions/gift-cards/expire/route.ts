import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { businessToday } from "@/lib/business-day-service";
import { expireGiftCards, listExpiredGiftCards } from "@/lib/promotions-service";

/**
 * Issue #764 — expired gift cards that still hold an unspent balance: what
 * «ثبت انقضا» would move from 2420 to «سایر درآمدها».
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.giftCardsView);
  if (error) return error;
  const today = await businessToday(session.businessId);
  const cards = await listExpiredGiftCards(session.businessId, today);
  return NextResponse.json({
    cards,
    totalRial: cards.reduce((sum, card) => sum + card.balanceRial, 0),
  });
});

/** Posts the write-off (Dr 2420 / Cr 4900), once per card; a re-run posts nothing. */
export const POST = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.giftCardsIssue);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await expireGiftCards(client, {
      businessId: session.businessId,
      locationId: location.id,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: "gift_card_expire_failed", message: (err as Error).message }, { status: 400 });
  } finally {
    client.release();
  }
});
