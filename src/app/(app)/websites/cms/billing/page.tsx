import { CmsManagerShell } from "../cms-manager-shell";
import { CmsBillingSection } from "./billing-section";

/** سایت‌ساز بیزامیز — اشتراک و صورت‌حساب سایت. */
export default function CmsBillingPage() {
  return (
    <CmsManagerShell
      title="اشتراک و صورت‌حساب"
      description="هزینهٔ سایت، دامنه و تمدید — همه از اعتبار پلتفرم. سایت‌ساز فقط کار سایت را انجام می‌دهد؛ پرداخت این‌جاست."
      assistantContext="صورت‌حساب سایت را بررسی کن: طرح اشتراک، پایان دورهٔ جاری، هزینه‌های ثبت‌شده و موجودی اعتبار."
    >
      <CmsBillingSection />
    </CmsManagerShell>
  );
}
