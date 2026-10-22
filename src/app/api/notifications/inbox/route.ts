import { isUuid } from "@/lib/uuid";
import { objectBody } from "@/lib/notification-api";
import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { listNotificationInbox, markNotificationsRead } from "@/lib/notifications-service";

/** The bell: what this member was told, newest first, plus the unread count. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const inbox = await listNotificationInbox(
    guard.session.businessId,
    guard.session.sub,
    Number.isFinite(limit) ? limit : 50,
  );
  return NextResponse.json(
    {
      ...inbox,
      retentionDays: Math.min(
        3650,
        Math.max(30, Number(process.env.NOTIFICATION_RETENTION_DAYS) || 90),
      ),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

/** Marks one entry read, or every unread one when no id is given. */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  let body: { id?: string } = {};
  try {
    const parsed: unknown = await request.json();
    if (!objectBody(parsed) || (parsed.id !== undefined && !isUuid(parsed.id)))
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    body = parsed;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const updated = await markNotificationsRead(guard.session.businessId, guard.session.sub, body.id);
  return NextResponse.json({ updated });
});
