import { CmsManagerShell } from "../cms-manager-shell";
import { CmsMediaSection } from "../cms-sections";

export default function CmsMediaPage() {
  return (
    <CmsManagerShell title="رسانه‌ها" description="تصاویر و فایل‌های سایت." assistantContext="رسانه‌های سایت را بررسی کن.">
      <CmsMediaSection />
    </CmsManagerShell>
  );
}
