import { CmsManagerShell } from "../cms-manager-shell";
import { WebsiteSetupWizard } from "./setup-wizard";

/** سایت‌ساز بیزامیز — ساخت سایت: دامنه، CDN، نوع سایت و ساخت. */
export default function CmsSetupPage() {
  return (
    <CmsManagerShell
      title="ساخت سایت"
      description="چهار گام تا داشتن سایت: دامنه (خرید یا اتصال)، CDN ابر آروان، نوع سایت، و ساخت روی سایت‌ساز."
      assistantContext="ساخت سایت روی سایت‌ساز پلتفرم را بررسی کن: دامنه، وضعیت CDN، نوع سایت و اینکه چه گامی مانده است."
    >
      <WebsiteSetupWizard />
    </CmsManagerShell>
  );
}
