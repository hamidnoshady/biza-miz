"use client";

/**
 * Issue #947 (TEAM-F08) — one member detail surface.
 *
 * The Team screen's cards answer «what is this member, exactly» badly by construction: a
 * row of action buttons says what can be *changed* and nothing about what is true. This
 * dialog is the reading surface — membership state, the role and capabilities in force,
 * the login and its credentials, the personnel file and whether the platform still owes
 * one, the finance door, and when all of it started.
 *
 * ## Why it reads rather than writes
 *
 * Every mutation here is the dialog the API already owns (`MemberEditorDialog`,
 * `PhoneEditorDialog`, `CredentialsEditorDialog`, the file-link dialog, the rehire
 * ceremony). This surface *opens* them, so there is one writer per operation and this file
 * cannot drift from what the routes accept — the failure mode of a second editor is a
 * second opinion about validation, and that is what the issue is about.
 *
 * ## Permissions
 *
 * The sections adapt to what the reader may do, not to what would look tidy: a
 * `team.view` visit gets the same facts and no buttons, and the finance door appears only
 * with `payroll.view` because that is what the screen behind it enforces. None of this is
 * a security gate — every route re-checks — but offering a button whose only outcome is a
 * 403 is a lie about the interface.
 */
import Link from "next/link";
import { PERMISSIONS } from "@/lib/permissions";
import { roleLabel } from "@/lib/role-labels";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay } from "@/lib/phone";
import { accountingSectionHref } from "@/app/(app)/accounting/accounting-routes";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoBox, PrimaryButton, SecondaryButton } from "../ui";

/** The drift row shape `GET /api/team` reports (see team-manager.tsx). */
export interface PersonnelFileDriftNotice {
  userId: string;
  fullName: string;
  reason: "file_missing" | "identity_stale";
  lastError: string | null;
  attempts: number;
  lastAttemptAt: string;
}

/** The member fields this surface reads — a subset of the roster's `Member`. */
export interface MemberDetailSubject {
  id: string;
  fullName: string;
  email: string | null;
  role: string;
  customRoleName: string | null;
  isActive: boolean;
  status: string;
  locationScope: "all" | "selected" | "home" | "none" | null;
  locationIds: string[];
  defaultLocationId: string | null;
  hasPin: boolean;
  hasLogin: boolean;
  phone: string | null;
  phoneVerified: boolean;
  effectivePermissions: string[];
  createdAt: string;
  personnelFileId: string | null;
  personnelFileDrift: boolean;
}

const SCOPE_LABELS: Record<NonNullable<MemberDetailSubject["locationScope"]>, string> = {
  all: "همهٔ شعبه‌ها",
  selected: "شعبه‌های انتخابی",
  home: "فقط شعبهٔ اصلی",
  none: "بدون دسترسی شعبه",
};

const STATUS_LABELS: Record<MemberDetailSubject["status"], string> = {
  active: "فعال",
  suspended: "معلق",
  offboarded: "قطع همکاری",
};

