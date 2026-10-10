"use client";

import { useEffect, useState } from "react";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import { useRouter } from "next/navigation";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "../../dashboard/ui";
import { MfaStep, TENANT_MFA_THEME, type MfaMethod } from "@/components/auth/mfa-step";
import { roleLabel } from "@/lib/role-labels";

interface Preview {
  businessName: string;
  email: string;
  fullName: string;
  role: string;
  hasExistingLogin: boolean;
}

/** What `/api/auth/accept-invite` answers beyond a plain success (#854 P0.4). */
interface AcceptResponse {
  error?: string;
  mfaRequired?: boolean;
  mfaToken?: string;
  mfaMethod?: MfaMethod | null;
  availableMethods?: MfaMethod[];
  mfaState?: string;
}

export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mfa, setMfa] = useState<{
    token: string;
    method: MfaMethod | null;
    availableMethods: MfaMethod[];
  } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api<Preview & { error?: string }>(
        `/api/auth/accept-invite?token=${encodeURIComponent(token)}`,
      );
      if (res.ok) setPreview(res.data);
      else setError(errorMessage(res.data.error));
      setLoading(false);
    })();
  }, [token]);

  async function accept() {
    setBusy(true);
    setError("");
    const res = await api<AcceptResponse>("/api/auth/accept-invite", {
      method: "POST",
      body: JSON.stringify({ token, password: password || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    /**
     * Issue #854 (P0.4) — the second factor, which this screen used to skip.
     *
     * An invitee whose role or account needs MFA gets `{ mfaRequired, mfaToken }`
     * with **no session cookie**; treating the 200 as success sent them to
     * `/dashboard`, where the middleware bounced them to the login screen — the
     * same "res.ok means signed in" mistake the password door had (#854 P1.19).
     * The membership is not written until the factor checks out: the pending
     * token carries the invitation, and `/api/auth/mfa/verify` completes the
     * acceptance on its success path.
     */
    if (res.data.mfaRequired && res.data.mfaToken) {
      setMfa({
        token: res.data.mfaToken,
        method: res.data.mfaMethod ?? null,
        availableMethods: res.data.availableMethods ?? [],
      });
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  if (loading) return <FormLoadingSkeleton rows={3} className="p-8" label="در حال بارگذاری دعوت‌نامه" />;

  if (mfa) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-8">
        <h1 className="text-xl font-bold">تأیید دومرحله‌ای</h1>
        <p className="text-sm text-muted-foreground">
          برای تکمیل پذیرش دعوت، عامل دوم حساب خود را تأیید کنید.
        </p>
        <MfaStep
          mfaToken={mfa.token}
          mfaMethod={mfa.method}
          availableMethods={mfa.availableMethods}
          theme={TENANT_MFA_THEME}
          onVerified={() => {
            // The acceptance was completed server-side on the same call that
            // verified the factor, and the session cookie is already set.
            router.push("/dashboard");
            router.refresh();
          }}
          onCancel={() => {
            setMfa(null);
            setError("پذیرش دعوت کامل نشد؛ برای ادامه دوباره تلاش کنید.");
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 p-8">
      <h1 className="text-xl font-bold">دعوت به همکاری</h1>
      <ErrorBox>{error}</ErrorBox>

      {preview && (
        <>
          <InfoBox>
            شما به‌عنوان «{roleLabel(preview.role)}» به «{preview.businessName}»
            دعوت شده‌اید.
          </InfoBox>

          <Field label="ایمیل">
            <input className={inputClass} dir="ltr" readOnly value={preview.email} />
          </Field>

          {preview.hasExistingLogin ? (
            // They already have a platform login — this only adds a membership,
            // and their existing password keeps working unchanged.
            <InfoBox>
              این ایمیل از قبل حساب دارد. با پذیرش دعوت، این کسب‌وکار به حساب فعلی شما اضافه می‌شود
              و رمز عبورتان تغییر نمی‌کند.
            </InfoBox>
          ) : (
            <Field label="رمز عبور (حداقل ۸ نویسه)">
              <input
                className={inputClass}
                dir="ltr"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}

          <PrimaryButton
            onClick={accept}
            disabled={busy || (!preview.hasExistingLogin && password.length < 8)}
          >
            پذیرش دعوت
          </PrimaryButton>
        </>
      )}
    </div>
  );
}
