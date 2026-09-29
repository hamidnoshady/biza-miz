/**
 * Centralized error translation for the super-admin console.
 *
 * Every `/api/platform/**` route returns a stable `{ error: "code" }` envelope
 * on failure; this is the single place those codes become Persian operator
 * text. It used to live inline in `src/app/platform/ui.tsx`, which meant it
 * could only be used from client components and could not be unit-tested; here
 * it is pure so both server and client can share it and the mapping is covered
 * by tests.
 *
 * A raw code must NEVER reach an operator: an unmapped code falls back to the
 * gateway vocabulary and then to a generic message, never the code itself.
 */
import { gatewayErrorText } from "./ai-gateway";

/**
 * The shared, cross-domain error vocabulary. Domain-specific codes that only
 * one feature ever emits stay with that feature and can be passed as `extra`.
 */
const PLATFORM_ERROR_MESSAGES: Record<string, string> = {
  // Auth / authorization
  unauthorized: "وارد نشده‌اید.",
  forbidden: "این عملیات در سطح دسترسی شما نیست.",
  bad_request: "درخواست نامعتبر بود.",
  invalid_credentials: "ایمیل یا رمز عبور نادرست است.",
  missing_credentials: "ایمیل و رمز عبور را وارد کنید.",
  missing_fields: "فیلدهای الزامی را پر کنید.",
  invalid_email: "ایمیل معتبر نیست.",
  weak_password: "رمز عبور باید حداقل ۸ نویسه باشد.",
  email_password_mismatch: "این ایمیل قبلاً ثبت شده و رمز عبور واردشده با آن هم‌خوانی ندارد.",
  invalid_status: "وضعیت نامعتبر است.",
  not_found: "پیدا نشد.",
  nothing_to_change: "تغییری برای ذخیره وجود ندارد.",
  validation_error: "برخی فیلدها معتبر نیستند؛ آن‌ها را بررسی کنید.",
  rate_limited: "درخواست‌های بیش از حد؛ کمی بعد دوباره تلاش کنید.",
  conflict: "این عملیات با وضعیت فعلی سازگار نیست.",

  // Networking / transport (synthesized client-side by the platform client)
  network_error: "ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید.",
  parse_error: "پاسخ سرور قابل خواندن نبود. دوباره تلاش کنید.",
  request_cancelled: "درخواست لغو شد.",
  server_error: "خطای غیرمنتظرهٔ سرور. دوباره تلاش کنید.",

  // Business lifecycle
  business_archived: "کسب‌وکار بایگانی‌شده قابل ورود نیست.",
  business_not_found: "کسب‌وکار پیدا نشد.",
  no_owner: "این کسب‌وکار مالک فعالی برای ورود ندارد.",
  // Issue #755 §14 — the owner activates with a link *and* a code texted to
  // their own mobile, so provisioning without a number would mint a link nobody
  // could honour.
  owner_phone_required: "برای فعال‌سازی مالک، شمارهٔ موبایل الزامی است.",
  impersonation_read_only: "این نشست فقط‌خواندنی است و امکان تغییر ندارد.",
  reason_too_short: "دلیل دسترسی باید دست‌کم ۱۰ نویسه باشد.",
  ticket_unavailable: "تیکت انتخاب‌شده به این کسب‌وکار تعلق ندارد یا در دسترس نیست.",
  active_support_session_exists: "برای این اپراتور و کسب‌وکار یک نشست فعال وجود دارد.",
  support_session_not_active: "این نشست دیگر فعال نیست.",
  support_capability_denied: "این عملیات در محدودهٔ دسترسی فنی این نشست نیست.",
  support_access_disabled: "این کسب‌وکار دسترسی پشتیبانی را غیرفعال کرده است.",
  support_approval_required: "سیاست امنیتی کسب‌وکار برای این سطح، تأیید مالک را الزامی کرده است.",
  recent_auth_required: "برای دسترسی کامل، دوباره وارد سوپرادمین شوید.",
  mfa_required: "دسترسی کامل به ورود دومرحله‌ای تأییدشده نیاز دارد.",
  invalid_plan: "این پلن در فهرست پلن‌ها وجود ندارد.",
  invalid_timezone: "منطقهٔ زمانی معتبر نیست.",
  reset_confirmation_required: "برای ریست، عبارت تأیید را دقیق وارد کنید.",
  reset_not_possible: "ریست ممکن نیست؛ این کسب‌وکار مالک فعال و قابل ورود ندارد.",
  reset_failed: "ریست انجام نشد و هیچ داده‌ای تغییر نکرد. دوباره تلاش کنید.",
  delete_confirmation_required: "برای حذف، عبارت تأیید را دقیق وارد کنید.",
  delete_failed: "حذف انجام نشد و هیچ داده‌ای تغییر نکرد. دوباره تلاش کنید.",
  no_location: "این کسب‌وکار هنوز شعبه‌ای ندارد؛ ابتدا یک شعبه بسازید.",
  code_not_found: "کد اتصال پیدا نشد.",
  code_expired: "این کد منقضی شده است.",
  code_already_redeemed: "این کد قبلاً استفاده شده است.",
  code_revoked: "این کد لغو شده است.",

  // Per-business subdomains
  invalid_subdomain:
    "زیردامنه باید بین ۳ تا ۶۳ نویسه و فقط شامل حروف انگلیسی کوچک، رقم و خط تیره باشد؛ " +
    "نباید با خط تیره شروع یا تمام شود.",
  reserved_subdomain: "این زیردامنه رزرو شده است و قابل استفاده نیست.",
  missing_subdomain: "زیردامنهٔ کسب‌وکار را به انگلیسی وارد کنید.",
  subdomain_taken: "این زیردامنه قبلاً به کسب‌وکار دیگری اختصاص یافته است.",
  invalid_owner_phone: "شمارهٔ موبایل مالک معتبر نیست. نمونه: ۰۹۱۲۱۲۳۴۵۶۷",
  // Issue #755 §14 — the address already belongs to a platform user. Adding a
  // business to that person's account is fine (it is the group-owner case) but
  // never silent, so the console asks and repeats with confirmation.
  email_already_registered:
    "این ایمیل از قبل حساب کاربری پلتفرم دارد. با تأیید، این کسب‌وکار به همان حساب اضافه می‌شود و رمز عبور فعلی او تغییر نمی‌کند.",
  invalid_industry: "نوع کسب‌وکار نامعتبر است.",
  industry_not_available: "این نوع کسب‌وکار هنوز در دسترس نیست.",
  unchanged: "زیردامنه تغییری نکرده است.",

  // Observability (پایش)
  observability_not_configured: "پایش هنوز تنظیم نشده است؛ متغیرهای OPENOBSERVE را در سرور وارد کنید.",
  observability_unreachable: "سرویس پایش در دسترس نیست. آخرین داده‌های موفق نمایش داده می‌شود.",
  invalid_level: "سطح لاگ نامعتبر است.",

  // App availability
  invalid_app_state: "وضعیت برنامه نامعتبر است.",

  // Knowledge base
  invalid_slug: "نامک باید حروف کوچک انگلیسی، رقم و خط تیره باشد (مثل pos-basics).",
  missing_title: "عنوان را وارد کنید.",
  missing_label: "نام برچسب را وارد کنید.",
  slug_taken: "این نامک قبلاً استفاده شده است.",
  category_has_children: "این دسته زیردسته دارد؛ اول زیردسته‌ها را منتقل یا حذف کنید.",
  category_has_articles: "این دسته راهنما دارد؛ اول راهنماها را به دستهٔ دیگری منتقل کنید.",
  category_cycle: "دستهٔ والد نامعتبر است.",
  parent_not_found: "دستهٔ والد پیدا نشد.",
  invalid_video_url: "آدرس ویدیو باید با http:// یا https:// شروع شود.",
  invalid_cover_url: "آدرس تصویر باید با http:// یا https:// شروع شود.",

  // Whole-system backup and peer restore
  backup_failed: "پشتیبان‌گیری کامل سیستم ناموفق بود.",
  backup_busy: "یک پشتیبان‌گیری دیگر همین حالا در حال اجراست.",
  restore_busy: "یک بازگردانی دیگر در حال اجراست؛ کمی بعد دوباره تلاش کنید.",
  confirmation_required: "برای بازگردانی کامل، عبارت تأیید را دقیق وارد کنید.",
  passphrase_required: "عبارت عبور رمزنگاری لازم است؛ آن را وارد کنید.",
  checksum_mismatch: "فایل دانلودشده با نسخهٔ اعلام‌شده هم‌خوانی ندارد؛ بازگردانی متوقف شد.",
  newer_schema: "آن پشتیبان از نسخهٔ جدیدتری گرفته شده و این سرور هنوز آن مهاجرت‌ها را ندارد.",
  newer_postgres: "نسخهٔ PostgreSQL سرور مقابل جدیدتر است و با pg_restore این سرور بازگردانی نمی‌شود.",
  https_required: "آدرس باید https باشد، یا «اجازهٔ اتصال ناامن» را در تنظیمات روشن کنید.",
  peer_unreachable: "سرور مقابل در دسترس نیست.",
  peer_auth_failed: "کلید این سرور در آن سمت پذیرفته نشد (لغو یا منقضی شده است؟).",
  bad_manifest: "پاسخ سرور مقابل معتبر نیست.",
};

/**
 * Translate an error code (from an API envelope or a caught client error) into
 * Persian operator text. `extra` lets a caller layer in domain-specific codes
 * without polluting the shared vocabulary. Unknown codes fall back to the AI
 * gateway's own vocabulary, then to a generic message — never the raw code.
 */
export function platformErrorText(
  code: string | null | undefined,
  extra?: Record<string, string>,
): string {
  const key = code ?? "";
  return (
    extra?.[key] ??
    PLATFORM_ERROR_MESSAGES[key] ??
    gatewayErrorText(code ?? undefined) ??
    "خطای غیرمنتظره. دوباره تلاش کنید."
  );
}

/** Whether the shared vocabulary knows a code (before gateway fallback). */
export function isKnownPlatformError(code: string | null | undefined): boolean {
  return Boolean(code && code in PLATFORM_ERROR_MESSAGES);
}
