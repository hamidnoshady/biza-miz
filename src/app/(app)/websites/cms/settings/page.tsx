import { CmsManagerShell } from "../cms-manager-shell";
import { CmsSettingsSection } from "../cms-sections";

/** سایت‌ساز بیزامیز — همگام‌سازی یک‌طرفهٔ قیمت و موجودی. خودِ اتصال سایت در «اتصال‌های فنی» است. */
export default function CmsSettingsPage() {
  return (
    <CmsManagerShell
      title="تنظیمات همگام‌سازی"
      description="اینکه چه چیزی از صندوق به سایت فرستاده شود — قیمت و موجودی، یک‌طرفه. خودِ اتصال سایت در «اتصال‌های فنی» است."
      assistantContext="تنظیمات همگام‌سازی سایت را بررسی کن: ارسال قیمت و موجودی، محصولات علامت‌خورده و صف ارسال."
    >
      <CmsSettingsSection />
    </CmsManagerShell>
  );
}
