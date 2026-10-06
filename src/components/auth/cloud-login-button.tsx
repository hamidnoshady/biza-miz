"use client";

/**
 * Phase 46 — «ورود با حساب ابری» on a paired desktop (see
 * src/lib/desktop-cloud-login.ts for the whole flow). Only the desktop app
 * shows it: a browser on the LAN has no app for the cloud to hand back to.
 * Offline, the PIN door above it is the way in — owners and managers included.
 */
import { useState, useSyncExternalStore } from "react";
import { CloudIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const REASONS: Record<string, string> = {
  expired: "مهلت ورود تمام شد. دوباره «ورود با حساب ابری» را بزنید.",
  refused: "نسخهٔ ابری این ورود را نپذیرفت. دوباره تلاش کنید.",
  offline: "اتصال به نسخهٔ ابری برقرار نشد. اینترنت را بررسی کنید یا با پین وارد شوید.",
  not_synced: "حساب شما هنوز به این دستگاه نرسیده است. چند لحظهٔ دیگر دوباره تلاش کنید.",
  // The membership exists locally but its replicated cloud identity (password
  // /token version) has not converged, so the desktop refuses to mint a
  // session outside the cloud's revocation chain rather than signing the
  // member in with a weaker one.
  identity_not_synced:
    "اطلاعات ورود حساب ابری شما هنوز روی این دستگاه همگام نشده است. چند لحظهٔ دیگر دوباره تلاش کنید یا با پین وارد شوید.",
  unavailable: "این دستگاه به نسخهٔ ابری متصل نیست.",
  invalid: "پیوند ورود معتبر نبود. دوباره تلاش کنید.",
};

const noSubscribe = () => () => {};

export function CloudLoginButton() {
  const available = useSyncExternalStore(noSubscribe, () => Boolean(window.businessSuiteDesktop?.embedsCloud), () => false);
  // Set by /api/auth/cloud-login/callback when a hand-back did not sign anyone in.
  const returned = useSyncExternalStore(
    noSubscribe,
    () => new URLSearchParams(window.location.search).get("cloudLogin"),
    () => null,
  );
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!available) return null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/cloud-login/start", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { url?: string };
      if (!res.ok || !data.url) {
        setError(REASONS.unavailable);
        return;
      }
      // The desktop shell opens https links in the system browser.
      window.open(data.url, "_blank", "noopener,noreferrer");
      setWaiting(true);
    } catch {
      setError(REASONS.offline);
    } finally {
      setBusy(false);
    }
  }

  const message = error ?? (returned ? REASONS[returned] ?? REASONS.invalid : null);
  return (
    <div className="mt-4 space-y-2 text-center">
      <Button type="button" variant="outline" className="w-full" onClick={start} disabled={busy}>
        <CloudIcon className="size-4" aria-hidden="true" />
        {busy ? "در حال بازکردن مرورگر…" : "ورود با حساب ابری"}
      </Button>
      {waiting ? (
        <p className="text-xs leading-5 text-muted-foreground">
          در مرورگر وارد شوید و «ورود به برنامهٔ دسکتاپ» را بزنید؛ این صفحه خودش وارد می‌شود.
        </p>
      ) : null}
      {message && !waiting ? <p className="text-xs leading-5 text-destructive">{message}</p> : null}
    </div>
  );
}
