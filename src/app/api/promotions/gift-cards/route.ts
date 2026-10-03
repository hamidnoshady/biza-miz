import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getGiftCardByCode, giftCardBalance, giftCardHistory, issueGiftCard } from "@/lib/promotions-service";
import { getGrowthSettings } from "@/lib/growth-settings-service";
import { businessToday } from "@/lib/business-day-service";
import { isGiftCardExpired } from "@/lib/gift-card-expiry";

/** One card's outstanding value by code, with its issue/redeem history. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.giftCardsView);
  if (error) return error;
  const code = (request.nextUrl.searchParams.get("code") ?? "").trim();
  if (!code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  // Distinguish an unknown code from a genuine zero balance: both would
  // otherwise return 0, and the screen would show «۰» as if the card existed.
  const card = await getGiftCardByCode(session.businessId, code);
  if (!card) return NextResponse.json({ error: "gift_card_not_found" }, { status: 404 });

  const [balance, history, today] = await Promise.all([
    giftCardBalance(session.businessId, code),
    giftCardHistory(session.businessId, code),
    card.expiresAt ? businessToday(session.businessId) : Promise.resolve(null),
  ]);
  return NextResponse.json({
    found: true,
    balance,
    isActive: card.isActive,
    expiresAt: card.expiresAt,
    expired: today !== null && isGiftCardExpired(card.expiresAt, today),
    history,
  });
});

/** Issues a gift card, posting its value as a liability (2420). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.giftCardsIssue);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { code?: string; initialValue?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.code?.trim() || !Number.isFinite(body.initialValue) || (body.initialValue as number) <= 0) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  // Opt-in expiry: a business that never set a validity issues cards that never expire.
  const { giftCardValidityMonths } = await getGrowthSettings(session.businessId);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await issueGiftCard(client, {
      validityMonths: giftCardValidityMonths,
      businessId: session.businessId,
      locationId: location.id,
      code: body.code,
      initialValue: Number(body.initialValue),
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, card: result.card });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: "gift_card_failed", message: (err as Error).message }, { status: 400 });
  } finally {
    client.release();
  }
});