/** One labelled block; the same shape in all six sections, so they read as one surface. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border/80 p-3 sm:p-4">
      <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
      <dl className="space-y-2">{children}</dl>
    </section>
  );
}

export function MemberDetailDialog({
  member,
  locationName,
  drift,
  isSelf,
  canManage,
  canManageOwners,
  permissions,
  onClose,
  onEdit,
  onEditPhone,
  onEditCredentials,
  onLinkFile,
  onOpenFiles,
  onRehire,
}: {
  member: MemberDetailSubject;
  /** branch id → name, from the same `GET /api/team` payload the roster uses. */
  locationName: (id: string) => string | null;
  /** The member's open drift episode, when the roster reported one. */
  drift: PersonnelFileDriftNotice | null;
  isSelf: boolean;
  canManage: boolean;
  canManageOwners: boolean;
  /** The reader's effective permission keys. */
  permissions: readonly string[];
  onClose: () => void;
  onEdit: () => void;
  onEditPhone: () => void;
  onEditCredentials: () => void;
  onLinkFile: () => void;
  onOpenFiles: () => void;
  onRehire: () => void;
}) {
  const statusLabel = STATUS_LABELS[member.status] ?? member.status;
  const editable = canManage && (canManageOwners || member.role !== "owner");
  const branches =
    member.locationIds.length > 0
      ? member.locationIds.map((id) => locationName(id) ?? id).join("، ")
      : "—";
  const defaultBranch = member.defaultLocationId
    ? (locationName(member.defaultLocationId) ?? member.defaultLocationId)
    : "—";

  /*
   * How this member signs in. Three states, because «has a PIN» and «has an account» are
   * different facts and the roster used to leave the second one to be inferred from
   * whether an email was present.
   */
  const signIn = member.hasLogin
    ? member.email
      ? `حساب کاربری با ایمیل ${member.email}`
      : "حساب کاربری متصل به هویت ابری"
    : member.hasPin
      ? "ورود با رمز عددی روی دستگاه مشترک (بدون حساب کاربری)"
      : "بدون اعتبارنامهٔ ورود";

  const fileState = member.personnelFileId
    ? drift
      ? { tone: "warn" as const, text: "ثبت شده — اما با حساب کاربری هم‌خوان نیست" }
      : { tone: "ok" as const, text: "ثبت شده و با حساب کاربری هم‌خوان است" }
    : member.personnelFileDrift
      ? { tone: "warn" as const, text: "در انتظار ساخت — پلتفرم این پرونده را بدهکار است" }
      : { tone: "muted" as const, text: "پرونده‌ای ثبت نشده است" };

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>{member.fullName}</span>
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-normal text-muted-foreground">
              {statusLabel}
            </span>
            {isSelf ? (
              <span className="text-xs font-normal text-muted-foreground">(شما)</span>
            ) : null}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <DetailSection title="نمای کلی">
            <DetailRow label="نقش">{member.customRoleName ?? roleLabel(member.role)}</DetailRow>
            <DetailRow label="ورود">{signIn}</DetailRow>
            <DetailRow label="شمارهٔ موبایل">
              {member.phone ? (
                <>
                  <span dir="ltr">{toPersianDigits(formatPhoneDisplay(member.phone))}</span>
                  {member.phoneVerified ? (
                    <span className="ms-2 text-xs text-emerald-600 dark:text-emerald-400">
                      تأییدشده
                    </span>
                  ) : null}
                </>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="عضویت از">
              {toPersianDigits(formatJalali(new Date(member.createdAt)))}
            </DetailRow>
          </DetailSection>

          <DetailSection title="دسترسی">
            <DetailRow label="نقش پایه">
              {roleLabel(member.role)}
              {member.customRoleName ? ` + نقش اختصاصی «${member.customRoleName}»` : ""}
            </DetailRow>
            <DetailRow label="شعبه‌ها">
              {member.locationScope ? `${SCOPE_LABELS[member.locationScope]} — ` : ""}
              {branches}
            </DetailRow>
            <DetailRow label="شعبهٔ اصلی">{defaultBranch}</DetailRow>
            <DetailRow label={`دسترسی‌های مؤثر (${toPersianDigits(String(member.effectivePermissions.length))})`}>
              {/*
                The count is what matters at a glance; the keys are for the owner who is
                about to change them. A list is the honest rendering — a summary sentence
                («دسترسی کامل») would be a second vocabulary for the same facts.
              */}
              <span className="block max-h-32 overflow-y-auto text-xs leading-6 text-muted-foreground">
                {member.effectivePermissions.join("، ") || "—"}
              </span>
            </DetailRow>
          </DetailSection>

          <DetailSection title="ورود و اعتبارنامه">
            <DetailRow label="وضعیت">{{ active: "فعال", suspended: "معلق", offboarded: "قطع همکاری" }[member.status] ?? statusLabel}</DetailRow>
            <DetailRow label="رمز عددی">{member.hasPin ? "تنظیم شده" : "تنظیم نشده"}</DetailRow>
            <DetailRow label="حساب کاربری">
              {member.hasLogin ? "دارد" : "ندارد (کارمند رمز عددی)"}
            </DetailRow>
          </DetailSection>

          <DetailSection title="پروندهٔ پرسنلی">
            <DetailRow label="وضعیت">
              <span
                className={
                  fileState.tone === "ok"
                    ? "text-emerald-700 dark:text-emerald-300"
                    : fileState.tone === "warn"
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-muted-foreground"
                }
              >
                {fileState.text}
              </span>
            </DetailRow>
            {drift ? (
              <DetailRow label="آخرین تلاش">
                {drift.reason === "identity_stale" ? "شناسهٔ ناهمخوان" : "پروندهٔ ناقص"}
                {drift.attempts > 1
                  ? ` — ${toPersianDigits(String(drift.attempts))} تلاش`
                  : ""}
                {drift.lastError ? ` (${drift.lastError})` : ""}
              </DetailRow>
            ) : null}
            <DetailRow label="یادداشت">
              این پرونده در فهرست «پروندهٔ کارکنان» است؛ اطلاعات حسابداری و تماس او همان‌جاست.
              فیلدهای حساس پرونده (کد ملی، نشانی، یادداشت‌ها) برای دسترسی «مشاهدهٔ تیم» نمایش داده نمی‌شوند.
            </DetailRow>
          </DetailSection>

          <DetailSection title="مالی">
            <DetailRow label="حقوق و دستمزد">
              {permissions.includes(PERMISSIONS.payrollView) ? (
                <Link className="underline" href={accountingSectionHref("payroll")}>
                  مشاهدهٔ کارمزد، دستمزد و مساعده در حسابداری
                </Link>
              ) : (
                "برای مشاهدهٔ اطلاعات حقوق و دستمزد به دسترسی «مشاهدهٔ حقوق و دستمزد» نیاز دارید."
              )}
            </DetailRow>
          </DetailSection>

          <DetailSection title="تاریخچه">
            <DetailRow label="تغییرات">
              تغییر نقش، دسترسی، شعبه و تعلیق/قطع همکاری با نام عامل و دلیل ثبت می‌شود.
              {permissions.includes(PERMISSIONS.teamManage) ? (
                <>
                  {" "}
                  <Link className="underline" href="/settings/audit-log">
                    مشاهدهٔ گزارش حسابرسی
                  </Link>
                </>
              ) : null}
            </DetailRow>
          </DetailSection>
        </div>

        <DialogFooter className="flex-wrap gap-2 sm:justify-start">
          {editable ? (
            <>
              <PrimaryButton
                onClick={() => {
                  onClose();
                  onEdit();
                }}
              >
                ویرایش نقش و دسترسی
              </PrimaryButton>
              <SecondaryButton
                onClick={() => {
                  onClose();
                  onEditPhone();
                }}
              >
                شمارهٔ موبایل
              </SecondaryButton>
              <SecondaryButton
                onClick={() => {
                  onClose();
                  onEditCredentials();
                }}
              >
                رمز ورود و نشست‌ها
              </SecondaryButton>
            </>
          ) : null}
          {editable && !member.personnelFileId ? (
            <SecondaryButton
              onClick={() => {
                onClose();
                onLinkFile();
              }}
            >
              اتصال پروندهٔ پرسنلی
            </SecondaryButton>
          ) : null}
          {editable && member.status === "offboarded" ? (
            <SecondaryButton
              onClick={() => {
                onClose();
                onRehire();
              }}
            >
              بازگشت به کار
            </SecondaryButton>
          ) : null}
          <SecondaryButton
            onClick={() => {
              onClose();
              onOpenFiles();
            }}
          >
            پروندهٔ کارکنان
          </SecondaryButton>
          <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
        </DialogFooter>

        {isSelf && canManage ? (
          <InfoBox>
            این حساب خودِ شماست. برای شمارهٔ ورود، نشست‌ها و امنیت حساب، «پروفایل من» در
            تنظیمات، مسیر خودسرویس شماست.
          </InfoBox>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
