"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  inputClass,
} from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay } from "@/lib/phone";
import { roleLabel } from "@/lib/role-labels";
import { TwoFactorSettings } from "../two-factor-settings";

export interface ProfileSectionProps {
  fullName: string;
  phone?: string | null;
  email?: string | null;
  role: string;
  isOwner: boolean;
  canUseMfa?: boolean;
}

export function ProfileSection({
  fullName,
  phone,
  email,
  role,
  isOwner,
  canUseMfa = true,
}: ProfileSectionProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="مشخصات ورود"
        description="نام و نقش از سوی مدیر کسب‌وکار تعیین می‌شود."
      >
        <dl className="divide-y divide-border text-sm">
          <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
            <dt className="text-muted-foreground">نام</dt>
            <dd className="font-semibold text-foreground">{fullName || "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <dt className="text-muted-foreground">نقش</dt>
            <dd className="font-semibold text-foreground">{roleLabel(role)}</dd>
          </div>
          {email ? (
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-muted-foreground">ایمیل</dt>
              <dd dir="ltr" className="font-mono text-xs text-foreground">
                {email}
              </dd>
            </div>
          ) : null}
          {phone ? (
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-muted-foreground">شمارهٔ ورود</dt>
              <dd dir="ltr" className="font-semibold tabular-nums text-foreground">
                {toPersianDigits(formatPhoneDisplay(phone))}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-4 flex justify-end border-t border-border pt-4">
          <SecondaryButton onClick={signOut} disabled={signingOut}>
            {signingOut ? "در حال خروج…" : "خروج از حساب"}
          </SecondaryButton>
        </div>
      </SectionCard>

      {email ? <SelfPasswordCard /> : null}

      <SelfPhoneCard />

      {canUseMfa ? <TwoFactorSettings isOwner={isOwner} scope="personal" /> : null}

      <SelfSessionsCard
        onSignedOutEverywhere={() => {
          router.push("/login");
          router.refresh();
        }}
      />
    </div>
  );
}

const PASSWORD_ERROR_MESSAGES: Record<string, string> = {
  missing_current_password: "رمز عبور فعلی را وارد کنید.",
  invalid_current_password: "رمز عبور فعلی نادرست است.",
  password_confirmation_mismatch: "تکرار رمز عبور جدید با رمز جدید یکسان نیست.",
  password_unchanged: "رمز عبور جدید باید با رمز فعلی متفاوت باشد.",
  password_too_short: "رمز عبور جدید باید حداقل ۸ نویسه باشد.",
  password_too_long: "رمز عبور جدید بیش از حد طولانی است.",
  password_blank: "رمز عبور نمی‌تواند فقط فاصله باشد.",
};

function SelfPasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const lengthOk = newPassword.length >= 8;
  const matchOk = newPassword.length > 0 && newPassword === confirmPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!lengthOk) {
      setError(PASSWORD_ERROR_MESSAGES.password_too_short);
      return;
    }
    if (!matchOk) {
      setError(PASSWORD_ERROR_MESSAGES.password_confirmation_mismatch);
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ ok?: boolean; error?: string; message?: string }>(
      "/api/auth/password/self",
      {
        method: "POST",
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      },
    );
    setBusy(false);
    if (!ok) {
      setError(
        (data.error && PASSWORD_ERROR_MESSAGES[data.error]) ||
          data.message ||
          "تغییر رمز عبور ممکن نشد.",
      );
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setNotice(
      "رمز عبور شما با موفقیت تغییر یافت و سایر نشست‌های فعال در همهٔ دستگاه‌ها بسته شدند.",
    );
  }

  return (
    <SectionCard
      title="تغییر رمز عبور"
      description="تغییر رمز عبور سراسری شما بلافاصله تمام نشست‌های دیگر را در همهٔ دستگاه‌ها باطل می‌کند."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      <form onSubmit={submit} className="space-y-4">
        <Field label="رمز عبور فعلی">
          <input
            type="password"
            dir="ltr"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className={inputClass}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="رمز عبور جدید"
            hint={`حداقل ${toPersianDigits("8")} نویسه`}
          >
            <input
              type="password"
              dir="ltr"
              required
              minLength={8}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="تکرار رمز عبور جدید">
            <input
              type="password"
              dir="ltr"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <PrimaryButton
            type="submit"
            disabled={busy || !currentPassword || !lengthOk || !matchOk}
          >
            {busy ? "در حال ذخیره…" : "تغییر رمز عبور"}
          </PrimaryButton>
        </div>
      </form>
    </SectionCard>
  );
}

