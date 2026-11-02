/**
 * Issue #1128 §B — the seven built-in agency project blueprints, as data.
 *
 * `workspace-shared.ts`'s generic catalogue (`construction`, `marketing`,
 * `event`, …) is what every trade sees, and `workspace-aec-templates.ts` added
 * the first industry-scoped set. This is the second: the phase sequences an
 * advertising agency actually runs — brand identity, a website or landing page,
 * a monthly social retainer, a search/social ad campaign, an outdoor & print
 * campaign, a video production and a PR/event — scoped to `advertising_agency`
 * so a café is never offered «کمپین محیطی و چاپ» and an agency is never handed a
 * phase list written for a building.
 *
 * The properties that made the AEC set safe are the ones kept here, because they
 * are what make a *catalogue* rather than a constraint:
 *
 *   * **Code, not seeded rows.** Every agency tenant has all seven on its first
 *     request; an improvement reaches every business at once and there is no
 *     per-tenant copy to drift. A business that wants its own blueprint writes a
 *     row in `workspace_project_templates`, which overrides a built-in key.
 *   * **A starting point, never a constraint.** Applying one writes phases and
 *     starter tasks into the project; from then on they are ordinary rows the
 *     project edits, reorders or deletes. Nothing here is re-read afterwards, so
 *     the catalogue cannot fight a tenant's edits.
 *   * **`recommendedProfiles` orders and labels; it never gates.** A branding
 *     studio that lands a media buy still gets «کمپین تبلیغاتی جستجو و اجتماعی»
 *     in the list — it is simply not the one carrying the «پیشنهادی» badge for
 *     that operating profile (`agency.ts`).
 *
 * The spine of §B's stage list runs through all seven — brief → discovery →
 * proposal/quote → contract → kickoff → concept → production → internal review →
 * client approval → publication → performance reporting → handover/renewal —
 * renamed and re-cut per template, because a retainer has no "contract" phase
 * every month and a shoot has a production day the others do not. What every one
 * of them keeps is the pair the issue treats as the agency's control points: an
 * **internal review** before the client ever sees the work, and an explicit
 * **client approval** before publication. Neither is an authorization mechanism
 * — approvals and permissions stay where Workspace already keeps them
 * (`workspace.ts`) — they are the two phases an agency's own process is judged
 * by, so a blueprint that omitted them would be the wrong shape on day one.
 */

import type { WorkspaceTemplate } from "./workspace-shared";

