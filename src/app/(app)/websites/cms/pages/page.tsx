import { CmsManagerShell } from "../cms-manager-shell";
import { CmsPagesSection } from "../cms-sections";

export default function CmsPagesPage() {
  return (
    <CmsManagerShell title="صفحه‌ها" description="برگه‌های ثابت سایت." assistantContext="صفحه‌های سایت را بررسی کن.">
      <CmsPagesSection />
    </CmsManagerShell>
  );
}
