import { isUuid } from "@/lib/uuid";
import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { notificationErrorMessage } from "@/lib/notifications";
import { deleteNotificationRule } from "@/lib/notifications-service";

/**
 * Drops one of the caller's rules, which restores the catalogue default for
 * that event — «به حالت پیش‌فرض برگردان», not «خاموش کن». Switching an event off
 * is a rule with `enabled: false`, which is a different thing and is kept.
 */
export const DELETE = withTenantScope(
  async (_request, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireMember();
    if (guard.error) return guard.error;

    const { id } = await context.params;
    if (!isUuid(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const removed = await deleteNotificationRule(guard.session.businessId, guard.session.sub, id);
    if (!removed) {
      return NextResponse.json(
        {
          error: "notification_rule_not_found",
          message: notificationErrorMessage("notification_rule_not_found"),
        },
        { status: 404 },
      );
    }
    return NextResponse.json({ removed: true });
  },
);