export const AGENCY_BUILTIN_TEMPLATES: WorkspaceTemplate[] = [
  {
    key: "agency_brand_identity",
    name: "هویت برند",
    description: "از بریف و استراتژی برند تا سیستم بصری، کتابچهٔ برند و تحویل فایل‌ها",
    projectType: "branding",
    industry: "advertising_agency",
    recommendedProfiles: ["branding_studio", "full_service", "small_agency"],
    phases: [
      { name: "بریف و شناخت برند" },
      { name: "تحقیق بازار و رقبا" },
      { name: "پیشنهاد و پیش‌فاکتور" },
      { name: "قرارداد" },
      { name: "استراتژی برند (موقعیت‌یابی و شخصیت)" },
      { name: "مفهوم هویت بصری" },
      { name: "طراحی لوگو و سیستم بصری" },
      { name: "طراحی کاربردها (ست اداری، بسته‌بندی، تابلو)" },
      { name: "بازبینی داخلی" },
      { name: "ارائه و تأیید کارفرما" },
      { name: "تدوین کتابچهٔ برند" },
      { name: "تحویل فایل‌ها، آموزش و تمدید" },
    ],
    defaultTasks: [
      "جلسهٔ شناخت با کارفرما و دریافت بریف",
      "جمع‌آوری نمونه‌های رقبا و مرجع‌های بصری",
      "تعیین تعداد مسیرهای مفهومی و دورهای بازبینی",
    ],
  },
  {
    key: "agency_website_landing",
    name: "وب‌سایت و صفحهٔ فرود",
    description: "معماری اطلاعات، طراحی رابط، توسعه، انتشار و بهینه‌سازی تا تحویل",
    projectType: "website",
    industry: "advertising_agency",
    recommendedProfiles: ["digital_social", "full_service", "branding_studio", "small_agency"],
    phases: [
      { name: "بریف و اهداف" },
      { name: "شناخت مخاطب و رقبا" },
      { name: "پیشنهاد، قرارداد و زمان‌بندی" },
      { name: "معماری اطلاعات و وایرفریم" },
      { name: "طراحی رابط (UI)" },
      { name: "تولید و آماده‌سازی محتوا" },
      { name: "توسعه و پیاده‌سازی" },
      { name: "تست و کنترل کیفیت" },
      { name: "بازبینی داخلی" },
      { name: "تأیید کارفرما" },
      { name: "انتشار و اتصال دامنه" },
      { name: "بهینه‌سازی سرعت و سئوی پایه" },
      { name: "تحویل، آموزش و پشتیبانی" },
    ],
    defaultTasks: [
      "فهرست صفحه‌ها و مسیر کاربر",
      "دریافت محتوا و دارایی‌های موجود از کارفرما",
      "تعیین معیار پذیرش (سرعت، دسترس‌پذیری، فرم‌ها)",
    ],
  },
  {
    key: "agency_social_retainer",
    name: "ریتینر ماهانهٔ شبکه‌های اجتماعی",
    description: "تقویم محتوای ماهانه، تولید، انتشار، پاسخ‌گویی و گزارش عملکرد",
    projectType: "retainer",
    industry: "advertising_agency",
    recommendedProfiles: ["digital_social", "content_video", "small_agency", "full_service"],
    phases: [
      { name: "بریف و اهداف ماه" },
      { name: "برنامهٔ محتوایی و کانال‌ها" },
      { name: "تأیید تقویم توسط کارفرما" },
      { name: "تولید محتوا (کپی و کریتیو)" },
      { name: "بازبینی داخلی" },
      { name: "زمان‌بندی و انتشار" },
      { name: "پاسخ‌گویی و مدیریت کامنت" },
      { name: "گزارش ماهانهٔ عملکرد" },
      { name: "جلسهٔ بازبینی و تمدید" },
    ],
    defaultTasks: [
      "تعیین تعداد پست و کانال در ماه",
      "دریافت دسترسی‌های انتشار از کارفرما",
      "تعیین روز گزارش ماهانه",
    ],
  },
  {
    key: "agency_ad_campaign",
    name: "کمپین تبلیغاتی جستجو و اجتماعی",
    description: "ساختار کمپین، کریتیو، خرید رسانه، بهینه‌سازی روزانه و گزارش بازگشت سرمایه",
    projectType: "ad_campaign",
    industry: "advertising_agency",
    recommendedProfiles: ["media_buying", "digital_social", "full_service"],
    phases: [
      { name: "بریف و اهداف کمپین" },
      { name: "تحقیق کلمات کلیدی و مخاطب" },
      { name: "پیشنهاد بودجه و قرارداد" },
      { name: "ساختار کمپین و گروه‌های تبلیغاتی" },
      { name: "تولید کریتیو و کپی" },
      { name: "بازبینی داخلی" },
      { name: "تأیید کارفرما" },
      { name: "راه‌اندازی و خرید رسانه" },
      { name: "پایش و بهینه‌سازی روزانه" },
      { name: "گزارش هزینه، سرنخ و بازگشت سرمایه" },
      { name: "تمدید یا پایان دوره" },
    ],
    defaultTasks: [
      "تعیین بودجهٔ رسانه و کارمزد مدیریت",
      "مشخص کردن رویداد تبدیل و منبع دادهٔ آن",
      "تعیین سقف هزینهٔ روزانه و دورهٔ کمپین",
    ],
  },
  {
    key: "agency_outdoor_print",
    name: "کمپین محیطی، چاپ و تولید",
    description: "مجوزها و مکان‌ها، طراحی ابعادی، تأمین متریال، تولید، نصب و تسویهٔ پیمانکاران",
    projectType: "outdoor_print",
    industry: "advertising_agency",
    recommendedProfiles: ["outdoor_print", "full_service", "media_buying"],
    phases: [
      { name: "بریف، مکان‌ها و ابعاد" },
      { name: "امکان‌سنجی و مجوزها" },
      { name: "پیش‌فاکتور و قرارداد" },
      { name: "طراحی و اقتباس ابعادی" },
      { name: "بازبینی داخلی" },
      { name: "تأیید کارفرما و نمونهٔ چاپ" },
      { name: "تأمین متریال و تولید" },
      { name: "کنترل کیفیت چاپ و ساخت" },
      { name: "نصب و اجرا" },
      { name: "بازدید میدانی و گزارش" },
      { name: "تسویهٔ پیمانکاران و بایگانی فایل‌ها" },
    ],
    defaultTasks: [
      "فهرست مکان‌ها، ابعاد و متریال هر مورد",
      "استعلام قیمت از چاپخانه یا پیمانکار تولید",
      "بررسی وضعیت مجوز اکران یا نصب",
    ],
  },
  {
    key: "agency_video_production",
    name: "تولید محتوا و ویدیو",
    description: "سناریو و استوری‌برد، هماهنگی تولید، فیلمبرداری، تدوین و خروجی برای هر کانال",
    projectType: "video_production",
    industry: "advertising_agency",
    recommendedProfiles: ["content_video", "full_service", "branding_studio"],
    phases: [
      { name: "بریف و سناریو" },
      { name: "تحقیق و مرجع‌های بصری" },
      { name: "پیشنهاد، قرارداد و برنامهٔ تولید" },
      { name: "فیلمنامه و استوری‌برد" },
      { name: "هماهنگی تولید (لوکیشن، بازیگر، تجهیزات)" },
      { name: "تأیید کارفرما" },
      { name: "فیلمبرداری" },
      { name: "تدوین اولیه" },
      { name: "بازبینی داخلی" },
      { name: "اصلاحات و تأیید نهایی کارفرما" },
      { name: "خروجی نهایی و فرمت‌های کانال" },
      { name: "انتشار، تحویل فایل‌ها و آرشیو" },
    ],
    defaultTasks: [
      "تعیین تعداد خروجی و نسبت تصویر هر کانال",
      "رزور لوکیشن و عوامل تولید",
      "تعیین تعداد دورهای بازبینی کارفرما",
    ],
  },
  {
    key: "agency_pr_event",
    name: "روابط عمومی، رویداد و اجرا",
    description: "برنامهٔ ارتباطی، هماهنگی اجرایی و تأمین‌کنندگان، اجرا، پوشش رسانه‌ای و گزارش",
    projectType: "pr_event",
    industry: "advertising_agency",
    recommendedProfiles: ["pr_events", "full_service", "small_agency"],
    phases: [
      { name: "بریف و اهداف ارتباطی" },
      { name: "شناسایی رسانه‌ها و ذی‌نفعان" },
      { name: "پیشنهاد، قرارداد و بودجه" },
      { name: "برنامهٔ ارتباطی و پیام‌ها" },
      { name: "هماهنگی اجرایی (مکان، تأمین‌کنندگان، مجوزها)" },
      { name: "تولید اقلام و محتوای رسانه‌ای" },
      { name: "بازبینی داخلی" },
      { name: "تأیید کارفرما" },
      { name: "اجرای رویداد یا انتشار بیانیه" },
      { name: "پوشش رسانه‌ای و پایش" },
      { name: "گزارش نتایج و تسویه" },
    ],
    defaultTasks: [
      "فهرست رسانه‌ها و خبرنگاران هدف",
      "تهیهٔ جدول زمان‌بندی روز اجرا",
      "استعلام تأمین‌کنندگان و تعیین مسئول هر بخش",
    ],
  },
];

/** The keys `workspace-shared.test.ts` and the template UI may rely on. */
export const AGENCY_BUILTIN_TEMPLATE_KEYS: readonly string[] = AGENCY_BUILTIN_TEMPLATES.map((t) => t.key);

/**
 * Pure: every operating profile the seven blueprints name, de-duplicated.
 * `agency.test.ts` checks each one against `AGENCY_OPERATING_PROFILES`, so a
 * renamed preset fails the suite instead of silently dropping a «پیشنهادی»
 * badge from the picker an agency sees.
 */
export function agencyTemplateRecommendedProfiles(): string[] {
  return [...new Set(AGENCY_BUILTIN_TEMPLATES.flatMap((t) => [...(t.recommendedProfiles ?? [])]))];
}
