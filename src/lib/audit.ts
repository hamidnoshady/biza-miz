/**
 * Phase 20 Wave 6 — audit trail: the framework-free half.
 *
 * `audit_log` (Phase 0) has been written to by every wave of this phase
 * (and by team-service.ts/branch-service.ts from earlier phases) since
 * before this phase started, but nothing has ever read it back for a human.
 * This file owns turning one raw `action`/`entity` pair into the Persian
 * label the new Settings tab (audit-log-settings.tsx) shows — the DB read
 * itself lives in audit-service.ts, same split as every other wave.
 *
 * Unknown actions/entities (a future wave's new audit action, or a business
 * running against an older/newer app version than this file) fall back to
 * the raw string rather than throwing or hiding the row — the same
 * tolerant-of-unknowns posture `effectivePermissions` already takes for a
 * permission key a later release removed.
 */

const ACTION_LABELS: Record<string, string> = {
  "ai.library.selected": "انتخاب پیوست از کتابخانه برای دستیار",
  "ai.session_consent.granted": "اجازهٔ موقت دستیار برای یک وظیفه",
  "ai.session_consent.revoked": "لغو اجازهٔ موقت دستیار",
  "employee.profile_updated": "ویرایش پروفایل کارمند",
  "employee.credential_issued": "صدور اعتبارنامه",
  "employee.credential_revoked": "ابطال اعتبارنامه",
  "employee.webauthn_registered": "ثبت ورود بیومتریک",
  "employee.session_created": "ورود به سیستم",
  "employee.session_revoked": "پایان نشست",
  "employee.login_failed": "تلاش ورود ناموفق",
  "employee.login_unlocked": "رفع قفل ورود",
  "auth.trusted_device_granted": "اعتماد به دستگاه",
  "auth.trusted_device_login": "ورود از دستگاه مورد اعتماد",
  "auth.trusted_device_revoked": "لغو اعتماد به دستگاه",
  "auth.telegram_link_challenge_created": "ساخت پیوند موقت تلگرام",
  "auth.telegram_identity_linked": "پیوند حساب تلگرام",
  "auth.telegram_identity_unlinked": "لغو پیوند حساب تلگرام",
  "team.member_created": "افزودن عضو تیم",
  "team.member_updated": "ویرایش عضو تیم",
  "team.member_removed": "حذف عضو تیم",
  // Issue #1007 — the hard removal («حذف عضو») is its own event, not the
  // soft-delete above: the row is gone, and the entry is what says who removed
  // it and what went with it.
  "team.member_deleted": "حذف دائمی عضو تیم",
  "team.pin_changed": "تغییر پین",
  "team.password_changed": "تغییر رمز عبور",
  "team.invited": "دعوت عضو جدید",
  "team.invitation_accepted": "پذیرش دعوت",
  "device.paired": "ثبت دستگاه",
  "device.renamed": "تغییر نام دستگاه",
  "device.revoked": "لغو ثبت دستگاه",
  "order.amended": "ویرایش سفارش بسته‌شده",
  "order.voided_after_close": "حذف سفارش بسته‌شده",
  // Issue #844 — the canonical selling-price change, written only by
  // src/lib/menu-price-service.ts together with its immutable history row.
  "menu.item.price_changed": "تغییر قیمت آیتم منو",
  // Issue #911 — the rest of an item's lifecycle, written only by
  // src/lib/menu-service.ts. Price is absent on purpose: it is the event
  // above, and one write is never recorded as two.
  "menu.item.created": "افزودن آیتم منو",
  "menu.item.updated": "ویرایش آیتم منو",
  "menu.item.moved": "انتقال آیتم منو به دستهٔ دیگر",
  "menu.item.activated": "فعال‌سازی آیتم منو",
  "menu.item.deactivated": "غیرفعال‌سازی آیتم منو",
  "menu.item.deleted": "حذف آیتم منو",
  "shift.opened": "شروع شیفت",
  "shift.closed": "پایان شیفت",
  // Issue #933 — the two audited money actions around a shift. Without labels
  // the audit tab shows the raw dotted key where every other row is Persian.
  "shift.cash_movement": "ثبت ورود/خروج نقدی صندوق",
  "shift.cashup_adjusted": "اصلاح مستند تطبیق صندوق شیفت",
  "branch.created": "ایجاد شعبه",
  "branch.updated": "ویرایش شعبه",
  "branch.deactivated": "غیرفعال‌سازی شعبه",
  "branch.reactivated": "فعال‌سازی شعبه",
  // The settings writers. `settings.business.update` is the business identity
  // form (name, tax id, receipt footer, currency unit); `settings.mfa_policy.
  // update` had been writing rows since Phase 24 with no label, so the audit
  // tab showed the raw dotted key where every other row has Persian.
  "settings.business.update": "تغییر اطلاعات کسب‌وکار",
  "settings.mfa_policy.update": "تغییر سیاست ورود دومرحله‌ای",
  // Issue #1128 — an advertising agency's operating profile (which of the eight
  // presets in agency.ts it works as). Labeled from the start so the audit tab
  // never shows a raw dotted key for it, the mistake the two entries above were
  // added to fix.
  "settings.agency_profile.update": "تغییر پروفایل فعالیت آژانس",
  "impersonation.request": "درخواست ورود جانشینی",
  "account.created": "ایجاد حساب",
  "account.renamed": "تغییر نام حساب",
  "account.reparented": "جابه‌جایی حساب در ساختار",
  "account.archived": "بایگانی حساب",
  "account.reactivated": "بازگردانی حساب از بایگانی",
  "account.contra_changed": "تغییر وضعیت حساب کاهنده",
  "account.deleted": "حذف حساب",
  "fiscal_year.created": "تعریف سال مالی",
  "fiscal_period.soft_closed": "بستن موقت دورهٔ مالی",
  "fiscal_period.locked": "قفل‌کردن دورهٔ مالی",
  "fiscal_period.reopened": "بازگشایی دورهٔ مالی",
  "fiscal_year.closed": "بستن نهایی سال مالی",
  "table.created": "ایجاد میز",
  "table.updated": "ویرایش میز",
  "table.status_changed": "تغییر وضعیت میز",
  "table.archived": "بایگانی میز",
  "table.restored": "بازیابی میز از بایگانی",
  "floor_section.created": "ایجاد بخش سالن",
  "floor_section.updated": "ویرایش بخش سالن",
  "floor_section.deleted": "حذف بخش سالن",
  "item.duplicate_orphan_archived": "بایگانی کالای تکراری ناشی از همگام‌سازی ووکامرس",
  "growth.campaign_created": "ساخت پیش‌نویس کمپین",
  "growth.campaign_updated": "ویرایش پیش‌نویس کمپین",
  "growth.campaign_archived": "بایگانی کمپین",
};

