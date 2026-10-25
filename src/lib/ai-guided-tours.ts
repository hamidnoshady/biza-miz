/**
 * Guided AI UX is a presentation-only capability. Targets are reviewed static IDs
 * rendered by Biza Miz, not CSS selectors, routes or HTML authored by a model.
 */
import type { AuthorizedAiDestination } from "./ai-navigation-search";

export const AI_GUIDE_TARGETS = [
  "primary-navigation", "tenant-apps", "assistant-home", "assistant-composer",
  "app-accounting", "app-crm", "app-growth", "app-website",
] as const;
export type AiGuideTarget = (typeof AI_GUIDE_TARGETS)[number];
export type AiGuideStep = { target: AiGuideTarget; title: string; explanation: string };
export type AiGuidedTour = {
  id: string;
  label: string;
  /** Can only be offered if a member has a registered route for this app. */
  routePrefix: string | null;
  steps: readonly AiGuideStep[];
};

export const AI_GUIDED_TOURS: readonly AiGuidedTour[] = [
  {
    id: "assistant-basics", label: "آشنایی با دستیار", routePrefix: null,
    steps: [
      { target: "primary-navigation", title: "ناوبری کسب‌وکار", explanation: "از منوی اصلی به برنامه‌ها و بخش‌های مجاز کسب‌وکار بروید." },
      { target: "assistant-composer", title: "دستیار همیشه همراه شماست", explanation: "از همین کادر سؤال بپرسید. گفتگو هنگام جابه‌جایی بین صفحه‌ها ادامه پیدا می‌کند." },
    ],
  },
  {
    id: "app-accounting", label: "پیدا کردن حسابداری", routePrefix: "/accounting/",
    steps: [
      { target: "tenant-apps", title: "برنامه‌های کسب‌وکار", explanation: "برنامه‌های فعال و مجاز در این قسمت قرار دارند." },
      { target: "app-accounting", title: "ورود به حسابداری", explanation: "برای مشاهده امکانات حسابداری این گزینه را انتخاب کنید؛ دسترسی‌های شما در صفحه مقصد هم کنترل می‌شوند." },
    ],
  },
  {
    id: "app-crm", label: "پیدا کردن CRM", routePrefix: "/crm/",
    steps: [
      { target: "tenant-apps", title: "برنامه‌های کسب‌وکار", explanation: "از این فهرست وارد برنامه‌های فعال شوید." },
      { target: "app-crm", title: "ارتباط با مشتری", explanation: "برای دسترسی به اطلاعات و فعالیت‌های مشتریان این برنامه را باز کنید." },
    ],
  },
  {
    id: "app-growth", label: "پیدا کردن رشد و بازاریابی", routePrefix: "/growth/",
    steps: [
      { target: "tenant-apps", title: "برنامه‌های کسب‌وکار", explanation: "فهرست برنامه‌های در دسترس شماست." },
      { target: "app-growth", title: "رشد و بازاریابی", explanation: "برنامه رشد و بازاریابی از اینجا باز می‌شود." },
    ],
  },
  {
    id: "app-website", label: "پیدا کردن وب‌سایت", routePrefix: "/websites/",
    steps: [
      { target: "tenant-apps", title: "برنامه‌های کسب‌وکار", explanation: "فهرست برنامه‌هایی که اجازه استفاده از آنها را دارید." },
      { target: "app-website", title: "مدیریت وب‌سایت", explanation: "بخش وب‌سایت و اتصالات مرتبط با آن از اینجا قابل دسترسی است." },
    ],
  },
];

/** No route in the current user's allowlist => no guide for that module. */
export function resolveAuthorizedAiGuide(
  guideId: unknown, destinations: readonly AuthorizedAiDestination[],
): AiGuidedTour | null {
  if (typeof guideId !== "string" || guideId.length > 80) return null;
  const guide = AI_GUIDED_TOURS.find((candidate) => candidate.id === guideId);
  if (!guide) return null;
  if (guide.routePrefix && !destinations.some((item) => item.href.startsWith(guide.routePrefix!))) {
    return null;
  }
  return guide;
}

/** Client also rejects unknown target names, even if backend data is altered. */
export function isAiGuideTarget(target: unknown): target is AiGuideTarget {
  return typeof target === "string" && (AI_GUIDE_TARGETS as readonly string[]).includes(target);
}
