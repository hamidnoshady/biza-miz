"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  api,
  errorMessage,
  inputClass,
} from "../dashboard/ui";

interface ResetPreview {
  email: string;
  subjectRealm: "platform_user" | "platform_admin";
  expiresAt: string;
  status: "pending" | "expired" | "used" | "revoked";
}

function ResetPasswordInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("لینک بازیابی رمز عبور معتبر نیست.");
      setLoading(false);
      return;
    }
    void (async () => {
      const res = await api<ResetPreview & { error?: string }>(
        `/api/auth/password-reset?token=${encodeURIComponent(token)}`,
      );
      if (res.ok) {
        setPreview(res.data);
        if (res.data.status !== "pending") {
          setError("این لینک بازیابی رمز عبور منقضی شده یا قبلاً استفاده شده است.");
        }
      } else {
        setError(errorMessage(res.data.error));
      }
      setLoading(false);
    })();
  }, [token]);

  async function submit() {
    if (password.length < 8) {
      setError("رمز عبور جدید باید حداقل ۸ نویسه باشد.");
      return;
    }
    if (password !== confirmPassword) {
      setError("تکرار رمز عبور جدید با رمز عبور هم‌خوانی ندارد.");
      return;
    }
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>("/api/auth/password-reset", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    setDone(true);
  }

  if (loading) {
    return (
      <FormLoadingSkeleton
        rows={3}
        className="mx-auto max-w-md p-8"
        label="در حال بررسی لینک بازیابی رمز عبور"
      />
    );
  }

  const loginHref = preview?.subjectRealm === "platform_admin" ? "/platform/login" : "/admin";

  return (
    <div className="mx-auto max-w-md space-y-4 p-8">
      <h1 className="text-xl font-bold">تنظیم رمز عبور جدید</h1>
      <ErrorBox>{error}</ErrorBox>

      {done ? (
        <div className="space-y-4">
          <InfoBox>
            رمز عبور جدید با موفقیت ثبت شد و همهٔ نشست‌های قبلی حساب بسته شدند. اکنون می‌توانید با رمز
            تازه وارد شوید.
          </InfoBox>
          <a
            href={loginHref}
            className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:ring"
          >
            رفتن به صفحهٔ ورود
          </a>
        </div>
      ) : preview && preview.status === "pending" ? (
        <>
          <Field label="ایمیل حساب">
            <input className={inputClass} dir="ltr" readOnly value={preview.email} />
          </Field>
          <Field label="رمز عبور جدید (حداقل ۸ نویسه)">
            <input
              className={inputClass}
              dir="ltr"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="تکرار رمز عبور جدید">
            <input
              className={inputClass}
              dir="ltr"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </Field>
          <PrimaryButton
            onClick={() => void submit()}
            disabled={busy || password.length < 8 || confirmPassword.length < 8}
          >
            {busy ? "در حال ثبت…" : "ثبت رمز عبور جدید"}
          </PrimaryButton>
        </>
      ) : null}
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <FormLoadingSkeleton
          rows={3}
          className="mx-auto max-w-md p-8"
          label="در حال بارگذاری"
        />
      }
    >
      <ResetPasswordInner />
    </Suspense>
  );
}
