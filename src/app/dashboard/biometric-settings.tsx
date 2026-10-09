"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { FingerprintIcon } from "lucide-react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { readDeviceToken } from "@/lib/device-token";
import { RECENT_AUTH_MESSAGE, StepUpPrompt } from "@/components/auth/step-up-prompt";
import { overlayPanelClass } from "./page-chrome";
import { SIDEBAR_FOOTER_BUTTON_CLASS } from "./sidebar-nav-styles";

interface Credential {
  id: string;
  label: string | null;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}


/**
 * Phase 20 Wave 3 — self-service "manage biometric login" panel for
 * PIN-role staff (the same audience as the lock screen/login picker's
 * biometric option). Lives in the sidebar footer next to the lock button
 * rather than under /dashboard/settings: that page's tabs are all gated by
 * owner/manager permissions (settings-tabs.ts), and this is each employee
 * managing their own credential, not something a manager configures for them.
 */
export function BiometricSettingsButton() {
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);

  if (!supported) return null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={SIDEBAR_FOOTER_BUTTON_CLASS}>
        <FingerprintIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-start">ورود بیومتریک</span>
      </button>
      {open && <BiometricPanel onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The one refusal this panel can resolve on its own: `403 recent_auth_required`
 * from a stale recent-auth window (issue #854 P1.8 made adding and removing a
 * biometric credential a sensitive action). Any other failure is reported as
 * the generic message the panel already had.
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

function BiometricPanel({ onClose }: { onClose: () => void }) {
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  /**
   * The action waiting behind a step-up prompt. Held here rather than in the
   * prompt so that `register`/`remove` stay the only code that talks to the
   * WebAuthn routes — the prompt's job is to refresh the session, not to
   * replay a half-finished ceremony.
   */
  const [stepUpFor, setStepUpFor] = useState<
    { kind: "register" } | { kind: "remove"; id: string } | null
  >(null);

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
      await load();
      return;
    }
    if (await isStaleRecentAuth(res)) {
      setStepUpFor({ kind: "remove", id });
      return;
    }
    setError("حذف دستگاه ممکن نشد.");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-sm p-6`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">ورود بیومتریک</h2>
          <button type="button" onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
            بستن
          </button>
        </div>

        <p className="mb-3 text-xs text-muted-foreground">
          به‌جای پین، با اثر انگشت یا چهره این دستگاه وارد شوید. برای هر دستگاهی که استفاده می‌کنید جداگانه ثبت‌نام کنید.
        </p>

        {stepUpFor ? (
          <StepUpPrompt
            open
            title={
              stepUpFor.kind === "register"
                ? "تأیید هویت برای ثبت دستگاه"
                : "تأیید هویت برای حذف دستگاه"
            }
            description={RECENT_AUTH_MESSAGE}
            onCancel={() => setStepUpFor(null)}
            onVerified={() => {
              const action = stepUpFor;
              setStepUpFor(null);
              setNotice("هویت شما تأیید شد.");
              if (action.kind === "register") void register({ afterStepUp: true });
              else void remove(action.id);
            }}
          />
        ) : null}

        {notice && !stepUpFor ? (
          <p className="mb-3 text-xs text-muted-foreground">{notice}</p>
        ) : null}

        {credentials === null && <LoadingSkeleton rows={3} />}
        {credentials !== null && credentials.length === 0 && (
          <p className="mb-3 text-sm text-muted-foreground">هنوز دستگاهی ثبت نشده است.</p>
        )}
        {credentials !== null && credentials.length > 0 && (
          <ul className="mb-3 space-y-2">
            {credentials.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded-lg border border-input px-3 py-2 text-sm">
                <div>
                  <p className="font-medium">{c.label || "دستگاه بدون‌نام"}</p>
                  <p className="text-xs text-muted-foreground">
                    ثبت‌شده در {toPersianDigits(formatJalali(c.createdAt, { withMonthName: true }))}
                    {c.deviceLabel ? ` · فقط روی «${c.deviceLabel}»` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  disabled={busy}
                  className="text-xs text-destructive hover:underline disabled:opacity-50"
                >
                  حذف
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="نام دستگاه (اختیاری)"
            className="min-w-0 flex-1 rounded-lg border border-input px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void register()}
            disabled={busy}
            className="shrink-0 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50"
          >
            افزودن این دستگاه
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
