"use client";

/**
 * The danger zone, quarantined on its own page.
 *
 * On the old single-page console these two forms sat at the bottom of a long
 * scroll, next to everything else; here they are one deliberate navigation
 * away, red-carded, and capability-gated twice (this section only renders for
 * roles holding `business.reset`/`business.delete`, and the server enforces).
 *
 * The protected platform-internal business (migration 0191) shows a
 * protected-state explanation instead of destructive controls: the backend
 * refuses it at both the route and the service level, so rendering buttons
 * that can only fail would be UI dishonesty (issue #822).
 */
import { InfoBox, Card, SkeletonRows } from "../../../ui";
import { RemovePanel, ResetPanel } from "../panels";
import { useBusiness } from "../context";

export default function BusinessDangerPage() {
  const { business, loading } = useBusiness();

  if (loading || !business) return <SkeletonRows rows={3} />;

  if (business.ownershipKind === "platform_internal") {
    return (
      <div className="space-y-4">
        <Card title="کسب‌وکار محافظت‌شده">
          <p className="text-sm leading-6 text-muted-foreground">
            این کسب‌وکار، شرکت داخلیِ خود سکو است. بازنشانی و حذف دائمی برای آن تعریف نشده و از
            این مسیر امکان‌پذیر نیست؛ هیچ کنترل مخربی برای آن نمایش داده نمی‌شود. اگر فکر می‌کنید
            این وضعیت اشتباه است، با تیم فنی سکو تماس بگیرید.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <InfoBox>
        هر دو اقدام فوری است و بازگشت ندارد. «بازنشانی» فقط داده‌های عملیاتی را پاک می‌کند و سوابق
        تجاری (اشتراک، کیف پول، فاکتورها) را نگه می‌دارد؛ «حذف دائمی» همه‌چیز را از بین می‌برد.
        اگر هدف فقط بستن دسترسی است، «بایگانی» یا «تعلیق» را در نظر بگیرید — بدون اینکه داده‌ای
        پاک شود.
      </InfoBox>
      <ResetPanel />
      <RemovePanel />
    </div>
  );
}
