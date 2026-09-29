"use client";

/**
 * Owner & manager profiles of one business (issue #755 §1).
 *
 * A list rather than a single-owner card on purpose: a business can have more
 * than one login-holding member, and the surface has to keep working when it
 * does. Only the fields the console may safely change are editable; everything
 * else (the platform user id, the identity's active flag, the membership's
 * creation date, the recovery-code count) is reported as state.
 *
 * Two fields are consequential, for the same reason: the email *is* the login,
 * and the mobile *is* the second factor, and both belong to a global identity
 * shared with the person's other businesses. Editing either from one business
 * changes it for all of them — the email invalidates their sessions everywhere,
 * the phone redirects the channel that protects them everywhere. So both ask
 * for an explicit confirmation when the identity reaches beyond this business,
 * and the server refuses either change without it.
 */
import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { roleLabel } from "@/lib/role-labels";
import { api, errorMessage, Button, Card, ErrorBox, Field, InfoBox, SkeletonRows, inputClass, useCan } from "../../ui";
import { useBusiness } from "./context";

interface OwnerProfileMfa {
  method: "sms_otp" | "totp" | null;
  phoneE164: string | null;
  confirmedAt: string | null;
  graceUntil: string | null;
  recoveryCodesRemaining: number;
}

interface OwnerProfile {
  membershipId: string;
  role: string;
  membershipActive: boolean;
  membershipCreatedAt: string;
  fullName: string;
  platformUserId: string | null;
  email: string | null;
  identityActive: boolean;
  identityCreatedAt: string | null;
  lastLoginAt: string | null;
  membershipCount: number;
  otherBusinesses: { id: string; name: string }[];
  mfa: OwnerProfileMfa;
  branchAccess: { locationId: string | null; locationName: string | null };
}

const MFA_LABELS: Record<string, string> = {
  sms_otp: "پیامک یک‌بارمصرف",
  totp: "برنامهٔ Authenticator",
};

function fmt(iso: string | null): string {
  return iso ? formatJalali(iso, { withMonthName: true, withTime: true }) : "—";
}

export function OwnerProfilesPanel() {
  const { id, version, setNotice } = useBusiness();
  const can = useCan();
  const editable = can("business.edit");

  const [profiles, setProfiles] = useState<OwnerProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ profiles?: OwnerProfile[]; error?: string }>(
      `/api/platform/businesses/${id}/owner`,
    );
    if (ok) setProfiles(data.profiles ?? []);
    else setError(errorMessage(data.error));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, version]);

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {profiles === null ? (
        <Card title="مالک و مدیران">
          <SkeletonRows rows={3} />
        </Card>
      ) : profiles.length === 0 ? (
        <Card title="مالک و مدیران">
          <p className="text-sm text-muted-foreground">
            عضوی با نقش مالک یا مدیر برای این کسب‌وکار ثبت نشده است.
          </p>
        </Card>
      ) : (
        profiles.map((profile) => (
          <ProfileCard
            key={profile.membershipId}
            businessId={id}
            profile={profile}
            editable={editable}
            open={editing === profile.membershipId}
            onOpen={() => setEditing(profile.membershipId)}
            onClose={() => setEditing(null)}
            onSaved={(message) => {
              setNotice(message);
              setEditing(null);
              void load();
            }}
          />
        ))
      )}
      <InfoBox>
        این بخش هویت ورود و عضویت را نشان می‌دهد؛ رمز عبور، کلید دومرحله‌ای و کدهای بازیابی هرگز
        نمایش داده نمی‌شوند. تغییر نشانی ورود، هویت سراسری را جابه‌جا می‌کند و اگر فرد در چند
        کسب‌وکار عضو باشد به تأیید صریح نیاز دارد.
      </InfoBox>
    </div>
  );
}

function ProfileCard({
  businessId,
  profile,
  editable,
  open,
  onOpen,
  onClose,
  onSaved,
}: {
  businessId: string;
  profile: OwnerProfile;
  editable: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const mfa = profile.mfa;
  const mfaSummary = mfa.method
    ? `${MFA_LABELS[mfa.method]}${mfa.confirmedAt ? "" : " (تأییدنشده)"}`
    : "فعال نیست";

  return (
    <Card title={`${profile.fullName} — ${roleLabel(profile.role)}`}>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Row label="نشانی ورود (ایمیل)" value={profile.email ?? "—"} ltr />
        <Row label="شمارهٔ موبایل" value={mfa.phoneE164 ?? "ثبت نشده"} ltr />
        <Row
          label="شناسهٔ کاربر سکو"
          value={profile.platformUserId ? profile.platformUserId.slice(0, 8) : "—"}
          ltr
        />
        <Row
          label="وضعیت حساب"
          value={profile.membershipActive ? "فعال" : "غیرفعال"}
          tone={profile.membershipActive ? "ok" : "danger"}
        />
        <Row label="وضعیت عضویت" value={profile.membershipActive ? "فعال" : "غیرفعال"} />
        <Row label="تاریخ ایجاد عضویت" value={fmt(profile.membershipCreatedAt)} />
        <Row label="آخرین ورود" value={fmt(profile.lastLoginAt)} />
        <Row label="ورود دومرحله‌ای" value={mfaSummary} />
        <Row
          label="کدهای بازیابی باقی‌مانده"
          value={toPersianDigits(mfa.recoveryCodesRemaining)}
        />
        <Row
          label="شعبه‌ها"
          value={profile.branchAccess.locationName ?? "همهٔ شعبه‌ها"}
        />
        <Row
          label="کسب‌وکارهای دیگر"
          value={
            profile.membershipCount > 1
              ? `${formatPersianNumber(profile.membershipCount - 1)} کسب‌وکار دیگر`
              : "فقط همین کسب‌وکار"
          }
        />
        <Row label="مالک کسب‌وکار" value={profile.role === "owner" ? "بله" : "خیر"} />
      </dl>

      {profile.otherBusinesses.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          عضویت‌های دیگر:{" "}
          {profile.otherBusinesses.map((business) => business.name).join("، ")}
        </p>
      ) : null}

      {mfa.method === null ? (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-900 dark:text-amber-100">
          ورود دومرحله‌ای برای این حساب فعال نشده است.
        </p>
      ) : mfa.phoneE164 && !mfa.confirmedAt ? (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-900 dark:text-amber-100">
          شمارهٔ تأییدنشده: بازنشانی یا تغییر شماره، تأیید دوباره می‌خواهد.
        </p>
      ) : null}

      {editable ? (
        <div className="mt-4">
          {open ? (
            <EditForm businessId={businessId} profile={profile} onCancel={onClose} onSaved={onSaved} />
          ) : (
            <Button variant="ghost" onClick={onOpen}>
              ویرایش پروفایل
            </Button>
          )}
        </div>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          ویرایش پروفایل به دسترسی «ویرایش کسب‌وکار» نیاز دارد.
        </p>
      )}
    </Card>
  );
}