const ENTITY_LABELS: Record<string, string> = {
  employee: "کارمند",
  team: "تیم",
  device: "دستگاه",
  shift: "شیفت",
  order: "سفارش",
  location: "شعبه",
  account: "حساب",
  fiscal_year: "سال مالی",
  fiscal_period: "دورهٔ مالی",
  settings: "تنظیمات",
  menu_item: "آیتم منو",
  telegram_link_challenge: "پیوند موقت تلگرام",
  telegram_identity_link: "پیوند حساب تلگرام",
  commission_run: "دورهٔ تسویه پورسانت",
  commission_payout: "پرداخت پورسانت",
  dining_table: "میز",
  floor_section: "بخش سالن",
  growth_campaign: "کمپین رشد",
};

/** A Persian label for a raw `audit_log.action` value, falling back to the raw string when unrecognised. */
export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** A Persian label for a raw `audit_log.entity` value, falling back to the raw string (or a dash when absent). */
export function auditEntityLabel(entity: string | null): string {
  if (!entity) return "—";
  return ENTITY_LABELS[entity] ?? entity;
}

export type CredentialKind = "pin" | "webauthn";

/**
 * Which kind of credential opened a session, per Wave 5's first open
 * question: `employee_sessions.credential_id` (and, in the audit payload
 * this wave adds, the same id) is only ever populated for a webauthn login —
 * PIN verification stays on `users.pin_hash` and never touches
 * `employee_credentials` — so absence of a credential id means "pin", not
 * "unknown".
 */
export function credentialKindFromId(credentialId: string | null | undefined): CredentialKind {
  return credentialId ? "webauthn" : "pin";
}

export function credentialKindLabel(kind: CredentialKind): string {
  return kind === "webauthn" ? "بیومتریک" : "پین";
}