interface SelfSessionItem {
  id: string;
  locationId: string | null;
  locationName: string | null;
  deviceLabel: string | null;
  startedAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

function SelfSessionsCard({
  onSignedOutEverywhere,
}: {
  onSignedOutEverywhere: () => void;
}) {
  const [sessions, setSessions] = useState<SelfSessionItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpPassword, setStepUpPassword] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{ sessions?: SelfSessionItem[]; error?: string }>(
      "/api/sessions/self",
    );
    if (ok) {
      setSessions(data.sessions ?? []);
    } else {
      setError("بارگذاری نشست‌های فعال ممکن نشد.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revokeOne(sessionId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok } = await api("/api/sessions/self", {
      method: "DELETE",
      body: JSON.stringify({ action: "revoke_one", sessionId }),
    });
    setBusy(false);
    if (!ok) {
      setError("خاتمه دادن به نشست ممکن نشد.");
      return;
    }
    setNotice("نشست انتخاب‌شده خاتمه یافت.");
    await load();
  }

  async function revokeOthers() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, status, data } = await api<{ error?: string }>("/api/sessions/self", {
      method: "DELETE",
      body: JSON.stringify({ action: "revoke_others" }),
    });
    setBusy(false);
    if (!ok) {
      if (status === 403 && data.error === "recent_auth_required") {
        setStepUpOpen(true);
        return;
      }
      setError("خاتمه دادن به سایر نشست‌ها ممکن نشد.");
      return;
    }
    setNotice("تمام نشست‌های دیگر خاتمه یافتند.");
    await load();
  }

  async function revokeAll() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, status, data } = await api<{ error?: string }>("/api/sessions/self", {
      method: "DELETE",
      body: JSON.stringify({ action: "revoke_all" }),
    });
    setBusy(false);
    if (!ok) {
      if (status === 403 && data.error === "recent_auth_required") {
        setStepUpOpen(true);
        return;
      }
      setError("خروج از همهٔ دستگاه‌ها ممکن نشد.");
      return;
    }
    onSignedOutEverywhere();
  }

  async function submitStepUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok } = await api("/api/auth/step-up", {
      method: "POST",
      body: JSON.stringify({ password: stepUpPassword }),
    });
    setBusy(false);
    if (!ok) {
      setError("رمز عبور واردشده نادرست است.");
      return;
    }
    setStepUpOpen(false);
    setStepUpPassword("");
    setNotice("هویت شما تأیید شد؛ اکنون می‌توانید عملیات را تکرار کنید.");
  }

  return (
    <SectionCard
      title="نشست‌ها و دستگاه‌های فعال"
      description="فهرست نشست‌های باز حساب شما. می‌توانید نشست‌های دیگر را ببندید یا از همهٔ دستگاه‌ها خارج شوید."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {stepUpOpen ? (
        <form
          onSubmit={submitStepUp}
          className="mb-4 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
        >
          <p className="text-sm font-semibold">تأیید مجدد هویت</p>
          <Field label="رمز عبور فعلی">
            <input
              type="password"
              dir="ltr"
              required
              value={stepUpPassword}
              onChange={(e) => setStepUpPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          <div className="flex gap-2">
            <PrimaryButton type="submit" disabled={busy || !stepUpPassword}>
              تأیید
            </PrimaryButton>
            <SecondaryButton onClick={() => setStepUpOpen(false)}>انصراف</SecondaryButton>
          </div>
        </form>
      ) : null}

      {sessions === null ? (
        <LoadingSkeleton rows={2} />
      ) : (
        <div className="space-y-4">
          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              نشست فعالی در فهرست دستگاه‌ها ثبت نشده است.
            </p>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3 text-xs"
                >
                  <div>
                    <p className="font-semibold text-foreground">
                      {s.deviceLabel || "مرورگر وب"}
                      {s.isCurrent ? (
                        <span className="ms-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                          نشست فعلی
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {s.locationName ? `شعبه: ${s.locationName} · ` : ""}
                      آخرین فعالیت: {formatJalali(s.lastSeenAt, { withTime: true })}
                    </p>
                  </div>
                  {!s.isCurrent ? (
                    <SecondaryButton onClick={() => void revokeOne(s.id)} disabled={busy}>
                      خاتمه دادن
                    </SecondaryButton>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {sessions.some((s) => !s.isCurrent) ? (
              <SecondaryButton onClick={() => void revokeOthers()} disabled={busy}>
                خروج از سایر دستگاه‌ها
              </SecondaryButton>
            ) : null}
            <SecondaryButton onClick={() => void revokeAll()} disabled={busy}>
              خروج از همهٔ دستگاه‌ها
            </SecondaryButton>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

interface SelfPhoneStatus {
  phone: string | null;
  phoneState: "none" | "unverified" | "verified";
  otpWindowOpen?: boolean;
  recentAuth?: boolean;
  error?: string;
  message?: string;
}

const PHONE_ERROR_MESSAGES: Record<string, string> = {
  invalid_phone: "شمارهٔ موبایل معتبر نیست.",
  phone_missing: "شمارهٔ موبایل را وارد کنید.",
  invalid_code: "کد ۶ رقمی واردشده نادرست است.",
  rate_limited: "تعداد درخواست‌ها بیش از حد مجاز است؛ کمی صبر کنید.",
  sms_dispatch_failed: "ارسال پیامک ممکن نشد. کمی بعد دوباره تلاش کنید.",
  recent_auth_required: "برای تغییر شمارهٔ موبایل ورود، ابتدا هویت خود را مجدداً تأیید کنید.",
};

function SelfPhoneCard() {
  const [status, setStatus] = useState<SelfPhoneStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [maskedSentTo, setMaskedSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpPassword, setStepUpPassword] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<SelfPhoneStatus>("/api/auth/phone/self");
    if (ok) {
      setStatus(data);
    } else {
      setError(
        (data.error && PHONE_ERROR_MESSAGES[data.error]) ||
          "بارگذاری شمارهٔ موبایل ممکن نشد.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendOtp(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, status: httpStatus, data } = await api<{
      status?: string;
      maskedPhone?: string;
      error?: string;
      message?: string;
    }>("/api/auth/phone/self", {
      method: "POST",
      body: JSON.stringify({
        action: "send",
        phone: editing ? phoneInput.trim() : undefined,
      }),
    });
    setBusy(false);
    if (!ok) {
      if (httpStatus === 403 && data.error === "recent_auth_required") {
        setStepUpOpen(true);
        return;
      }
      setError(
        data.message ||
          (data.error && PHONE_ERROR_MESSAGES[data.error]) ||
          "ارسال کد تأیید ممکن نشد.",
      );
      return;
    }
    setMaskedSentTo(data.maskedPhone ?? phoneInput.trim());
    setCodeInput("");
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok, status: httpStatus, data } = await api<{
      status?: string;
      error?: string;
    }>("/api/auth/phone/self", {
      method: "POST",
      body: JSON.stringify({
        action: "verify",
        code: codeInput.trim(),
        phone: editing ? phoneInput.trim() : undefined,
      }),
    });
    setBusy(false);
    if (!ok) {
      if (httpStatus === 403 && data.error === "recent_auth_required") {
        setStepUpOpen(true);
        return;
      }
      setError(
        (data.error && PHONE_ERROR_MESSAGES[data.error]) ||
          "تأیید کد پیامکی ممکن نشد.",
      );
      return;
    }
    setMaskedSentTo(null);
    setEditing(false);
    setCodeInput("");
    setNotice("شمارهٔ موبایل ورود شما با موفقیت تأیید شد.");
    await load();
  }

  async function submitStepUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok } = await api("/api/auth/step-up", {
      method: "POST",
      body: JSON.stringify({ password: stepUpPassword }),
    });
    setBusy(false);
    if (!ok) {
      setError("رمز عبور واردشده نادرست است.");
      return;
    }
    setStepUpOpen(false);
    setStepUpPassword("");
    setNotice("هویت شما تأیید شد؛ اکنون می‌توانید شماره را ثبت یا تأیید کنید.");
  }

  const verified = status?.phoneState === "verified";

  return (
    <SectionCard
      title="شمارهٔ موبایل ورود"
      description="برای ورود با کد پیامکی و نگه‌داشتن رمز عددی روی دستگاه‌های معتبر."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {stepUpOpen ? (
        <form
          onSubmit={submitStepUp}
          className="mb-4 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
        >
          <p className="text-sm font-semibold">تأیید مجدد هویت برای تغییر شمارهٔ موبایل</p>
          <Field label="رمز عبور فعلی">
            <input
              type="password"
              dir="ltr"
              required
              value={stepUpPassword}
              onChange={(e) => setStepUpPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          <div className="flex gap-2">
            <PrimaryButton type="submit" disabled={busy || !stepUpPassword}>
              تأیید
            </PrimaryButton>
            <SecondaryButton onClick={() => setStepUpOpen(false)}>انصراف</SecondaryButton>
          </div>
        </form>
      ) : null}

      {!status ? (
        <LoadingSkeleton rows={2} />
      ) : maskedSentTo ? (
        <form onSubmit={verifyOtp} className="space-y-3">
          <p className="text-xs text-muted-foreground">
            کد ۶ رقمی ارسال‌شده به {toPersianDigits(maskedSentTo)} را وارد کنید:
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-44 flex-1">
              <input
                dir="ltr"
                inputMode="numeric"
                maxLength={6}
                required
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="123456"
                className={inputClass}
              />
            </div>
            <PrimaryButton type="submit" disabled={busy || codeInput.trim().length < 6}>
              تأیید کد
            </PrimaryButton>
            <SecondaryButton onClick={() => setMaskedSentTo(null)} disabled={busy}>
              انصراف
            </SecondaryButton>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          {!verified ? (
            <InfoBox>
              تا زمانی که شمارهٔ موبایل تأیید نشود، ورود با پیامک فعال نیست.
            </InfoBox>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              {status.phone ? (
                <p className="text-sm font-semibold">
                  <span dir="ltr">{toPersianDigits(formatPhoneDisplay(status.phone))}</span>
                  {verified ? (
                    <span className="ms-2 text-xs font-normal text-emerald-600 dark:text-emerald-400">
                      تأییدشده
                    </span>
                  ) : (
                    <span className="ms-2 text-xs font-normal text-amber-600 dark:text-amber-400">
                      تأییدنشده
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">هنوز شماره‌ای ثبت نشده است.</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {status.phone && !verified ? (
                <PrimaryButton onClick={() => void sendOtp()} disabled={busy}>
                  ارسال کد تأیید
                </PrimaryButton>
              ) : null}
              <SecondaryButton
                onClick={() => {
                  setEditing((v) => !v);
                  setPhoneInput(status.phone ?? "");
                  setError(null);
                }}
                disabled={busy}
              >
                {status.phone ? "تغییر شماره" : "ثبت شماره"}
              </SecondaryButton>
            </div>
          </div>

          {editing ? (
            <form onSubmit={sendOtp} className="flex flex-wrap items-end gap-2 pt-2">
              <div className="min-w-56 flex-1">
                <Field
                  label="شمارهٔ موبایل"
                  hint="یک کد پیامکی برای تأیید این شماره ارسال می‌شود."
                >
                  <input
                    dir="ltr"
                    inputMode="tel"
                    required
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    placeholder="09121234567"
                    className={inputClass}
                  />
                </Field>
              </div>
              <PrimaryButton type="submit" disabled={busy || !phoneInput.trim()}>
                ارسال کد تأیید
              </PrimaryButton>
            </form>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
