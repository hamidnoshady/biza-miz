"use client";

/**
 * Shared layout for an app's own settings. This deliberately keeps app
 * settings separate from the platform's `/settings` area while making the
 * distinction obvious to keyboard and screen-reader users too.
 */

import Link from "next/link";
import { ArrowUpRightIcon, ClockIcon, type LucideIcon } from "lucide-react";
import { SectionCard, cardClass } from "@/app/dashboard/page-chrome";

export interface AppSettingsGroup {
  key: string;
  label: string;
  description: string;
  icon?: LucideIcon;
  body?: React.ReactNode;
  comingSoon?: string;
}

export interface PlatformSettingsLink {
  label: string;
  description: string;
  href: string;
}

export function AppSettingsPanel({
  groups,
  platformLinks = [],
  platformNote,
  navigationLabel = "دسترسی سریع تنظیمات",
}: {
  groups: AppSettingsGroup[];
  platformLinks?: PlatformSettingsLink[];
  platformNote?: string;
  navigationLabel?: string;
}) {
  return (
    <div className="space-y-4">
      {/* A compact index prevents a long settings page becoming a scroll hunt. */}
      <nav
        aria-label={navigationLabel}
        data-tour-id="page.section-nav"
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]"
      >
        {groups.map((group) => (
          <a
            key={group.key}
            href={`#crm-setting-${group.key}`}
            className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-amber-300 dark:hover:border-amber-600 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
          >
            {group.label}
          </a>
        ))}
        {platformLinks.length > 0 ? (
          <a
            href="#crm-platform-settings"
            className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-amber-300 dark:hover:border-amber-600 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
          >
            تنظیمات پلتفرم
          </a>
        ) : null}
      </nav>

      {groups.map((group) => {
        const Icon = group.icon;
        return (
          <div key={group.key} id={`crm-setting-${group.key}`} className="scroll-mt-4">
            <SectionCard
              title={
                Icon ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon aria-hidden="true" className="size-4 shrink-0 text-amber-700 dark:text-amber-300" />
                    <span className="truncate">{group.label}</span>
                  </span>
                ) : (
                  group.label
                )
              }
              description={group.description}
            >
              {group.body ?? (
                <div className="flex items-start gap-3 rounded-xl border border-dashed border-border px-4 py-5">
                  <ClockIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <p className="text-sm leading-6 text-muted-foreground">
                    {group.comingSoon ?? "این بخش هنوز آماده نشده و به‌زودی در همین صفحه اضافه می‌شود."}
                  </p>
                </div>
              )}
            </SectionCard>
          </div>
        );
      })}

      {platformLinks.length > 0 ? (
        <div id="crm-platform-settings" className="scroll-mt-4">
          <SectionCard
            title="تنظیمات پلتفرم"
            description={
              platformNote ??
              "این موارد متعلق به تنظیمات پلتفرم است، نه این برنامه؛ با باز کردن آن‌ها از این برنامه خارج می‌شوید."
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {platformLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`${cardClass} flex min-w-0 gap-3 p-4 transition-colors hover:border-amber-300/70 hover:bg-amber-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/10 dark:focus-visible:ring-amber-400/45`}
                >
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-1 font-semibold text-foreground">
                      <span className="min-w-0 break-words">{link.label}</span>
                      <ArrowUpRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground rtl:-rotate-90" />
                      <span className="sr-only">(در تنظیمات پلتفرم باز می‌شود)</span>
                    </span>
                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">{link.description}</span>
                  </span>
                </Link>
              ))}
            </div>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
