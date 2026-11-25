/**
 * The first-run wizard's inline knowledge help (issue #1239 / ESH-90).
 *
 * The epic asks for contextual guidance *inside* each step: "show 2–5 concise
 * lines and expandable examples from the existing published Knowledge Base;
 * always render inside the same wizard step, not send to /knowledge … fallback
 * to local help offline."
 *
 * So there are two layers, and both live in this one pure module:
 *
 *  1. **The published layer.** `pageKey` is the knowledge page the step lives
 *     on, and `marker` is the bold heading inside the published
 *     «راه‌اندازی اولیه» article that describes this step. The server extracts
 *     that paragraph from the *published* article (see
 *     `src/lib/kb-step-excerpt.ts`), so the wizard's guidance is edited in the
 *     Knowledge Centre, not in a deploy.
 *  2. **The offline layer.** `lines` is a short, local fallback shown whenever
 *     the published extract is missing, the request fails, or the install is
 *     offline. It is deliberately not a copy of the whole article — two or
 *     three sentences that answer "what is this field for", so a wizard step
 *     never opens with no explanation at all.
 *
 * Framework-free and client-safe, because `StepShell` (a client component) and
 * the `/api/knowledge` route both read it.
 */
import type { WizardStep } from "./wizard-steps";

export interface SetupInlineHelp {
  /** `page:/setup/...` — the catalogue key the editor assigns articles to. */
  pageKey: string;
  /** The bold heading in the published article that describes this step. */
  marker: string;
  /** Local, offline-safe 2–5 lines. Never the only copy of anything financial. */
  lines: readonly string[];
}

export const SETUP_STEP_HELP: Record<WizardStep, SetupInlineHelp> = {
  business: {
    pageKey: "page:/setup/business",
    marker: "اطلاعات کسب‌وکار",
    lines: [
      "نام کسب‌وکار روی اسناد و رسیدها چاپ می‌شود؛ نام شعبهٔ اول را هم همین‌جا ثبت کنید.",
      "نوع کسب‌وکار پس از ثبت تغییر نمی‌کند و برچسب‌ها و مراحل بعدی را تعیین می‌کند.",
      "لوگو اختیاری است: می‌توانید بعداً از تنظیمات کسب‌وکار اضافه‌اش کنید.",
    ],
  },
  aec_profile: {
    pageKey: "page:/setup/aec-profile",
    marker: "پروفایل کسب‌وکار",
    lines: [
      "این مرحله فقط برای کسب‌وکارهای معماری، مهندسی و ساخت‌وساز است.",
      "اگر ردش کنید، پروفایل پیش‌فرض حفظ می‌شود و بعداً از تنظیمات قابل تغییر است.",
    ],
  },
  apps: {
    pageKey: "page:/setup/apps",
    marker: "انتخاب برنامه‌های کسب‌وکار",
    lines: [
      "قیمت‌ها از تعرفهٔ منتشرشدهٔ مدیر سامانه خوانده می‌شوند، نه از این صفحه.",
      "انتخاب برنامه هیچ مبلغی از کیف پول کم نمی‌کند و برنامه را فعال نمی‌کند.",
      "می‌توانید هیچ برنامه‌ای انتخاب نکنید و بعداً از داشبورد اضافه کنید.",
    ],
  },
  app_setup: {
    pageKey: "page:/setup/app-setup",
    marker: "راه‌اندازی برنامه‌های انتخاب‌شده",
    lines: [
      "فقط برنامه‌هایی که انتخاب کرده‌اید پرسش دارند؛ پاسخ‌ها خودکار ذخیره می‌شوند.",
      "این پاسخ‌ها جدا از راه‌اندازی کسب‌وکار نگه داشته می‌شوند و فعال‌سازی نیستند.",
    ],
  },
  import: {
    pageKey: "page:/setup/import",
    marker: "ورود اطلاعات اولیه",
    lines: [
      "این مرحله اختیاری است و هیچ‌وقت مانع پایان راه‌اندازی نمی‌شود.",
      "ابتدا نگاشت و پیش‌نمایشِ بدون نوشتن نشان داده می‌شود؛ فقط با تأیید شما داده ثبت می‌شود.",
      "رکوردهای تکراری بی‌صدا ادغام نمی‌شوند و سند مالی گذشته خودکار ثبت نمی‌شود.",
    ],
  },
  accounts: {
    pageKey: "page:/setup/accounts",
    marker: "سرفصل حساب‌ها",
    lines: [
      "سرفصل پیشنهادی صنف را بررسی و ذخیره کنید؛ حساب‌های موجود بازنویسی نمی‌شوند.",
      "اگر حسابداری را انتخاب نکرده باشید این مرحله نمایش داده نمی‌شود.",
    ],
  },
  costing: {
    pageKey: "page:/setup/costing",
    marker: "روش قیمت‌گذاری موجودی",
    lines: [
      "روش بهای تمام‌شده را یک‌بار انتخاب کنید؛ پس از ثبت گردش موجودی قفل می‌شود.",
      "این مرحله فقط برای کافه و رستوران است.",
    ],
  },
  tax: {
    pageKey: "page:/setup/tax",
    marker: "تنظیم مالیات",
    lines: [
      "نرخ پیش‌فرض را وارد کنید؛ اگر مشمول مالیات نیستید صفر را ذخیره کنید.",
      "نرخ هر دستهٔ منو را بعداً جداگانه تنظیم می‌کنید.",
    ],
  },
  users: {
    pageKey: "page:/setup/users",
    marker: "نقش‌ها و کاربران",
    lines: [
      "کاربران را اینجا بسازید یا بعداً از «تیم و دسترسی‌ها» اضافه کنید.",
      "این مرحله اختیاری است و مانع پایان راه‌اندازی نمی‌شود.",
    ],
  },
  menu: {
    pageKey: "page:/setup/menu",
    marker: "ورود منو",
    lines: [
      "دسته‌ها و اقلام قابل فروش را بسازید یا فایل منو را وارد کنید.",
      "برای فروش در صندوق دست‌کم یک قلم فعال لازم است؛ بعداً هم قابل ویرایش است.",
    ],
  },
  hardware: {
    pageKey: "page:/setup/hardware",
    marker: "اتصال سخت‌افزار",
    lines: [
      "چاپگر و کشوی پول را متصل یا آزمایش کنید؛ این مرحله اختیاری است.",
      "بعداً از «چاپگر و سخت‌افزار» در تنظیمات هم قابل انجام است.",
    ],
  },
  backup: {
    pageKey: "page:/setup/backup",
    marker: "مقصد پشتیبان‌گیری",
    lines: [
      "فقط در نصب محلی نمایش داده می‌شود و اختیاری است.",
      "مقصد پشتیبان را بعداً هم می‌توانید از تنظیمات پشتیبان تغییر دهید.",
    ],
  },
  opening: {
    pageKey: "page:/setup/opening",
    marker: "مانده‌های افتتاحیه",
    lines: [
      "اگر از قبل موجودی یا ماندهٔ حساب دارید، آن را با دقت ثبت کنید.",
      "این مرحله اختیاری است و پایان راه‌اندازی به آن وابسته نیست.",
    ],
  },
};

export function setupStepHelp(step: WizardStep): SetupInlineHelp {
  return SETUP_STEP_HELP[step];
}

/** The page key for a wizard step, or null for a step the catalogue does not know. */
export function setupStepPageKey(step: string): string | null {
  return step in SETUP_STEP_HELP
    ? SETUP_STEP_HELP[step as WizardStep].pageKey
    : null;
}
