import {
  Archive,
  Ban,
  BellRing,
  CircleCheck,
  Download,
  Globe,
  KeyRound,
  Layers,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Store,
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
  "feature.override": { label: "بازنویسی پرچم ویژگی", tone: "info", icon: SlidersHorizontal },
  "impersonation.start": { label: "شروع دسترسی پشتیبانی", tone: "warning", icon: KeyRound },
  "impersonation.end": { label: "پایان دسترسی پشتیبانی", tone: "muted", icon: KeyRound },
  "impersonation.revoke": { label: "لغو دسترسی پشتیبانی", tone: "warning", icon: KeyRound },
  "support_session.started": { label: "شروع نشست پشتیبانی", tone: "warning", icon: KeyRound },
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
  "sms.managed_service.alert_acknowledged": {
    label: "تأیید هشدار پیامک",
    tone: "muted",
    icon: BellRing,
  },
};

export function auditMetaFor(action: string): ActionMeta {
  return ACTION_META[action] ?? { label: action, tone: "neutral", icon: CircleCheck };
}

/** The set of action families for the filter dropdown, in a stable order. */
export const AUDIT_ACTION_FAMILIES: { value: string; label: string }[] = [
  { value: "business", label: "کسب‌وکار" },
  { value: "feature", label: "ویژگی‌ها" },
  { value: "impersonation", label: "دسترسی پشتیبانی" },
  { value: "support_session", label: "نشست‌های پشتیبانی" },
  { value: "billing", label: "مالی" },
  { value: "backup", label: "پشتیبان‌گیری" },
  { value: "cms", label: "سایت‌ساز" },
  { value: "ai", label: "هوش مصنوعی" },
  // Issue #902 §6 — the managed-SMS actions, filterable on their own. The value
  // is the action prefix the API matches with `action LIKE '<value>%'`.
  { value: "sms", label: "پیامک مدیریت‌شده" },
];
