"use client";

/** CRM's own settings. Platform-wide settings intentionally stay under `/settings`. */

import {
  CopyCheckIcon,
  HistoryIcon,
  ListPlusIcon,
  ShieldCheckIcon,
  TargetIcon,
  UsersIcon,
} from "lucide-react";
import { AppSettingsPanel, type AppSettingsGroup } from "@/components/app-settings/app-settings-panel";
import { PLATFORM_SETTINGS_HOME } from "@/lib/app-routes";
import { crmSectionHref } from "./crm-routes";
import { PipelineConfigurator } from "./pipeline-configurator";
import { BusinessFields } from "./business-fields";
import { AppSettingsShortcut } from "@/components/app-settings/app-settings-shortcut";

export function CrmSettingsSection({ canConfigure }: { canConfigure: boolean }) {
  const groups: AppSettingsGroup[] = [
    {
      key: "duplicates",
      label: "تشخیص اشخاص تکراری",
      description: "بازبینی پرونده‌های مشکوک به تکرار و ادغام دستی؛ هیچ پرونده‌ای خودکار حذف نمی‌شود.",
      icon: CopyCheckIcon,
      body: (
        <AppSettingsShortcut
          // The workspace, not the pairs screen: the setting is what the
          // detector treats as a duplicate, and the workspace is where the
          // consequences of that decision are read.
          href={crmSectionHref("quality")}
          label="باز کردن اشخاص تکراری"
          description="پیش از ادغام، سابقه، رضایت و اطلاعاتی که منتقل می‌شود را می‌بینید."
        />
      ),
    },
    {
      key: "consent",
      label: "رضایت ارتباط",
      description: "سابقهٔ اجازهٔ پیامک و ایمیل؛ منبع حقیقت ارسال در برنامهٔ رشد است.",
      icon: ShieldCheckIcon,
      body: (
        <AppSettingsShortcut
          href={crmSectionHref("consent")}
          label="باز کردن رضایت ارتباط"
          description="گزارش پوشش رضایت و دفتر ثبت تغییرات را ببینید؛ تغییر رضایت کنار پروندهٔ مشتری انجام می‌شود."
        />
      ),
    },
    {
      key: "pipeline",
      label: "قیف‌ها و مراحل فروش",
      description:
        "قیف‌ها را بسازید، نام‌گذاری کنید، پیش‌فرض تعیین کنید و مراحل هر قیف را با ترتیب، احتمال و معنی (باز/برنده/بازنده) بچینید. مرحله‌ای که معامله دارد حذف نمی‌شود.",
      icon: TargetIcon,
      body: <PipelineConfigurator canConfigure={canConfigure} />,
    },
    {
      key: "fields",
      label: "فیلدهای کسب‌وکار",
      description:
        "سؤال‌های خودتان دربارهٔ مشتری، سرنخ، فرصت و تیکت — با نوع مشخص (متن، عدد، مبلغ، تاریخ، انتخابی). نوع فیلدی که مقدار دارد تغییر نمی‌کند و حذف هم نیست: فقط بایگانی.",
      icon: ListPlusIcon,
      body: <BusinessFields canConfigure={canConfigure} />,
    },
    {
      key: "audit",
      label: "سابقهٔ تصمیم‌ها",
      description:
        "چه کسی چه تصمیمی گرفت: ادغام، تبدیل سرنخ، تغییر مرحله، تطبیق هویت و تغییر رضایت. دفتر فقط افزودنی است.",
      icon: HistoryIcon,
      body: (
        <AppSettingsShortcut
          href={crmSectionHref("audit")}
          label="باز کردن سابقهٔ تصمیم‌ها"
          description="با فیلتر تصمیم‌گیرنده، نوع پرونده و بازهٔ تاریخ."
        />
      ),
    },
    {
      key: "ownership",
      label: "مالکیت و پیگیری پرونده‌ها",
      description: "مالک معامله یا کار در همان فرم انتخاب می‌شود؛ نقش و اعضای تیم از تنظیمات پلتفرم می‌آید.",
      icon: UsersIcon,
      body: (
        <div className="grid gap-3 sm:grid-cols-2">
          <AppSettingsShortcut
            href={crmSectionHref("deals")}
            label="مدیریت مالک معامله‌ها"
            description="در فرم هر معامله، عضو مسئول را انتخاب یا تغییر دهید."
          />
          <AppSettingsShortcut
            href={crmSectionHref("activities")}
            label="مدیریت کارهای پیگیری"
            description="کارها را به عضو تیم واگذار کنید و وضعیت انجام را پیگیری کنید."
          />
        </div>
      ),
    },
  ];

  return (
    <AppSettingsPanel
      groups={groups}
      navigationLabel="دسترسی سریع تنظیمات ارتباط با مشتری"
      platformNote="اعضای تیم و دسترسی‌ها متعلق به پلتفرم است، نه برنامهٔ ارتباط با مشتری."
      platformLinks={[
        {
          label: "اعضای تیم (تنظیمات پلتفرم)",
          description: "افزودن عضو و تعیین نقش‌ها در تنظیمات پلتفرم انجام می‌شود.",
          href: "/settings/team",
        },
        {
          label: "تنظیمات پلتفرم",
          description: "تنظیمات کسب‌وکار، امنیت و اعلان‌ها.",
          href: PLATFORM_SETTINGS_HOME,
        },
      ]}
    />
  );
}
