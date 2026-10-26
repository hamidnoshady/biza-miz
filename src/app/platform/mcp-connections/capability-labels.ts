/**
 * Issue #1126 §A — Persian labels for the platform capabilities an MCP token
 * can carry.
 *
 * Shared by the mint form, the connections list and the Test-connection
 * results so the same capability never reads three different ways. Pure data
 * (the `PlatformCapability` import is type-only), so both server and client
 * modules may use it.
 */
import type { PlatformCapability } from "@/lib/platform-admin";

/** Every capability in the platform vocabulary, with its operator label. */
export const PLATFORM_CAPABILITY_LABELS: Record<PlatformCapability, string> = {
  "businesses.read": "خواندن فهرست کسب‌وکارها",
  "business.reports.read": "خواندن گزارش‌های یک کسب‌وکار",
  "audit.read": "خواندن رویدادهای حسابرسی سکو",
  "system.read": "خواندن وضعیت سامانه و زیرساخت",
  "usage.read": "خواندن گزارش‌های مصرف",
  "ai.read": "خواندن گزارش‌های هوش مصنوعی",
  "features.write": "تغییر پرچم‌های ویژگی",
  "backup.manage": "عملیات پشتیبان‌گیری (خواندن، اجرا، راستی‌آزمایی)",
  "tenant_backup.read": "خواندن پشتیبان‌های کسب‌وکارها",
  "backup.read": "خواندن وضعیت پشتیبان‌گیری",
  "backup.run": "اجرای پشتیبان‌گیری سراسری",
  "backup.verify": "راستی‌آزمایی بسته‌های پشتیبان",
  "backup.configure": "پیکربندی پشتیبان‌گیری",
  "backup.share": "اشتراک‌گذاری و توکن‌های پشتیبان",
  "backup.peer.manage": "مدیریت سرورهای همتای پشتیبان",
  "cms.manage": "مدیریت وب‌سایت‌های CMS",
  "business.suspend": "تعلیق / فعال‌سازی کسب‌وکار",
  "billing.manage": "مدیریت مالی سکو",
  "billing.view": "مشاهدهٔ صورتحساب‌ها و اشتراک‌ها",
  "retention.manage": "مدیریت نگهداری و حذف دادهٔ سرویس‌ها",
  "plans.manage": "مدیریت پلن‌های فروش",
  "payments.review": "بررسی پرداخت‌های دستی",
  "gateways.manage": "مدیریت درگاه‌های پرداخت",
  "adjustments.manage": "اصلاح موجودی کیف‌پول",
  "messaging.manage": "مدیریت پیامک و ایمیل",
  "media.manage": "مدیریت رسانه و تعرفهٔ ذخیره‌سازی",
  "security.manage": "مدیریت امنیت و ورود",
  "business.edit": "ویرایش شناسهٔ کسب‌وکار",
  "business.reset": "ریست دادهٔ کسب‌وکار",
  "knowledge.manage": "مدیریت پایگاه دانش سکو",
  "support.manage": "مدیریت تیکت‌های پشتیبانی",
  "support.context.read": "خواندن زمینهٔ پشتیبانی",
  "support.diagnostics.request": "درخواست عیب‌یابی",
  "support.reports.read": "خواندن گزارش‌های عیب‌یابی",
  "support.repair.propose": "پیشنهاد تعمیر",
  "support.repair.execute": "اجرای تعمیر تأییدشده",
  "support.assist.view": "مشاهدهٔ راه‌دور",
  "support.assist.control": "کنترل راه‌دور",
  "support.assist.revoke": "پایان نشست راه‌دور",
  "support.repair.publish": "انتشار سیاست تعمیرات",
  "support.token.issue": "صدور توکن دسترسی حضوری",
  "support.ai.use": "استفاده از هوش پشتیبانی",
  "support.ai.configure": "پیکربندی هوش پشتیبانی",
  "impersonate.readOnly": "ورود فقط‌خواندنی به کسب‌وکار",
  "impersonate.controlled": "ورود کنترل‌شده به کسب‌وکار",
  "impersonate.full": "ورود کامل به کسب‌وکار",
  "impersonate.revoke": "لغو نشست‌های ورود",
  "impersonate.extend": "تمدید نشست‌های ورود",
  "backup.restore": "بازگردانی کامل پایگاه‌داده",
  "business.provision": "ساخت کسب‌وکار تازه",
  "business.archive": "بایگانی کسب‌وکار",
  "business.delete": "حذف دائمی کسب‌وکار",
  "admins.manage": "مدیریت مدیران",
  "updates.manage": "مدیریت به‌روزرسانی‌ها",
  "ai.config.manage": "پیکربندی هوش مصنوعی سکو",
};

/** Unknown capabilities (a newer server than this page) render as their raw key, never blank. */
export function platformCapabilityLabel(capability: string): string {
  return (PLATFORM_CAPABILITY_LABELS as Record<string, string>)[capability] ?? capability;
}

/**
 * Capabilities whose grant deserves an explicit warning: destructive,
 * platform-wide, financial, or full-access. A token carrying one of these —
 * especially with a platform-wide (non-scoped) bridge — is the most powerful
 * credential this page mints.
 */
export const POWERFUL_PLATFORM_CAPABILITIES: ReadonlySet<string> = new Set([
  "business.delete",
  "business.reset",
  "business.archive",
  "business.provision",
  "business.edit",
  "admins.manage",
  "billing.manage",
  "retention.manage",
  "adjustments.manage",
  "payments.review",
  "plans.manage",
  "gateways.manage",
  "backup.run",
  "backup.restore",
  "backup.configure",
  "backup.share",
  "impersonate.full",
  "impersonate.controlled",
  "support.repair.execute",
  "support.assist.control",
  "updates.manage",
  "ai.config.manage",
]);
