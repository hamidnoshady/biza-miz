"use client";

/**
 * The CRM app shell (Phase 36).
 *
 * Wraps every `/crm` route with the app's own header. The side menu
 * is *not* here: `src/lib/app-shells.ts` hands the dashboard's sidebar slot to
 * `crm/crm-app-nav.tsx` for these routes, so the app's menu sits at the level
 * the business's own pages sit at rather than as a sub-menu drawn inside a
 * page. That split is the whole difference between an app and a folder, and it
 * is the same arrangement the Growth app uses.
 */

import { usePathname } from "next/navigation";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { CRM_SETTINGS_HREF } from "./crm-routes";
import { CrmCommandField } from "./crm-command-field";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";

/** The app's settings page announces itself; every other section keeps the app's heading. */
const APP_HEADING = {
  title: "ارتباط با مشتری",
  description:
    "امروز چه کسی به توجه نیاز دارد، با این مشتری چه گذشته، قدم بعدی چیست، و کدام فرصت‌ها حرکت می‌کنند یا متوقف مانده‌اند.",
};

const SETTINGS_HEADING = {
  title: "تنظیمات ارتباط با مشتری",
  description:
    "تنظیمات مخصوص همین برنامه — قیف‌ها و مراحل، فیلدهای کسب‌وکار، تشخیص تکراری‌ها و رضایت ارتباط. تنظیمات کسب‌وکار و پلتفرم جای دیگری است.",
};

export function CrmAppShell({
  children,
  permissions,
}: {
  children: React.ReactNode;
  /**
   * The member's effective permission keys, threaded from the layout.
   *
   * The command field is drawn from these: a destination the member may not
   * open is not offered, in the field exactly as in the menu. Strings rather
   * than a `Set`, because this crosses the server/client boundary as a prop.
   */
  permissions?: readonly string[];
}) {
  const pathname = usePathname();
  const heading = pathname === CRM_SETTINGS_HREF ? SETTINGS_HEADING : APP_HEADING;

  return (
    <PageShell className="space-y-4 sm:space-y-5">
      <PageHeader
        title={heading.title}
        description={heading.description}
        actions={
          <>
            {/* No `section`: this header serves every CRM sub-page, so the
                button resolves the current route itself. */}
            <KnowledgeHelpButton />
            <AskAssistant
              app="crm"
              context="وضعیت مشتریان را بررسی کن: مشتریان تازه، مشتریان در معرض ریزش، بخش‌های تعریف‌شده و تعداد قابل‌ارسال هرکدام، کارهای عقب‌افتاده و تیکت‌های باز."
            />
          </>
        }
      />
      {/* The command field belongs to the app, not to a screen: «چه چیزی عقب
          افتاده؟» is a question you arrive with, not a question one page asks.
          It is the same field on every CRM screen, which is also why it can
          carry the ⌘K shortcut without any screen having to know about it. */}
      <CrmCommandField permissions={permissions} />
      <div className="min-w-0">{children}</div>
    </PageShell>
  );
}
