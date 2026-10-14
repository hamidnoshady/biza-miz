"use client";

import { useEffect, useState } from "react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, inputClass } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { readDeviceToken } from "@/lib/device-token";
import { RECENT_AUTH_MESSAGE, StepUpPrompt } from "@/components/auth/step-up-prompt";
import { SecurityConfirmDialog } from "@/components/auth/security-confirm-dialog";
import type { CredentialSurface } from "@/lib/credential-authority";

interface Credential {
  id: string;
  label: string | null;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Issue #854 (P2.28) — the one WebAuthn/biometric-credential manager.
 *
 * Before this component existed, credential management lived only inside the
 * sidebar's `BiometricPanel` overlay: staff on PIN roles had no way to reach
 * it from `/settings/profile`, and the profile page had no biometric surface
 * at all. This card body is what the profile page renders canonically; the
 * sidebar shortcut now links there instead of owning a second copy.
 *
 * Server authority is unchanged: the component only talks to the WebAuthn
 * routes, and the routes enforce recent-auth and the deployment's credential
 * authority (`webauthn_credential` is writable on every profile — it is
 * device-bound and local by definition). The `surface` prop keeps the
 * read-only contract the other profile cards follow, should that ever change.
 */
export function WebAuthnManager({ surface }: { surface?: CredentialSurface }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  /**
   * Issue #854 (P2.26) — removing a credential is destructive; the removal
   * waits behind the confirmation dialog, and only its confirm path sends the
   * DELETE. Cancelling sends nothing.
   */
  const [pendingRemove, setPendingRemove] = useState<Credential | null>(null);
  /**
   * The action waiting behind a step-up prompt. Held here rather than in the
   * prompt so that `register`/`remove` stay the only code that talks to the
   * WebAuthn routes — the prompt's job is to refresh the session, not to
   * replay a half-finished ceremony.
   */
  const [stepUpFor, setStepUpFor] = useState<
    { kind: "register" } | { kind: "remove"; id: string } | null
  >(null);

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);

