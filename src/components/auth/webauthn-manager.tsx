"use client";

import { useCallback, useEffect, useState } from "react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  inputClass,
} from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { readDeviceToken } from "@/lib/device-token";
import { authErrorMessage, isAuthErrorCode } from "@/lib/auth-contracts";
import { RECENT_AUTH_MESSAGE, StepUpPrompt } from "@/components/auth/step-up-prompt";
import { SecurityConfirmDialog } from "@/components/auth/security-confirm-dialog";
import type { CredentialSurface } from "@/lib/credential-authority";
import type { WebauthnRegisterBlock } from "@/lib/webauthn-policy";

interface Credential {
  id: string;
  label: string | null;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** `GET /api/auth/webauthn/credentials` — the list plus what the caller may do with it. */
interface CredentialList {
  credentials?: Credential[];
  canRegister?: boolean;
  canRemove?: boolean;
  registerBlockedBy?: WebauthnRegisterBlock;
  error?: string;
}

const LOAD_FAILED = "بارگذاری دستگاه‌های ثبت‌شده ممکن نشد.";
const REMOVE_NETWORK_FAILED =
  "ارتباط با سرور برقرار نشد و معلوم نیست دستگاه حذف شده باشد. اتصال را بررسی کنید و دوباره تلاش کنید.";

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
 *
 * #854 follow-up:
 *  - **F02** — whether «افزودن این دستگاه» is offered is the server's answer
 *    (`canRegister`, from `webauthn-policy.ts` — the same function the
 *    registration routes enforce), not a guess: a manager is no longer shown a
 *    ceremony that always ends in a 403.
 *  - **F12** — seeing the list, removing an entry and registering this device
 *    are three permissions. An unsupported browser or a read-only deployment
 *    only takes away what it actually prevents; the registered devices stay
 *    visible to their owner either way.
 *  - **F09** — every request path releases `busy` (a dropped connection used to
 *    leave the buttons disabled forever), keeps the list on screen, and says
 *    what to do next.
 */
export function WebAuthnManager({ surface }: { surface?: CredentialSurface }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [policy, setPolicy] = useState<{
    canRegister: boolean;
    canRemove: boolean;
    registerBlockedBy: WebauthnRegisterBlock;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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

  /**
   * A failed refresh keeps whatever list is already on screen (F09/F12): a
   * transient error must not make registered devices look deleted.
   */
  const load = useCallback(async () => {
    const { ok, data, aborted } = await api<CredentialList>("/api/auth/webauthn/credentials");
    if (aborted) return;
    if (!ok) {
      setLoadError(LOAD_FAILED);
      return;
    }
    setCredentials(data.credentials ?? []);
    setPolicy({
      // Absent fields mean an older server: offer nothing it did not confirm.
      canRegister: data.canRegister === true,
      canRemove: data.canRemove === true,
      registerBlockedBy: data.registerBlockedBy ?? null,
    });
    setLoadError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const readOnly = surface?.readOnly === true;
  const canRemove = Boolean(policy?.canRemove) && !readOnly;
  const canRegister = Boolean(policy?.canRegister) && !readOnly;

  async function register({ afterStepUp = false }: { afterStepUp?: boolean } = {}) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const optionsRes = await api<{
        options?: Parameters<typeof startRegistration>[0]["optionsJSON"];
        challengeToken?: string;
        error?: string;
        message?: string;
      }>("/api/auth/webauthn/register/options", { method: "POST" });
      if (optionsRes.status === 403 && optionsRes.data.error === "recent_auth_required") {
        setStepUpFor({ kind: "register" });
        return;
      }
      if (!optionsRes.ok || !optionsRes.data.options || !optionsRes.data.challengeToken) {
        setError(
          optionsRes.data.message ??
            (optionsRes.status === 0
              ? "ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید."
              : "ثبت دستگاه بیومتریک ناموفق بود."),
        );
        return;
      }

      let response: Awaited<ReturnType<typeof startRegistration>>;
      try {
        response = await startRegistration({ optionsJSON: optionsRes.data.options });
      } catch {
        // A browser can refuse to restart the platform ceremony without a fresh
        // gesture, and a member can cancel the prompt; the identity proof itself
        // is still good, so point at the button.
        setError(
          afterStepUp
            ? "هویت شما تأیید شد؛ برای ثبت دستگاه دوباره روی «افزودن این دستگاه» بزنید."
            : "ثبت دستگاه لغو شد یا مرورگر آن را نپذیرفت؛ دوباره تلاش کنید.",
        );
        return;
      }

      const verifyRes = await api<{ error?: string; message?: string }>(
        "/api/auth/webauthn/register/verify",
        {
          method: "POST",
          body: JSON.stringify({
            response,
            challengeToken: optionsRes.data.challengeToken,
            deviceLabel: label.trim() || undefined,
            deviceToken: readDeviceToken(),
          }),
        },
      );
      if (verifyRes.status === 403 && verifyRes.data.error === "recent_auth_required") {
        setStepUpFor({ kind: "register" });
        return;
      }
      if (!verifyRes.ok) {
        setError(
          verifyRes.data.message ??
            (verifyRes.status === 0
              ? "ارتباط با سرور برقرار نشد و معلوم نیست دستگاه ثبت شده باشد؛ فهرست را بررسی کنید."
              : "ثبت دستگاه بیومتریک ناموفق بود."),
        );
        if (verifyRes.status === 0) await load();
        return;
      }

      setLabel("");
      setNotice("دستگاه ثبت شد؛ از این پس می‌توانید با اثر انگشت یا چهرهٔ همین دستگاه وارد شوید.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { ok, status, data, aborted } = await api<{ error?: string; message?: string }>(
        `/api/auth/webauthn/credentials/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (ok) {
        setNotice("دستگاه حذف شد.");
        await load();
        return;
      }
      if (status === 403 && data.error === "recent_auth_required") {
        setStepUpFor({ kind: "remove", id });
        return;
      }
      if (aborted || status === 0) {
        // The request may or may not have reached the server: say so, and
        // refresh the list (best-effort) so it shows the truth.
        setError(REMOVE_NETWORK_FAILED);
        await load();
        return;
      }
      setError(
        data.message ??
          (isAuthErrorCode(data.error)
            ? authErrorMessage(data.error)
            : "حذف دستگاه ممکن نشد. دوباره تلاش کنید."),
      );
    } finally {
      setBusy(false);
    }
  }

  const intro = !policy
    ? null
    : canRegister
      ? "به‌جای پین، با اثر انگشت یا چهره این دستگاه وارد شوید. برای هر دستگاهی که استفاده می‌کنید جداگانه ثبت‌نام کنید."
      : policy.registerBlockedBy === "role"
        ? "ورود بیومتریک جایگزین رمز عددی نقش‌های صندوق، سالن و آشپزخانه است و برای نقش شما دستگاه تازه‌ای ثبت نمی‌شود. دستگاه‌هایی که پیش‌تر ثبت شده‌اند در این فهرست دیده و حذف می‌شوند."
        : null;

  return (
    <div className="space-y-4">
      {intro ? <p className="text-xs text-muted-foreground">{intro}</p> : null}

      {readOnly ? (
        <InfoBox>
          {surface?.notice ?? "این مورد در نسخهٔ ابری مدیریت می‌شود."} دستگاه‌های ثبت‌شدهٔ شما در
          همین صفحه نمایش داده می‌شوند.
        </InfoBox>
      ) : null}

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

      {loadError ? (
        <div>
          <ErrorBox>{loadError}</ErrorBox>
          <SecondaryButton onClick={() => void load()} disabled={busy}>
            تلاش دوباره
          </SecondaryButton>
        </div>
      ) : null}

      {credentials === null ? (
        loadError ? null : <LoadingSkeleton rows={2} />
      ) : credentials.length === 0 ? (
        <p className="text-sm text-muted-foreground">هنوز دستگاهی ثبت نشده است.</p>
      ) : (
        <ul className="space-y-2" aria-label="دستگاه‌های بیومتریک ثبت‌شده">
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
              {canRemove ? (
                <SecondaryButton onClick={() => setPendingRemove(c)} disabled={busy}>
                  حذف
                </SecondaryButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/*
        Registration is the one action that needs this browser's WebAuthn
        support (F12): the list above and removal do not, so an unsupported
        browser loses only this form.
      */}
      {canRegister && supported === false ? (
        <p className="text-xs text-muted-foreground">
          مرورگر این دستگاه از ثبت ورود بیومتریک پشتیبانی نمی‌کند؛ برای افزودن، از مرورگر یا دستگاهی
          که پشتیبانی می‌کند استفاده کنید. بقیهٔ روش‌های ورود بدون تغییر باقی هستند.
        </p>
      ) : null}
      {canRegister && supported === true ? (
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
            {busy ? "در حال ثبت…" : "افزودن این دستگاه"}
          </PrimaryButton>
        </form>
      ) : null}

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
