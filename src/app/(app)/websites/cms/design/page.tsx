import { CmsManagerShell } from "../cms-manager-shell";
import { CmsDesignSection } from "../cms-sections";

export default function CmsDesignPage() {
  return (
    <CmsManagerShell title="طراحی و پوسته" description="پوسته، استقرار و تنظیمات ظاهر." assistantContext="طراحی و پوستهٔ سایت را بررسی کن.">
      <CmsDesignSection />
    </CmsManagerShell>
  );
}
