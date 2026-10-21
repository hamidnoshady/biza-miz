/**
 * The frame every page of the WordPress & WooCommerce manager wears.
 *
 * The app's two managers each own their own header — «سایت‌ساز اشوبه» and
 * «وردپرس و ووکامرس» are two different systems, and one shared header over
 * both would leave a member unsure which site they are looking at. The
 * sidebar (`../website-app-nav.tsx`) is what the two share.
 */
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { WpStoreProvider } from "./wp-store-context";
import type { WpSectionCaps } from "./wp-routes";

export function WpManagerShell({ children, caps }: { children: React.ReactNode; caps: WpSectionCaps }) {
  return (
    <PageShell className="space-y-4 sm:space-y-5">
      <PageHeader
        title="وردپرس و ووکامرس"
        description="مدیریت کامل فروشگاه آنلاین وردپرسی: محصولات، سفارش‌ها، مشتریان، دسته‌بندی‌ها، محتوا و رسانه‌های سایت — به‌همراه وضعیت اتصال و صف همگام‌سازی."
        actions={
          <>
            <KnowledgeHelpButton section="connections" />
            <AskAssistant
              app="website"
              context="وضعیت فروشگاه وردپرسی را بررسی کن: اتصال وردپرس/ووکامرس، آخرین همگام‌سازی محصولات، سفارش‌ها و مشتریان، رویدادهای ناموفق در صف، و تعداد نوشته‌ها و رسانه‌های همگام‌شده."
            />
          </>
        }
      />
      <WpStoreProvider caps={caps}>
        <div className="min-w-0">{children}</div>
      </WpStoreProvider>
    </PageShell>
  );
}
