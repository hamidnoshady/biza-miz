import { CmsManagerShell } from "../cms-manager-shell";
import { CmsDomainSection } from "../cms-sections";

export default function CmsDomainPage() {
  return (
    <CmsManagerShell title="دامنه و DNS" description="دامنه، رکوردها و CDN." assistantContext="دامنه و DNS سایت را بررسی کن.">
      <CmsDomainSection />
    </CmsManagerShell>
  );
}