function Row({
  label,
  value,
  ltr,
  tone,
}: {
  label: string;
  value: string;
  ltr?: boolean;
  tone?: "ok" | "danger";
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`mt-0.5 ${tone === "danger" ? "text-red-700 dark:text-red-300" : "text-foreground"}`}
        {...(ltr ? { dir: "ltr" } : {})}
      >
        {value}
      </dd>
    </div>
  );
}

function EditForm({
  businessId,
  profile,
  onCancel,
  onSaved,
}: {
  businessId: string;
  profile: OwnerProfile;
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const [fullName, setFullName] = useState(profile.fullName);
  const [email, setEmail] = useState(profile.email ?? "");
  const [phone, setPhone] = useState(profile.mfa.phoneE164 ?? "");
  const [active, setActive] = useState(profile.membershipActive);
  const [reason, setReason] = useState("");
  const [confirmCrossBusiness, setConfirmCrossBusiness] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== (profile.email ?? "");
  // The SMS factor lives on the identity, exactly like the email: one person,
  // one number, every business they belong to. So a phone edit that reaches
  // beyond this business needs the same explicit yes — see
  // platform-owner-profile.ts.
  const phoneChanged = phone.trim() !== (profile.mfa.phoneE164 ?? "");
  const needsCrossBusiness = (emailChanged || phoneChanged) && profile.membershipCount > 1;

  async function save() {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ notices?: string[]; error?: string }>(
      `/api/platform/businesses/${businessId}/owner`,
      {
        method: "PATCH",
        body: JSON.stringify({
          membershipId: profile.membershipId,
          fullName: fullName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          isActive: active,
          confirmCrossBusiness,
          reason: reason.trim() || undefined,
        }),
      },
    );
    setBusy(false);
    if (ok) {
      onSaved(data.notices?.length ? data.notices.join(" ") : "پروفایل به‌روزرسانی شد.");
      return;
    }
    setError(
      data.error === "cross_business_confirmation_required"
        ? "این هویت در چند کسب‌وکار عضو است؛ برای تغییر نشانی ورود یا شمارهٔ موبایل باید تأیید کنید."
        : data.error === "email_taken"
          ? "این نشانی ورود قبلاً برای شخص دیگری ثبت شده است."
          : data.error === "invalid_email"
            ? "نشانی ایمیل معتبر نیست."
            : data.error === "invalid_phone"
              ? "شمارهٔ موبایل معتبر نیست (مثلاً ۰۹۱۲۳۴۵۶۷۸۹)."
              : data.error === "no_changes"
                ? "تغییری برای ثبت وجود ندارد."
                : errorMessage(data.error),
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <ErrorBox>{error}</ErrorBox>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="نام و نام خانوادگی">
          <input className={inputClass} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="نشانی ورود (ایمیل)" hint="هویت سراسری — روی همهٔ کسب‌وکارهای این فرد اثر می‌گذارد.">
          <input className={inputClass} dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field
          label="شمارهٔ موبایل (ورود دومرحله‌ای)"
          hint="هویت سراسری — این شماره برای همهٔ کسب‌وکارهای این فرد استفاده می‌شود. خالی‌گذاشتن، شماره را برمی‌دارد؛ شمارهٔ تازه باید دوباره تأیید شود."
        >
          <input className={inputClass} dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="دلیل تغییر (اختیاری، در تاریخچه ثبت می‌شود)">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          className="size-4"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        عضویت فعال است (با غیرفعال‌کردن، دسترسی این کسب‌وکار بسته می‌شود)
      </label>

      {needsCrossBusiness ? (
        <label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-900 dark:text-amber-100">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={confirmCrossBusiness}
            onChange={(e) => setConfirmCrossBusiness(e.target.checked)}
          />
          <span>
            تأیید می‌کنم هویت سراسری این فرد تغییر کند. او در {formatPersianNumber(profile.membershipCount)}{" "}
            کسب‌وکار عضو است؛ این تغییر روی همهٔ آن‌ها اثر می‌گذارد
            {emailChanged ? "، نشست‌هایش باطل می‌شوند و ورود بعدی با نشانی تازه انجام می‌شود" : " و ورود دومرحله‌ای‌اش تا تأیید شمارهٔ تازه کامل نیست"}.
          </span>
        </label>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={busy || (needsCrossBusiness && !confirmCrossBusiness)}>
          {busy ? "در حال ثبت…" : "ثبت تغییرات"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          انصراف
        </Button>
      </div>
    </div>
  );
}
