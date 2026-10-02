/**
 * Issue #799 §4 — the six built-in AEC project templates, as data.
 *
 * The workspace's template catalogue lives in `workspace-shared.ts` and is
 * deliberately generic (`construction`, `architecture`, `software`, …) because
 * it must fit every trade. §4 asks for a second, *industry-specific* set: the
 * phase sequences an architecture office, a structural engineer, a general
 * contractor, a design-build firm, a renovation contractor and a supervision
 * consultant actually run. They belong to `architecture_construction` and only
 * to it, so a café never sees «پیمانکاری عمومی» in its project dialog.
 *
 * Two properties are deliberate and load-bearing:
 *
 *   * **The catalogue is code, not seeded rows.** Every AEC tenant has all six
 *     on its first request, an improvement reaches every business at once, and
 *     there is no per-tenant copy to drift — the same reasoning as
 *     `BUILTIN_TEMPLATES`. A business that needs its own blueprint still writes
 *     a row in `workspace_project_templates`, which overrides a built-in of the
 *     same key.
 *   * **A template is a starting point, never a constraint.** Applying one
 *     writes phases and starter tasks into the project; from that moment they
 *     are ordinary rows the project edits, reorders or deletes (the issue's
 *     "templates must remain editable after project creation"). Nothing here is
 *     re-read after creation, so there is no way for the catalogue to fight a
 *     tenant's edits.
 *
 * `recommendedProfiles` is an *ordering and labelling* hint, not a gate: a
 * contractor whose next job is a fit-out still gets «داخلی و بازسازی» in the
 * list, it is simply not the one marked «پیشنهادی» for their operating profile.
 */

import type { AecOperatingProfile } from "./aec";
import type { WorkspaceTemplate } from "./workspace-shared";

export const AEC_BUILTIN_TEMPLATES: WorkspaceTemplate[] = [
  {
    key: "aec_architecture_design",
    name: "طراحی معماری",
    description: "از بریف و طراحی مفهومی تا فاز دو، مناقصه و نظارت کارگاهی",
    projectType: "architecture",
    industry: "architecture_construction",
    recommendedProfiles: ["architecture_office", "multidisciplinary", "individual", "team"],
    phases: [
      { name: "بریف و شناخت" },
      { name: "طراحی مفهومی" },
      { name: "طراحی شماتیک (فاز یک)" },
      { name: "توسعهٔ طراحی (فاز دو)" },
      { name: "تأیید مراجع" },
      { name: "مدارک اجرایی" },
      { name: "مناقصه و انتخاب پیمانکار" },
      { name: "نظارت کارگاهی" },
      { name: "تحویل" },
    ],
    defaultTasks: ["تشکیل جلسهٔ شناخت با کارفرما", "تهیهٔ برداشت وضع موجود", "تدوین جدول زمانی فازها"],
  },
  {
    key: "aec_civil_structural",
    name: "طراحی عمران و سازه",
    description: "مطالعات، تحلیل سازه، هماهنگی و صدور مدارک برای اجرا",
    projectType: "civil_engineering",
    industry: "architecture_construction",
    recommendedProfiles: ["civil_engineering", "multidisciplinary", "team"],
    phases: [
      { name: "بریف و ورودی‌ها" },
      { name: "برداشت و مطالعات اولیه" },
      { name: "طراحی مفهومی" },
      { name: "تحلیل سازه" },
      { name: "طراحی تفصیلی" },
      { name: "هماهنگی بین‌رشته‌ای" },
      { name: "بازبینی و کنترل" },
      { name: "تأیید کارفرما و مراجع" },
      { name: "صدور برای اجرا" },
      { name: "پشتیبانی کارگاه" },
      { name: "چون‌ساخت و تحویل" },
    ],
    defaultTasks: ["دریافت نقشه‌های معماری", "تعیین آیین‌نامه و معیارهای طراحی", "تهیهٔ گزارش مطالعات"],
  },
  {
    key: "aec_general_contractor",
    name: "پیمانکاری عمومی",
    description: "از مناقصه و قرارداد تا اجرا، صورت‌وضعیت، تحویل و دورهٔ تضمین",
    projectType: "construction",
    industry: "architecture_construction",
    recommendedProfiles: ["contractor", "design_build", "multidisciplinary"],
    phases: [
      { name: "مناقصه" },
      { name: "قرارداد" },
      { name: "تجهیز کارگاه" },
      { name: "تأمین و خرید" },
      { name: "اجرا" },
      { name: "کنترل کیفیت" },
      { name: "صورت‌وضعیت" },
      { name: "رفع نقص" },
      { name: "تحویل" },
      { name: "دورهٔ تضمین" },
    ],
    defaultTasks: ["تهیهٔ برآورد اجرایی", "تدوین برنامهٔ تأمین مصالح", "تعیین پیمانکاران جزء"],
  },
  {
    key: "aec_design_build",
    name: "طراحی و ساخت",
    description: "طراحی، برآورد، قرارداد و اجرا زیر یک مسئولیت",
    projectType: "design_build",
    industry: "architecture_construction",
    recommendedProfiles: ["design_build", "multidisciplinary"],
    phases: [
      { name: "فرصت و مناقصه" },
      { name: "طراحی مفهومی" },
      { name: "برآورد" },
      { name: "قرارداد" },
      { name: "طراحی تفصیلی" },
      { name: "تأمین و خرید" },
      { name: "اجرا" },
      { name: "آزمون و بازرسی" },
      { name: "تحویل" },
    ],
    defaultTasks: ["تهیهٔ برآورد اولیه", "تدوین پیشنهاد فنی و مالی", "تعیین بسته‌های اجرایی"],
  },
  {
    key: "aec_interior_renovation",
    name: "طراحی داخلی و بازسازی",
    description: "برداشت، طراحی، برآورد و اجرای بازسازی تا تحویل",
    projectType: "interior",
    industry: "architecture_construction",
    recommendedProfiles: ["architecture_office", "individual", "team", "design_build"],
    phases: [
      { name: "برداشت وضع موجود" },
      { name: "طراحی مفهومی" },
      { name: "تأیید کارفرما" },
      { name: "طراحی تفصیلی" },
      { name: "برآورد" },
      { name: "تأمین و خرید" },
      { name: "اجرا" },
      { name: "رفع نقص" },
      { name: "تحویل" },
    ],
    defaultTasks: ["عکس‌برداری و اندازه‌گیری فضا", "تدوین فهرست کارهای اجرایی", "انتخاب پیمانکار اجرا"],
  },
  {
    key: "aec_consulting_supervision",
    name: "مشاوره و نظارت",
    description: "بازبینی طراحی، نظارت بر اجرا و تأیید صورت‌وضعیت تا خاتمه",
    projectType: "supervision",
    industry: "architecture_construction",
    recommendedProfiles: ["consulting_supervision", "multidisciplinary", "civil_engineering"],
    phases: [
      { name: "قرارداد" },
      { name: "بازبینی طراحی" },
      { name: "آماده‌سازی و تجهیز" },
      { name: "نظارت بر اجرا" },
      { name: "بازرسی" },
      { name: "تأیید پیشرفت" },
      { name: "بررسی تغییرات" },
      { name: "تحویل" },
      { name: "خاتمه" },
    ],
    defaultTasks: ["تدوین برنامهٔ بازدیدها", "بررسی مدارک پیمانکار", "تعیین سرفصل‌های تأیید"],
  },
];

/** The keys `workspace-shared.test.ts` and the template UI may rely on. */
export const AEC_BUILTIN_TEMPLATE_KEYS: readonly string[] = AEC_BUILTIN_TEMPLATES.map((t) => t.key);
