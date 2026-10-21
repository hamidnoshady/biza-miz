import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { deliveryPreference } from "@/lib/notifications-service";
import { objectBody } from "@/lib/notification-api";

export const GET = withTenantScope(async () => {
  const guard = await requireMember();
  if (guard.error) return guard.error;
  return NextResponse.json(await deliveryPreference(guard.session.businessId, guard.session.sub));
});
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (
    !objectBody(body) ||
    !["immediate", "digest", "inapp"].includes(String(body.mode)) ||
    !Number.isInteger(body.digest_minutes) ||
    Number(body.digest_minutes) < 1 ||
    Number(body.digest_minutes) > 60 ||
    (body.timezone !== null && typeof body.timezone !== "string")
  )
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    if (body.timezone) new Intl.DateTimeFormat("en", { timeZone: String(body.timezone) }).format();
  } catch {
    return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
  }
  await query(
    `INSERT INTO notification_preferences(business_id,user_id,mode,timezone,digest_minutes) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT(business_id,user_id) DO UPDATE SET mode=EXCLUDED.mode,timezone=EXCLUDED.timezone,digest_minutes=EXCLUDED.digest_minutes`,
    [
      guard.session.businessId,
      guard.session.sub,
      body.mode,
      body.timezone || null,
      body.digest_minutes,
    ],
  );
  return NextResponse.json(await deliveryPreference(guard.session.businessId, guard.session.sub));
});
