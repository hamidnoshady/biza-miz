import {
  Archive,
  Ban,
  BellRing,
  CircleCheck,
  DatabaseBackup,
  Download,
  Globe,
  KeyRound,
  Layers,
  List,
  LogOut,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Store,
  TerminalSquare,
  Trash2,
  Upload,
  WalletCards,
} from "lucide-react";
import type { StatusTone } from "@/components/platform/status-badge";

/**
 * The audit action vocabulary — a Persian label, a status tone and an icon per
 * action family. Shared between the list and the detail drawer so an event
 * reads the same everywhere. Security-sensitive/destructive actions carry a
 * `danger` tone without turning the whole page into a rainbow (task section 12).
 */
export interface ActionMeta {
  label: string;
  tone: StatusTone;
  icon: React.ComponentType<{ className?: string }>;
}

export const ACTION_META: Record<string, ActionMeta> = {
  "business.provision": { label: "ایجاد کسب‌وکار", tone: "success", icon: Store },
  "business.active": { label: "فعال‌سازی", tone: "success", icon: CircleCheck },
  "business.suspended": { label: "تعلیق", tone: "warning", icon: Ban },
  "business.archived": { label: "بایگانی", tone: "muted", icon: Archive },
  // The hard-delete lifecycle: a request, then exactly one terminal event.
  // `completed` only exists if the database delete committed, so its presence
  // is evidence the business is gone — the old single `business.delete` event
  // was written before the delete ran and could imply success after a failure.
  "business.delete": { label: "حذف دائمی", tone: "danger", icon: Trash2 },
  "business.delete.requested": { label: "درخواست حذف دائمی", tone: "warning", icon: Trash2 },
  "business.delete.completed": { label: "حذف دائمی انجام شد", tone: "danger", icon: Trash2 },
  "business.delete.failed": { label: "حذف دائمی ناموفق", tone: "danger", icon: Trash2 },
  // The reset lifecycle mirrors the delete one (issue #822): requested only
  // after permission + typed confirmation, completed only after commit,
  // failed otherwise. `business.reset` itself is the historical single event
  // written by the old implementation — kept so old rows still render.
  "business.reset.requested": { label: "درخواست بازنشانی کسب‌وکار", tone: "warning", icon: RotateCcw },
  "business.reset.completed": { label: "بازنشانی کسب‌وکار انجام شد", tone: "success", icon: RotateCcw },
  "business.reset.failed": { label: "بازنشانی کسب‌وکار ناموفق", tone: "danger", icon: RotateCcw },
  "business.reset": { label: "بازنشانی کسب‌وکار", tone: "danger", icon: RotateCcw },
  "business.plan": { label: "تغییر پلن", tone: "info", icon: Layers },
  "business.edit": { label: "ویرایش کسب‌وکار", tone: "info", icon: Pencil },
  "business.subdomain": { label: "تغییر نشانی (زیردامنه)", tone: "info", icon: Globe },
  "business.industry_change": { label: "تغییر نوع کسب‌وکار", tone: "info", icon: SlidersHorizontal },
  "business.owner_profile.updated": { label: "ویرایش پروفایل مالک/مدیر", tone: "warning", icon: Pencil },
  // The generic business writers (issue #1296 follow-up sweep): these were
  // rendering as raw keys, which is what the sweep test now forbids.
  "business.update": { label: "ویرایش کسب‌وکار", tone: "info", icon: Pencil },
  "business.rename_subdomain": { label: "تغییر نشانی (زیردامنه)", tone: "info", icon: Globe },
  "business.override.removed": { label: "حذف بازنویسی ویژگی", tone: "warning", icon: SlidersHorizontal },
  "business.app_availability.write": { label: "تغییر دسترسی اپلیکیشن‌ها", tone: "info", icon: SlidersHorizontal },
  "feature.override": { label: "بازنویسی پرچم ویژگی", tone: "info", icon: SlidersHorizontal },
  "impersonation.start": { label: "شروع دسترسی پشتیبانی", tone: "warning", icon: KeyRound },
  "impersonation.request": { label: "درخواست دسترسی پشتیبانی", tone: "warning", icon: KeyRound },
  "impersonation.end": { label: "پایان دسترسی پشتیبانی", tone: "muted", icon: KeyRound },
  "impersonation.revoke": { label: "لغو دسترسی پشتیبانی", tone: "warning", icon: KeyRound },
  "support_session.started": { label: "شروع نشست پشتیبانی", tone: "warning", icon: KeyRound },
  // Written as literals inside the `INSERT INTO platform_audit_log` that closes
  // the session (issue #1296 follow-up sweep — these are invisible to a search
  // for `action:` and were the reason the family filter matched nothing).
  "support_session.requested": { label: "درخواست نشست پشتیبانی", tone: "warning", icon: KeyRound },
  "support_session.approved": { label: "تأیید نشست پشتیبانی", tone: "success", icon: CircleCheck },
  "support_session.denied": { label: "رد درخواست نشست پشتیبانی", tone: "danger", icon: Ban },
  "support_session.resumed": { label: "ادامهٔ نشست پشتیبانی", tone: "warning", icon: KeyRound },
  "support_session.revoked_by_local_owner": {
    label: "لغو نشست توسط مالک محلی",
    tone: "warning",
    icon: KeyRound,
  },
  "support_session.revoked_locally": { label: "لغو نشست از میزبان محلی", tone: "warning", icon: KeyRound },
  "support_session.command_queued": { label: "صف دستور پشتیبانی", tone: "info", icon: TerminalSquare },
  "support_session.command_executed": { label: "اجرای دستور پشتیبانی", tone: "warning", icon: TerminalSquare },
  "support_session.command_completed": { label: "پایان دستور پشتیبانی", tone: "success", icon: TerminalSquare },
  "support_session.ended": { label: "پایان نشست پشتیبانی", tone: "muted", icon: KeyRound },
  "support_session.expired": { label: "انقضای نشست پشتیبانی", tone: "muted", icon: KeyRound },
  "support_session.revoked": { label: "لغو نشست پشتیبانی از کنسول", tone: "warning", icon: KeyRound },
  "support_session.tenant_revoked": { label: "لغو نشست پشتیبانی توسط کسب‌وکار", tone: "warning", icon: KeyRound },
  // Issue #902 §6 — the managed-SMS control plane. Every one of these actions
  // moves money, a provider credential, or a message a business will send to
  // its own customers, so each gets a first-party label rather than falling
  // through to the raw `sms.managed_account.…` string. The family filter in
  // the toolbar is the prefix `sms`, which is why every entry must keep it.
  "sms.config.update": { label: "تغییر تنظیمات پیامک", tone: "warning", icon: SlidersHorizontal },
  "sms.managed_account.provision": { label: "ساخت حساب پیامک", tone: "success", icon: Store },
  "sms.managed_account.adopt": { label: "پذیرش حساب موجود", tone: "info", icon: Store },
  "sms.managed_account.sync": { label: "همگام‌سازی حساب", tone: "info", icon: RefreshCw },
  "sms.managed_account.suspend": { label: "تعلیق حساب پیامک", tone: "warning", icon: Ban },
  "sms.managed_account.reactivate": { label: "فعال‌سازی حساب پیامک", tone: "success", icon: CircleCheck },
  // A key rotation invalidates the credential the drain is holding: worth a
  // warning tone even though nothing failed.
  "sms.managed_account.rotate_key": { label: "چرخش کلید حساب", tone: "warning", icon: KeyRound },
  "sms.managed_account.fund": { label: "تأمین اعتبار ارائه‌دهنده", tone: "info", icon: WalletCards },
  "sms.managed_account.transfer": { label: "انتقال اعتبار به ارائه‌دهنده", tone: "info", icon: WalletCards },
  "sms.managed_account.reconcile": { label: "تطبیق موجودی حساب", tone: "info", icon: RefreshCw },
  "sms.managed_account.probe": { label: "بررسی سلامت حساب", tone: "info", icon: ShieldCheck },
  "sms.managed_account.policy": { label: "تغییر خط‌مشی حساب", tone: "info", icon: SlidersHorizontal },
  "sms.managed_account.template_sync": { label: "همگام‌سازی الگوها", tone: "info", icon: RefreshCw },
  "sms.managed_account.template_submit": { label: "ثبت الگو نزد ارائه‌دهنده", tone: "info", icon: Upload },
  "sms.managed_account.template_archive": { label: "بازنشانی الگو", tone: "warning", icon: Archive },
  "sms.managed_account.template_from_library": {
    label: "کپی الگو از کتابخانه",
    tone: "info",
    icon: Download,
  },
  // A test send costs the provider real money and reaches a real handset.
  "sms.managed_account.template_send_test": { label: "ارسال آزمایشی الگو", tone: "info", icon: Send },
  "sms.managed_service.master_template_saved": {
    label: "ذخیره الگوی سرور",
    tone: "info",
    icon: Pencil,
  },
  "sms.managed_service.master_template_toggled": {
    label: "تغییر وضعیت الگوی سرور",
    tone: "warning",
    icon: Layers,
  },
  // The AI gateway + playground writes (added by the same sweep).
  "ai.gateway.save": { label: "ذخیرهٔ تنظیمات دروازهٔ هوش مصنوعی", tone: "warning", icon: SlidersHorizontal },
  "ai.gateway.save_blocked_undecryptable_credential": {
    label: "جلوگیری از ذخیرهٔ کلید ناخوانا",
    tone: "danger",
    icon: ShieldCheck,
  },
  "ai.gateway.key.rotate": { label: "چرخش کلید دروازه", tone: "warning", icon: KeyRound },
  "ai.gateway.key.rotate_failed": { label: "چرخش کلید دروازه ناموفق", tone: "danger", icon: KeyRound },
  "ai.gateway.key.revoke": { label: "لغو کلید دروازه", tone: "warning", icon: KeyRound },
  "ai.gateway.key.revoke_failed": { label: "لغو کلید دروازه ناموفق", tone: "danger", icon: KeyRound },
  "ai.playground.requested": { label: "درخواست آزمون زمین بازی", tone: "info", icon: Send },
  "ai.playground.test": { label: "آزمون زمین بازی هوش مصنوعی", tone: "info", icon: Send },
  "ai.playground.failed": { label: "آزمون زمین بازی ناموفق", tone: "warning", icon: Ban },
  "ai_costing.changed": { label: "تغییر تعرفهٔ هزینهٔ هوش مصنوعی", tone: "warning", icon: WalletCards },
  "billing.spend_policy.updated": { label: "تغییر خط‌مشی هزینه", tone: "warning", icon: SlidersHorizontal },
  "sms.managed_service.alert_acknowledged": {
    label: "تأیید هشدار پیامک",
    tone: "muted",
    icon: BellRing,
  },
  // Issue #1296 follow-up — the backup control plane. These used to fall
  // through to the raw key, so the console showed `platform_backup.cloud.retry`
  // and the operator could not tell a retry from a token revocation. The
  // `cloud.retry` label is the one the #1296 audit called out as missing: it is
  // written by the route the console's own retry button calls.
  "platform_backup.run": { label: "پشتیبان‌گیری کل سیستم", tone: "info", icon: DatabaseBackup },
  "platform_backup.cloud.retry": { label: "تلاش دوبارهٔ ارسال به فضای ابری", tone: "warning", icon: RefreshCw },
  // The read-only sibling, written by the MCP `verify_backup_cloud_object` tool:
  // it proves the object without uploading anything, so it is informational
  // rather than a warning like a retry.
  "platform_backup.cloud.verify": { label: "راستی‌آزمایی نسخهٔ ابری", tone: "info", icon: ShieldCheck },
  "platform_backup.config.update": { label: "تغییر تنظیمات پشتیبان‌گیری", tone: "warning", icon: SlidersHorizontal },
  "platform_backup.peer.save": { label: "افزودن سرور همتا", tone: "info", icon: Server },
  "platform_backup.peer.update": { label: "ویرایش سرور همتا", tone: "info", icon: Server },
  "platform_backup.peer.delete": { label: "حذف سرور همتا", tone: "warning", icon: Trash2 },
  "platform_backup.token.create": { label: "ساخت توکن پشتیبان‌گیری", tone: "warning", icon: KeyRound },
  "platform_backup.token.revoke": { label: "لغو توکن پشتیبان‌گیری", tone: "warning", icon: KeyRound },
  "platform_backup.restore.verify": { label: "بررسی فایل بازگردانی", tone: "info", icon: ShieldCheck },
  "platform_backup.restore.apply": { label: "بازگردانی کل سیستم", tone: "danger", icon: DatabaseBackup },
  "backup.run_now": { label: "پشتیبان‌گیری از طریق MCP", tone: "info", icon: DatabaseBackup },
  // The per-business side of the same machinery. Destructive or
  // credential-touching actions carry their own tone.
  "tenant_backup.run": { label: "پشتیبان‌گیری کسب‌وکار", tone: "info", icon: DatabaseBackup },
  "tenant_backup.catch_up": { label: "جبران پشتیبان‌گیری عقب‌افتاده", tone: "info", icon: RefreshCw },
  "tenant_backup.metadata_viewed": { label: "مشاهدهٔ فهرست پشتیبان‌ها", tone: "muted", icon: List },
  "tenant_backup.artifacts_viewed": { label: "مشاهدهٔ فایل‌های پشتیبان", tone: "muted", icon: List },
  "tenant_backup.artifact.download": { label: "دریافت فایل پشتیبان", tone: "warning", icon: Download },
  "tenant_backup.artifact.verify": { label: "بررسی صحت فایل پشتیبان", tone: "info", icon: ShieldCheck },
  "tenant_backup.artifact.delete": { label: "حذف فایل پشتیبان", tone: "danger", icon: Trash2 },
  "tenant_backup.custody.rotate": { label: "چرخش کلید نگهداری پشتیبان", tone: "warning", icon: KeyRound },
  "tenant_backup.custody.unlock": { label: "باز کردن قفل کلید نگهداری", tone: "danger", icon: KeyRound },
  "tenant_backup.policy.override": { label: "بازنویسی خط‌مشی پشتیبان‌گیری", tone: "warning", icon: SlidersHorizontal },
  "tenant_backup.policy.clear": { label: "حذف بازنویسی خط‌مشی", tone: "warning", icon: SlidersHorizontal },
  "tenant_backup.plan_policy.update": { label: "خط‌مشی پشتیبان‌گیری پلن", tone: "warning", icon: SlidersHorizontal },
  "tenant_backup.plan_policy.clear": { label: "حذف خط‌مشی پشتیبان‌گیری پلن", tone: "warning", icon: SlidersHorizontal },
  "tenant_backup.service.update": { label: "تنظیم سرویس پشتیبان‌گیری مدیریت‌شده", tone: "warning", icon: SlidersHorizontal },
  "tenant_backup.service.check": { label: "بررسی سلامت سرویس پشتیبان‌گیری", tone: "info", icon: ShieldCheck },
  "tenant_backup.restore.approve": { label: "تأیید بازگردانی کسب‌وکار", tone: "danger", icon: DatabaseBackup },
  "tenant_backup.restore.revoke": { label: "لغو تأیید بازگردانی", tone: "warning", icon: RotateCcw },
  // The CMS control plane — «سایت‌ساز», previously a filter that matched nothing.
  "platform_cms.config.update": { label: "تنظیمات سایت‌ساز", tone: "warning", icon: SlidersHorizontal },
  "platform_cms.config.verify": { label: "بررسی اتصال سایت‌ساز", tone: "info", icon: ShieldCheck },
  "platform_cms.key.issue": { label: "صدور کلید سایت‌ساز", tone: "warning", icon: KeyRound },
  "platform_cms.key.revoke": { label: "لغو کلید سایت‌ساز", tone: "warning", icon: KeyRound },
  "platform_cms.site.provision": { label: "راه‌اندازی سایت", tone: "success", icon: Globe },
  "platform_cms.site.update": { label: "ویرایش سایت", tone: "info", icon: Pencil },
  // The console plane: who was let in, and who acted for them.
  "platform_admin.created": { label: "ایجاد مدیر سامانه", tone: "warning", icon: ShieldCheck },
  "platform_admin.updated": { label: "ویرایش مدیر سامانه", tone: "info", icon: Pencil },
  "platform_admin.update": { label: "ویرایش مدیر سامانه", tone: "info", icon: Pencil },
  "platform_admin.password_changed_self": { label: "تغییر گذرواژه توسط مدیر", tone: "info", icon: KeyRound },
  "platform_admin.password_reset_initiated": { label: "شروع بازنشانی گذرواژه", tone: "warning", icon: KeyRound },
  "platform_admin.mfa_confirmed": { label: "فعال‌سازی ورود دومرحله‌ای", tone: "success", icon: ShieldCheck },
  "platform_admin.mfa_recovery_regenerated": { label: "تولید دوبارهٔ کدهای بازیابی", tone: "warning", icon: ShieldCheck },
  "platform_admin.sessions_revoked": { label: "پایان همهٔ نشست‌های مدیر", tone: "warning", icon: LogOut },
  "platform_admin.other_sessions_revoked": { label: "پایان نشست‌های دیگر مدیر", tone: "warning", icon: LogOut },
  "platform_admin.all_sessions_revoked": { label: "پایان نشست‌های همهٔ مدیران", tone: "danger", icon: LogOut },
  "platform_mcp.call": { label: "فراخوانی ابزار MCP", tone: "info", icon: TerminalSquare },
  "platform_mcp.mint": { label: "ساخت توکن MCP", tone: "warning", icon: KeyRound },
  "platform_mcp.oauth_consent": { label: "رضایت دسترسی MCP", tone: "warning", icon: ShieldCheck },
  "platform_mcp.revoke": { label: "لغو اتصال MCP", tone: "warning", icon: Ban },
  "platform_mcp.test": { label: "آزمایش اتصال MCP", tone: "muted", icon: TerminalSquare },
};

export function auditMetaFor(action: string): ActionMeta {
  return ACTION_META[action] ?? { label: action, tone: "neutral", icon: CircleCheck };
}

/**
 * The families are shared with the server, which turns them into SQL — see
 * `src/lib/audit-families.ts` for why a family is a *set* of prefixes. Re-exported
 * here so the console and the API can never drift apart.
 */
export { AUDIT_ACTION_FAMILIES, auditFamily, expandAuditActionFamily } from "@/lib/audit-families";
export type { AuditActionFamily } from "@/lib/audit-families";