  async function load() {
    try {
      const res = await fetch("/api/auth/webauthn/credentials");
      if (res.ok) {
        const data: { credentials: Credential[] } = await res.json();
        setCredentials(data.credentials);
      } else {
        setCredentials([]);
        setError("بارگذاری دستگاه‌های ثبت‌شده ممکن نشد.");
      }
    } catch {
      setCredentials([]);
      setError("بارگذاری دستگاه‌های ثبت‌شده ممکن نشد.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  /**
   * The one refusal this panel can resolve on its own: `403
   * recent_auth_required` from a stale recent-auth window (issue #854 P1.8
   * made adding and removing a biometric credential a sensitive action).
   */
  async function isStaleRecentAuth(res: Response): Promise<boolean> {
    if (res.status !== 403) return false;
    try {
      const body: { error?: string } = await res.json();
      return body.error === "recent_auth_required";
    } catch {
      return false;
    }
  }

  async function register({ afterStepUp = false }: { afterStepUp?: boolean } = {}) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const optionsRes = await fetch("/api/auth/webauthn/register/options", { method: "POST" });
      if (await isStaleRecentAuth(optionsRes)) {
        setStepUpFor({ kind: "register" });
        return;
      }
      if (!optionsRes.ok) throw new Error("options_failed");
      const { options, challengeToken } = await optionsRes.json();

      const response = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/webauthn/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response,
          challengeToken,
          deviceLabel: label.trim() || undefined,
          deviceToken: readDeviceToken(),
        }),
      });
      if (await isStaleRecentAuth(verifyRes)) {
        setStepUpFor({ kind: "register" });
        return;
      }
      if (!verifyRes.ok) throw new Error("verify_failed");

      setLabel("");
      setNotice("دستگاه ثبت شد؛ از این پس می‌توانید با اثر انگشت یا چهرهٔ همین دستگاه وارد شوید.");
      await load();
    } catch {
      // A browser can refuse to restart the platform ceremony without a fresh
      // gesture; the identity proof itself is still good, so point at the button.
      setError(
        afterStepUp
          ? "هویت شما تأیید شد؛ برای ثبت دستگاه دوباره روی «افزودن این دستگاه» بزنید."
          : "ثبت دستگاه بیومتریک ناموفق بود.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/auth/webauthn/credentials/${id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) {
      setNotice("دستگاه حذف شد.");
      await load();
      return;
    }
    if (await isStaleRecentAuth(res)) {
      setStepUpFor({ kind: "remove", id });
      return;
    }
    setError("حذف دستگاه ممکن نشد.");
  }

  if (supported === null) {
    return <LoadingSkeleton rows={2} />;
  }

  if (surface?.readOnly === true) {
    return (
      <InfoBox>
        {surface.notice ?? "این مورد در نسخهٔ ابری مدیریت می‌شود."} دستگاه‌های ثبت‌شدهٔ شما در
        همین صفحه نمایش داده می‌شوند.
      </InfoBox>
    );
  }

  if (!supported) {
    return (
      <p className="text-xs text-muted-foreground">
        مرورگر این دستگاه از ورود بیومتریک پشتیبانی نمی‌کند؛ بقیهٔ روش‌های ورود بدون تغییر
        باقی هستند.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        به‌جای پین، با اثر انگشت یا چهره این دستگاه وارد شوید. برای هر دستگاهی که استفاده
        می‌کنید جداگانه ثبت‌نام کنید.
      </p>

      <StepUpPrompt
        open={stepUpFor !== null}
        title={
          stepUpFor?.kind === "register"
            ? "تأیید هویت برای ثبت دستگاه"
            : "تأیید هویت برای حذف دستگاه"
        }
        description={RECENT_AUTH_MESSAGE}
        onCancel={() => setStepUpFor(null)}
        onVerified={() => {
          const action = stepUpFor;
          setStepUpFor(null);
          setNotice("هویت شما تأیید شد.");
          if (action?.kind === "register") void register({ afterStepUp: true });
          else if (action?.kind === "remove") void remove(action.id);
        }}
      />

      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      {credentials === null ? <LoadingSkeleton rows={2} /> : null}
      {credentials !== null && credentials.length === 0 ? (
        <p className="text-sm text-muted-foreground">هنوز دستگاهی ثبت نشده است.</p>
      ) : null}
      {credentials !== null && credentials.length > 0 ? (
        <ul className="space-y-2">
          {credentials.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-input px-3 py-2 text-sm"
            >
              <div>
                <p className="font-medium">{c.label || "دستگاه بدون‌نام"}</p>
                <p className="text-xs text-muted-foreground">
                  ثبت‌شده در {toPersianDigits(formatJalali(c.createdAt, { withMonthName: true }))}
                  {c.deviceLabel ? ` · فقط روی «${c.deviceLabel}»` : ""}
                  {c.lastUsedAt
                    ? ` · آخرین استفاده ${toPersianDigits(formatJalali(c.lastUsedAt, { withMonthName: true }))}`
                    : ""}
                </p>
              </div>
              <SecondaryButton onClick={() => setPendingRemove(c)} disabled={busy}>
                حذف
              </SecondaryButton>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void register();
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="min-w-56 flex-1">
          <Field label="نام دستگاه (اختیاری)">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="مثلاً صندوق سالن"
              className={inputClass}
            />
          </Field>
        </div>
        <PrimaryButton type="submit" disabled={busy}>
          افزودن این دستگاه
        </PrimaryButton>
      </form>

      <SecurityConfirmDialog
        open={pendingRemove !== null}
        title="حذف دستگاه بیومتریک"
        description={
          pendingRemove
            ? `دستگاه «${pendingRemove.label || "بدون‌نام"}» از حساب شما حذف می‌شود.`
            : ""
        }
        consequences={[
          "ورود با اثر انگشت یا چهره روی این دستگاه از این لحظه قطع می‌شود.",
          "اگر تنها راه ورود شما همین دستگاه بود، باید با پین یا رمز عبور وارد شوید.",
          "بقیهٔ دستگاه‌های ثبت‌شده و روش‌های ورود دیگر دست‌نخورده می‌مانند.",
        ]}
        confirmLabel="بله، حذف شود"
        busy={busy}
        onOpenChange={(next) => {
          if (!next) setPendingRemove(null);
        }}
        onConfirm={() => {
          const target = pendingRemove;
          setPendingRemove(null);
          if (target) void remove(target.id);
        }}
      />
    </div>
  );
}
