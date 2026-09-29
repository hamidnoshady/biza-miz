import {
  Archive,
  Ban,
  CircleCheck,
  Globe,
  KeyRound,
  Layers,
  Pencil,
  RotateCcw,
  SlidersHorizontal,
  Store,
  Trash2,
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
  "business.delete": { label: "حذف قطعی", tone: "danger", icon: Trash2 },
  "business.delete.requested": { label: "درخواست حذف قطعی", tone: "warning", icon: Trash2 },
  "business.delete.completed": { label: "حذف قطعی انجام شد", tone: "danger", icon: Trash2 },
  "business.delete.failed": { label: "حذف قطعی ناموفق", tone: "danger", icon: Trash2 },
  "business.reset": { label: "ریست کامل کسب‌وکار", tone: "danger", icon: RotateCcw },
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
];
