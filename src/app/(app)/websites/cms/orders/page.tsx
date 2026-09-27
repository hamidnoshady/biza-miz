import { CmsManagerShell } from "../cms-manager-shell";
import { CmsOrdersSection } from "../cms-sections";

export default function CmsOrdersPage() {
  return (
    <CmsManagerShell title="سفارش‌ها" description="سفارش‌های آنلاین فروشگاه." assistantContext="سفارش‌های فروشگاه سایت را بررسی کن.">
      <CmsOrdersSection />
    </CmsManagerShell>
  );
}
