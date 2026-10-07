import { ACCOUNTING_SECTIONS } from "./accounting-nav";
import type { AccountingSectionKey } from "./accounting-routes";

/**
 * The one-line description per section (dashboard audit F15).
 *
 * The title is the section's own menu label from `ACCOUNTING_SECTIONS`, so the
 * heading and the sidebar can never name the same page two ways; only the
 * description lives here. Most sections used to share one generic
 * «فضای کار حسابداری» heading, which left a person on «ثبت سند دستی» with a
 * page that did not say where they were. The few entries with a `title` are
 * pages whose heading deliberately differs from the shorter menu label.
 */
const ACCOUNTING_HEADINGS: Record<AccountingSectionKey, { title?: string; description: string }> = {
  dashboard: {
    title: "حسابداری",
    description:
      "میز کار حسابداری — نمای مالی کسب‌وکار، اشخاص و دسترسی به همهٔ بخش‌های کاری از منوی کناری.",
  },
  "trial-balance": { description: "ماندهٔ بدهکار و بستانکار همهٔ حساب‌ها؛ جمع دو ستون باید برابر باشد." },
  entries: { description: "همهٔ اسناد ثبت‌شده به ترتیب تاریخ، با منبع هر سند و امکان برگشت." },
  manual: { description: "ثبت سند دستی دوطرفه، با پیش‌نویس و تأیید پیش از ورود به دفتر." },
  expenses: { description: "ثبت هزینه‌های جاری کسب‌وکار و حساب پرداخت آن‌ها." },
  "fiscal-periods": { description: "سال‌ها و ماه‌های مالی، و بستن یا قفل کردن دوره‌ها." },
  directory: {
    title: "اشخاص",
    description:
      "یک فهرست برای همهٔ طرف‌حساب‌ها — مشتریان، تأمین‌کنندگان، فروشندگان و کارکنان. یک پرونده برای هر نفر، حتی وقتی چند نقش دارد.",
  },
  receivables: { description: "طلب از مشتریان، سن بدهی و دریافت‌ها." },
  payables: { description: "بدهی به تأمین‌کنندگان، سررسیدها و پرداخت‌ها." },
  receipts: { description: "ثبت دریافت از مشتری و پرداخت به تأمین‌کننده." },
  installments: { description: "فروش اقساطی، سررسید قسط‌ها و وصول آن‌ها." },
  cheques: { description: "چک‌های دریافتی و پرداختی و وضعیت هر کدام." },
  reconciliation: { description: "تطبیق گردش بانک با دفاتر و پیدا کردن اقلام باز." },
  "chart-of-accounts": { description: "ساختار حساب‌ها: گروه، کل و معین." },
  payroll: { description: "دوره‌های حقوق، تعهد حقوق کارکنان و پرداخت آن." },
  vat: { description: "مالیات بر ارزش افزودهٔ فروش و خرید در هر دوره." },
  "fixed-assets": {
    description:
      "دفتر اموال، استهلاک ماهانه، واگذاری و اسقاط دارایی‌ها، و تطبیق آن با دفتر کل.",
  },
  "financial-reports": {
    title: "گزارش‌های مالی",
    description: "گزارش‌های حسابداری و راه رسیدن به گزارش‌های کسب‌وکار.",
  },
  growth: { description: "اثر مالی باشگاه مشتریان، کمپین‌ها و پورسانت در دفاتر." },
  settings: {
    title: "تنظیمات حسابداری",
    description:
      "تنظیمات مخصوص برنامهٔ حسابداری — سرفصل حساب‌ها، دوره‌های مالی و قواعد سندزنی. تنظیمات کسب‌وکار و پلتفرم جای دیگری است.",
  },
};

/** The heading a section's page draws: its own title, never the app's generic one. */
export function accountingSectionHeading(section: AccountingSectionKey): { title: string; description: string } {
  const entry = ACCOUNTING_HEADINGS[section];
  const label = ACCOUNTING_SECTIONS.find((candidate) => candidate.key === section)?.label ?? "حسابداری";
  return { title: entry.title ?? label, description: entry.description };
}

/**
 * What «از دستیار بپرس» carries into the chat (dashboard audit F16): the
 * Accounting app and the section the person is on — a question to start from,
 * never a figure. The assistant reads the numbers itself through its tools,
 * under the member's own permissions, once the person sends.
 */
export function accountingAssistantContext(section: AccountingSectionKey): string {
  const { title } = accountingSectionHeading(section);
  return section === "dashboard"
    ? "در برنامهٔ حسابداری هستم. وضعیت مالی کسب‌وکار را برای دورهٔ جاری مرور کن و موارد نیازمند توجه را بگو."
    : `در برنامهٔ حسابداری، بخش «${title}» هستم. وضعیت همین بخش را برای دورهٔ جاری مرور کن و موارد نیازمند توجه را بگو.`;
}
