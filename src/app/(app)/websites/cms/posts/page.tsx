import { CmsManagerShell } from "../cms-manager-shell";
import { CmsPostsSection } from "../cms-sections";

export default function CmsPostsPage() {
  return (
    <CmsManagerShell title="نوشته‌ها" description="مطالب وبلاگ و اخبار سایت." assistantContext="نوشته‌های سایت را بررسی کن.">
      <CmsPostsSection />
    </CmsManagerShell>
  );
}
