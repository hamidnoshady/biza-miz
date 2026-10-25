"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { FingerprintIcon, LockIcon } from "lucide-react";
import { PinPad } from "@/components/auth/pin-pad";
import { useNative } from "@/components/native/native-provider";
import { authenticateWithNativeBiometric } from "@/lib/native/capabilities-client";
import { overlayPanelClass } from "./page-chrome";
import { SIDEBAR_FOOTER_BUTTON_CLASS } from "./sidebar-nav-styles";

/**
 * Phase 20 Wave 2 — a client-side-only "step away from the till" convenience,
 * not a session boundary: the underlying `pos_session` cookie stays valid the
 * whole time, this just hides the screen behind a PIN prompt until the same
 * person (or anyone else who knows their PIN) re-enters it. Per-tab by
 * design (`sessionStorage`, not `localStorage`) so closing the terminal's
 * browser tab doesn't leave a stale "locked" flag for the next shift.
 */
const LOCK_KEY = "pos:locked";

const LockContext = createContext<(() => void) | null>(null);

export function useLockScreen(): () => void {
  const lock = useContext(LockContext);
  if (!lock) throw new Error("useLockScreen must be used within LockProvider");
  return lock;
}

export function LockProvider({
  fullName,
  children,
}: {
  fullName: string;
  children: React.ReactNode;
}) {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    setLocked(window.sessionStorage.getItem(LOCK_KEY) === "1");
  }, []);

  function lock() {
    window.sessionStorage.setItem(LOCK_KEY, "1");
    setLocked(true);
  }

  function unlock() {
    window.sessionStorage.removeItem(LOCK_KEY);
    setLocked(false);
  }

  return (
    <LockContext.Provider value={lock}>
      {children}
      {locked && <LockOverlay fullName={fullName} onUnlock={unlock} />}
    </LockContext.Provider>
  );
}

function LockOverlay({ fullName, onUnlock }: { fullName: string; onUnlock: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { capabilities, request } = useNative();
  const hasNativeBiometric = capabilities.biometric.provider === "native";

  async function submit(pin: string) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/verify-pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    setBusy(false);
    if (res.status === 401 || res.status === 403) {
      window.location.assign("/login");
      return;
    }
    if (res.ok) {
      onUnlock();
    } else {
      setError("پین نادرست است.");
      setAttempt((a) => a + 1);
    }
  }

  async function unlockWithNativeBiometric() {
    setBusy(true);
    setError(null);
    try {
      const bio = await authenticateWithNativeBiometric(request, {
        title: "بازگشایی قفل بیزامیز",
        subtitle: fullName,
      });
      if (!bio.authenticated) {
        setError("تأیید بیومتریک انجام نشد. از پین استفاده کنید.");
        return;
      }
      // Server-authoritative session + revocation check: biometric unlock
      // never bypasses an expired session or a revoked Android installation.
      const res = await fetch("/api/native-devices/self", { method: "GET" });
      if (res.status === 401 || res.status === 403) {
        window.location.assign("/login");
        return;
      }
      if (!res.ok) {
        setError("نشست معتبر نیست. لطفاً پین را وارد کنید.");
        return;
      }
      onUnlock();
    } catch {
      setError("تأیید بیومتریک لغو شد یا در دسترس نیست. لطفاً پین را وارد کنید.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-xs p-6 text-center`}>
        <p className="mb-1 text-sm text-muted-foreground">صفحه قفل است</p>
        <p className="mb-4 font-semibold">{fullName}</p>
        <PinPad onComplete={submit} busy={busy} error={error} resetKey={attempt} />
        {hasNativeBiometric ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void unlockWithNativeBiometric()}
            className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-secondary px-4 py-2.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            <FingerprintIcon className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>بازگشایی با اثر انگشت یا چهره</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function LockButton() {
  const lock = useLockScreen();
  return (
    <button type="button" onClick={lock} className={SIDEBAR_FOOTER_BUTTON_CLASS}>
      <LockIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-start">قفل صفحه</span>
    </button>
  );
}
