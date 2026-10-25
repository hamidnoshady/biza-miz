"use client";

/**
 * «مدیریت وب‌سایت» → «تنظیمات وب‌سایت» — the app's *own* settings.
 *
 * The app has two managers, and each already owns the settings of the system
 * it manages — the Eshobe site's sync rules are at `/websites/cms/settings`,
 * and a WordPress store's credentials belong to the technical connections hub.
 * What was missing was the app's own level: which of the two is this
 * business's site, and where the settings that are *not* the app's actually
 * live. Naming those destinations is the whole job here, because the failure
 * this change exists to fix was a settings link that silently landed on
 * somebody else's page.
 */

import { GlobeIcon, RefreshCwIcon } from "lucide-react";
import {
  AppSettingsPanel,
  type AppSettingsGroup,
} from "@/components/app-settings/app-settings-panel";
import { PLATFORM_SETTINGS_HOME } from "@/lib/app-routes";
import { cmsSectionHref } from "./website-routes";
import { AppSettingsShortcut } from "@/components/app-settings/app-settings-shortcut";

export function WebsiteSettingsSection() {
  const groups: AppSettingsGroup[] = [
    {
      key: "cms-sync",
      label: "همگام‌سازی سایت‌ساز بیزامیز",
      description: "اینکه چه چیزی از صندوق به سایت فرستاده شود — قیمت و موجودی، یک‌طرفه.",
      icon: RefreshCwIcon,
      body: (
        <AppSettingsShortcut
          href={cmsSectionHref("settings")}
          label="باز کردن تنظیمات همگام‌سازی"
          description="این تنظیم متعلق به مدیریت سایت‌ساز بیزامیز است و صفحهٔ خودش را دارد."
        />
      ),
    },
    {
      key: "primary",
      label: "سایت اصلی کسب‌وکار",
      description: "اینکه نشانی سایت در رسید و پیام‌ها از کدام مدیر برداشته شود.",
      icon: GlobeIcon,
      comingSoon:
        "انتخاب سایت اصلی به‌زودی اضافه می‌شود؛ فعلاً اگر سایت‌ساز بیزامیز متصل باشد نشانی آن استفاده می‌شود.",
    },
  ];

  return (
    <AppSettingsPanel
      groups={groups}
      platformNote="اتصال سایت و کلیدهای آن، یک اتصال فنی است و در بخش «اتصال‌های فنی» پلتفرم نگهداری می‌شود — نه در این برنامه."
      platformLinks={[
        {
          label: "اتصال‌های فنی (پلتفرم)",
          description: "اتصال وردپرس و ووکامرس، سایت‌ساز بیزامیز و کلیدهای دسترسی.",
          href: "/settings/connections",
        },
        {
          label: "تنظیمات پلتفرم",
          description: "تنظیمات کسب‌وکار، تیم و امنیت.",
          href: PLATFORM_SETTINGS_HOME,
        },
      ]}
    />
  );
}
