import { CmsManagerShell } from "./cms-manager-shell";
import { CmsOverviewSection } from "./cms-sections";

/** سایت‌ساز بیزامیز — میز کار: اتصال، دامنه و پیش‌نمایش زندهٔ سایت. */
export default function CmsOverviewPage() {
  return (
    <CmsManagerShell
      title="میز کار سایت"
      description="وضعیت سایت روی سایت‌ساز پلتفرم: اتصال، دامنه و DNS، و پیش‌نمایش زنده."
      assistantContext="وضعیت اتصال وب‌سایت را بررسی کن: آیا سایت متصل است، دامنه تأیید شده، و سفارش‌های فروشگاه اینترنتی."
    >
      <CmsOverviewSection />
    </CmsManagerShell>
  );
}
