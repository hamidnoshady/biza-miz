import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireWpSection } from "../wp-guard";
import { WpMediaSection } from "../media-section";

/** کتابخانهٔ رسانه‌های فروشگاه (تصاویر و فایل‌های پیوست). */
export default async function WpMediaPage() {
  const session = await requireWpSection("media");
  const access = await memberAccessFor(session);
  return <WpMediaSection canManage={access?.permissions.has(PERMISSIONS.woocommerceManage) ?? false} canUseCanonical={!!access?.permissions.has(PERMISSIONS.mediaView) && !!access?.permissions.has(PERMISSIONS.mediaManage)} />;
}
