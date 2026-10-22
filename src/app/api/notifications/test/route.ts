import { notificationApiAllowed } from "@/lib/notification-api";
import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { notificationErrorMessage } from "@/lib/notifications";
import { sendTestNotification } from "@/lib/notifications-service";

/**
 * «یک اعلان آزمایشی بفرست» — straight to the caller's own devices, bypassing
 * both the outbox and the rules.
 *
 * The bypass is the point: this button answers "is this phone set up
 * correctly", and routing it through the rules would make a perfectly
 * configured device look broken because the person had switched that event off.
 * It reaches nobody else, so no role gate beyond being signed in applies.
 */
export const POST = withTenantScope(async () => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  if (!(await notificationApiAllowed(guard.session.businessId, guard.session.sub, "test")))
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "30" } },
    );
  const result = await sendTestNotification(guard.session.businessId, guard.session.sub);
  return NextResponse.json({
    devices: result.devices,
    sent: result.sent,
    errors: result.errors,
    message:
      result.devices === 0
        ? "هنوز هیچ دستگاهی برای دریافت اعلان ثبت نشده است."
        : result.sent > 0
          ? `اعلان آزمایشی به ${result.sent} دستگاه فرستاده شد.`
          : result.errors.includes("notification_push_unconfigured")
            ? notificationErrorMessage("notification_push_unconfigured")
            : "ارسال اعلان آزمایشی موفق نبود.",
  });
});
