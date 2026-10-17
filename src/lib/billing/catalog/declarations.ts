import type { BillingDeclaration } from "./types";

/**
 * Every customer-facing capability the platform can sell, meter, include, or
 * explicitly refuse to charge. There is no undeclared free fallback.
 */
export const BILLING_DECLARATIONS: readonly BillingDeclaration[] = [
  exempt("platform.health", "سلامت سرویس", "زنده بودن سرویس؛ هیچ منبع تجاری‌ای مصرف نمی‌شود."),
  exempt("platform.auth", "ورود و نشست", "ورود، خروج و تازه‌سازی نشست منبع تجاری نیستند."),
  exempt("platform.host", "تشخیص میزبان", "تشخیص مستاجر از نام میزبان، پیش از هر نشست."),
  exempt("platform.discovery", "کشف پروتکل", "اسناد کشف OAuth و آدرس‌های شناخته‌شده."),
  exempt("platform.sync", "همگام‌سازی نصب", "جفت‌سازی دسکتاپ و همگام‌سازی بین نصب‌ها."),
  exempt("platform.internal", "زیرساخت داخلی", "مسیرهای داخلی صورت‌حساب و محدودسازی نرخ."),
  exempt("platform.console", "کنسول مدیر سامانه", "کار مدیر سامانه است؛ به مشتری صورتحساب نمی‌شود."),
  exempt("platform.exceptions", "رلهٔ خطا", "انتقال خطای عملیاتی بین نصب‌ها."),
  exempt("platform.billing_self_service", "مشاهدهٔ صورت‌حساب", "دیدن فاکتور و پرداخت آن خودش یک مصرف اندازه‌گیری‌شده نیست."),
  exempt(
    "platform.support",
    "پشتیبانی فنی نصب‌ها",
    "رابط دستگاه پشتیبانی و نشست‌های تیکت‌محور (مسئلهٔ ۹۸۴)؛ زیرساخت عملیات پشتیبانی است و به مشتری صورتحساب نمی‌شود.",
  ),

  fixed("accounting.orders", "سفارش و فروش", "accounting", true, "orders.view"),
  fixed("accounting.inventory", "انبار", "accounting", true),
  fixed("accounting.products", "محصولات", "accounting", true),
  fixed("accounting.operations", "عملیات روزانه", "accounting", true),
  fixed("accounting.ledger", "دفتر", "accounting", true, "ledger.view"),
  fixed("accounting.parties", "طرف‌حساب‌ها", "accounting", true),
  fixed("accounting.reports", "گزارش‌ها", "accounting", true),
  fixed("accounting.settings", "تنظیمات کسب‌وکار", "accounting", true),
  fixed("crm.workspace", "مدیریت مشتریان", "crm", true),
  fixed("growth.loyalty", "وفاداری و تبلیغات", "growth", false),
  fixed("operations.shared", "ابزارهای مشترک", "platform", false),
  fixed("retail.trades", "صنف‌های خرده‌فروشی", "accounting", true),
  fixed("integrations.api", "اتصال و API", "platform", false),
  fixed("website.domain", "خرید دامنه", "website", true),

  {
    mode: "hybrid",
    capabilityKey: "ai.chat",
    name: "دستیار هوشمند",
    application: "platform",
    customerVisible: true,
    critical: false,
    meterKey: "ai.credit",
    meterKeys: ["ai.input_tokens", "ai.output_tokens", "ai.request"],
  },
  {
    mode: "metered",
    capabilityKey: "automation.run",
    name: "خودکارسازی",
    application: "platform",
    customerVisible: true,
    critical: false,
    meterKey: "automation.run",
  },
  {
    mode: "metered",
    capabilityKey: "growth.messaging.sms",
    name: "پیامک",
    application: "growth",
    customerVisible: true,
    critical: false,
    meterKey: "messaging.sms_segment",
  },
  {
    mode: "metered",
    capabilityKey: "growth.messaging.email",
    name: "ایمیل",
    application: "growth",
    customerVisible: true,
    critical: false,
    meterKey: "messaging.email_send",
  },
  {
    mode: "hybrid",
    capabilityKey: "media.storage",
    name: "فضای رسانه",
    application: "platform",
    customerVisible: true,
    critical: true,
    meterKey: "media.storage_byte_hour",
  },
  {
    mode: "metered",
    capabilityKey: "media.image_enhance",
    name: "بهسازی تصویر",
    application: "platform",
    customerVisible: true,
    critical: false,
    meterKey: "media.image_enhance",
  },
  {
    mode: "hybrid",
    capabilityKey: "website.cms",
    name: "سایت‌ساز",
    application: "website",
    customerVisible: true,
    critical: true,
    meterKey: "cms.bandwidth_bytes",
    meterKeys: [
      "cms.origin_transfer_bytes",
      "cms.api_request",
      "cms.storage_byte_hour",
      "cms.build_second",
      "cms.deployment",
    ],
  },
  {
    mode: "metered",
    capabilityKey: "backup",
    name: "نسخهٔ پشتیبان",
    application: "platform",
    customerVisible: true,
    critical: false,
    meterKey: "backup.storage_byte_day",
  },
];

function exempt(capabilityKey: string, name: string, reason: string): BillingDeclaration {
  return {
    mode: "exempt",
    capabilityKey,
    name,
    application: "platform",
    customerVisible: false,
    critical: false,
    reason,
  };
}

function fixed(
  capabilityKey: string,
  name: string,
  application: BillingDeclaration["application"],
  critical: boolean,
  requiredPermission?: string,
): BillingDeclaration {
  return {
    mode: "fixed",
    capabilityKey,
    name,
    application,
    customerVisible: true,
    critical,
    ...(requiredPermission ? { requiredPermission } : {}),
  };
}

const BY_KEY = new Map(BILLING_DECLARATIONS.map((row) => [row.capabilityKey, row]));

export function declarationFor(capabilityKey: string): BillingDeclaration | null {
  return BY_KEY.get(capabilityKey) ?? null;
}

export function declarationMeterKeys(row: BillingDeclaration): string[] {
  if (row.mode === "fixed" || row.mode === "exempt") return [];
  return [row.meterKey, ...(row.meterKeys ?? [])];
}
