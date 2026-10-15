"use client";

/**
 * Issue #948 P0-2 — current-account visibility and a safe account switch.
 *
 * The reproduction: an owner expected their owner account but the till was
 * signed in as «صندوق / صندوق‌دار», with no obvious reading of *who* the
 * session is or how to change it. This panel appears on `/login` and
 * `/admin` whenever a valid session exists (the pages normally redirect a
 * signed-in visitor into the app; this is shown when switching was requested
 * or a cloud-login handoff failed and the form must stay visible).
 *
 * It states the actual membership name + role from the server-minted session —
 * never a label inferred from which door was used — and offers exactly two
 * honest paths: continue as this account, or sign out and switch. Switching
 * **revokes the previous session first** (POST /api/auth/logout), so a cashier
 * session never lingers behind a later owner sign-in.
 *
 * #854 follow-up — the switch used to mark the previous account "signed out"
 * whether the request succeeded *or was rejected*, and the explicit button
 * navigated without reading the answer. Both now read the shared sign-out
 * contract (`@/lib/logout-contract`): only a confirmed end says «حساب قبلی
 * خارج شد»; a dropped request says the previous session is still open and
 * offers a retry; an unconfirmed end (the cookie is gone, the server could not
 * confirm) says exactly that, with a retry that goes through the server's
 * retry ticket.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LogOutIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { roleLabel } from "@/lib/role-labels";
import {
  browserSignedOut,
  LOGOUT_MESSAGES,
  signOutResultMessage,
  useSignOut,
  type SignOutResult,
} from "@/components/auth/sign-out";
import { announceSignOutResult, retryUnconfirmedSignOut } from "@/components/auth/sign-out-feedback";

/** The heading for the switch-mode panel, from the previous session's fate. */
function switchHeading(result: SignOutResult | null, busy: boolean): string {
  if (!result || busy) return "در حال خروج از حساب قبلی…";
  switch (result.kind) {
    case "signed_out":
      return "حساب قبلی خارج شد";
    case "unconfirmed":
      return "از این دستگاه خارج شدید";
    default:
      return "خروج از حساب قبلی انجام نشد";
  }
}

export function SignedInNotice({
  fullName,
  role,
  switchMode = false,
  next = "/dashboard",
}: {
  fullName: string;
  role: string;
  /**
   * `true` when this visit explicitly asked to change accounts
   * (`/login?changeAccount=1`): the previous session is revoked on mount,
   * before any new credential is entered.
   */
  switchMode?: boolean;
  next?: string;
}) {
  const router = useRouter();
  const { busy, result, run } = useSignOut();
  const failureMessage = result ? signOutResultMessage(result) : null;

  useEffect(() => {
    if (!switchMode) return;
    // Drop the previous session before showing a fresh login form — the
    // switch must never retain the old (e.g. cashier) session.
    void run();
  }, [switchMode, run]);

  async function signOutAndSwitch() {
    const outcome = await run();
    if (!outcome || !browserSignedOut(outcome)) return; // the reason is shown inline
    // Signed out in this browser: carry an unconfirmed warning (and its retry)
    // across the navigation, then show the fresh door.
    announceSignOutResult(outcome, () => void retryUnconfirmedSignOut());
    router.replace("/login?changeAccount=1");
    router.refresh();
  }

  if (switchMode) {
    const settled = Boolean(result) && !busy;
    const failed = settled && result?.kind !== "signed_out";
    return (
      <div className="mx-auto mb-4 w-full max-w-sm rounded-xl border border-border bg-muted/40 p-4 text-sm">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserRoundIcon className="size-4" aria-hidden="true" />
          </span>
          {/* A stable live region for progress and success… */}
          <div className="min-w-0" role="status" aria-live="polite">
            <p className="font-medium text-foreground">{switchHeading(result, busy)}</p>
            {settled && result?.kind === "signed_out" ? (
              <p className="text-xs text-muted-foreground">برای ادامه، حساب تازه را انتخاب کنید.</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {fullName} — نقش: {roleLabel(role)}
              </p>
            )}
          </div>
        </div>
        {/* …and a separate alert, inserted when there is something to act on. */}
        {failed && failureMessage ? (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {failureMessage}
          </p>
        ) : null}
        {failed ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void run()} disabled={busy}>
              {LOGOUT_MESSAGES.retryLabel}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto mb-4 w-full max-w-sm rounded-xl border border-border bg-muted/40 p-4 text-sm">
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UserRoundIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="font-medium text-foreground">{`وارد شده‌اید: ${fullName}`}</p>
          <p className="text-xs text-muted-foreground">نقش: {roleLabel(role)}</p>
        </div>
      </div>
      {failureMessage && !busy ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {failureMessage}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => router.replace(next)} disabled={busy}>
          ادامه با همین حساب
        </Button>
        <Button size="sm" variant="outline" onClick={() => void signOutAndSwitch()} disabled={busy}>
          <LogOutIcon className="size-3.5" aria-hidden="true" />
          {busy ? "در حال خروج…" : failureMessage ? "تلاش دوباره برای خروج" : "خروج و تغییر حساب"}
        </Button>
      </div>
    </div>
  );
}
