import { notificationApiAllowed } from "@/lib/notification-api";
import { objectBody } from "@/lib/notification-api";
import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { notificationErrorMessage } from "@/lib/notifications";
import {
  listNotificationDevices,
  notificationDeliveryStats,
  registerNotificationDevice,
  removeNotificationDeviceByEndpoint,
  type RegisterDeviceInput,
} from "@/lib/notifications-service";

/** The caller's own devices. Never anybody else's — see requireMember's contract. */
export const GET = withTenantScope(async () => {
  const guard = await requireMember();
  if (guard.error) return guard.error;
  return NextResponse.json({
    devices: await listNotificationDevices(guard.session.businessId, guard.session.sub),
    stats: await notificationDeliveryStats(guard.session.businessId, guard.session.sub),
  });
});

/**
 * Claims a browser push subscription for the caller.
 *
 * Called right after `pushManager.subscribe()` resolves, and again whenever the
 * browser rotates the subscription on its own — which it does without telling
 * the user — so this has to be an upsert rather than a create.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  let body: Partial<RegisterDeviceInput>;
  try {
    const parsed: unknown = await request.json();
    if (
      !objectBody(parsed) ||
      ["endpoint", "p256dh", "auth", "platform", "label"].some(
        (k) => parsed[k] !== undefined && typeof parsed[k] !== "string",
      )
    )
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    body = parsed;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!guard.session.employeeSessionId)
    return NextResponse.json({ error: "session_required" }, { status: 403 });
  if (!(await notificationApiAllowed(guard.session.businessId, guard.session.sub, "register")))
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "30" } },
    );
  const result = await registerNotificationDevice(guard.session.businessId, guard.session.sub, {
    sessionId: guard.session.employeeSessionId,
    endpoint: body.endpoint ?? "",
    p256dh: body.p256dh ?? "",
    auth: body.auth ?? "",
    platform: body.platform,
    label: body.label,
    // Taken from the request rather than from the body: a client can lie
    // about it either way, but this one is at least the browser's own claim.
    userAgent: request.headers.get("user-agent") ?? "",
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: notificationErrorMessage(result.error) },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { device: result.device, binding: `${guard.session.businessId}:${guard.session.sub}` },
    { status: 201 },
  );
});

/**
 * Forgets a subscription by its endpoint — what the browser has in hand when
 * `pushManager.getSubscription()` comes back with one the user has just
 * unsubscribed from, and therefore no device id to send.
 */
export const DELETE = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const endpoint = request.nextUrl.searchParams.get("endpoint");
  if (!endpoint) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const removed = await removeNotificationDeviceByEndpoint(
    guard.session.businessId,
    guard.session.sub,
    endpoint,
  );
  return NextResponse.json({ removed });
});
