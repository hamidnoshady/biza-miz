import { isUuid } from "@/lib/uuid";
import { canReceiveNotification } from "@/lib/notification-authorization";
import { notificationRuleLocations } from "@/lib/notifications-service";
import { objectBody } from "@/lib/notification-api";
import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import {
  NOTIFICATION_EVENT_LIST,
  NOTIFICATION_GROUP_LABELS,
  notificationErrorMessage,
  type NotificationRuleInput,
} from "@/lib/notifications";
import { notificationPreferences, saveNotificationRule } from "@/lib/notifications-service";

/**
 * Everything the settings screen renders in one call: the catalogue (so the
 * screen never hard-codes an event list) and the caller's effective preference
 * for each entry, whether that comes from their own rule or from the role
 * default they are currently living under.
 *
 * Resolving the default here rather than in the component is what stops the
 * screen from re-implementing `defaultRuleFor` and then drifting from it — the
 * failure mode where a checkbox shows off while the notifications keep arriving.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const locationId = request.nextUrl.searchParams.get("locationId");
  const locations = await notificationRuleLocations(guard.session.businessId, guard.session.sub);
  if (locationId && (!isUuid(locationId) || !locations.some((l) => l.id === locationId)))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const allowedKeys = new Set<string>();
  for (const meta of NOTIFICATION_EVENT_LIST)
    if (
      await canReceiveNotification(
        guard.session.businessId,
        guard.session.sub,
        { event_key: meta.key, location_id: locationId },
        true,
      )
    )
      allowedKeys.add(meta.key);
  const preferences = await notificationPreferences(
    guard.session.businessId,
    guard.session.sub,
    guard.session.role,
    locationId,
  );
  return NextResponse.json({
    groups: NOTIFICATION_GROUP_LABELS,
    locations,
    events: NOTIFICATION_EVENT_LIST.filter((meta) => allowedKeys.has(meta.key)),
    preferences: preferences.filter((p) => allowedKeys.has(p.eventKey)),
  });
});

/** Upserts the caller's rule for one event. See saveNotificationRule for why it is an upsert. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  let body: Partial<NotificationRuleInput>;
  try {
    const parsed: unknown = await request.json();
    if (!objectBody(parsed)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    body = parsed;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.locationId != null && !isUuid(body.locationId))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });

  if (
    body.enabled !== false &&
    !(await canReceiveNotification(
      guard.session.businessId,
      guard.session.sub,
      { event_key: String(body.eventKey), location_id: body.locationId ?? null },
      true,
    ))
  )
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const result = await saveNotificationRule(guard.session.businessId, guard.session.sub, body);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.errors[0],
        errors: result.errors,
        messages: result.errors.map(notificationErrorMessage),
      },
      { status: 400 },
    );
  }
  return NextResponse.json({ rule: result.rule });
});
