import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireWpSection } from "../wp-guard";
import { WpContentSection } from "../content-section";

/** نوشته‌ها و برگه‌های وردپرس: مشاهده، ویرایش و ایجاد. */
export default async function WpContentPage() {
  const session = await requireWpSection("content");
  const access = await memberAccessFor(session);
  return <WpContentSection canManage={Boolean(access?.permissions.has(PERMISSIONS.woocommerceManage))} />;
}
