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
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOutIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { roleLabel } from "@/lib/role-labels";

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
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!switchMode) return;
    // Drop the previous session before showing a fresh login form — the
    // switch must never retain the old (e.g. cashier) session.
    void fetch("/api/auth/logout", { method: "POST" })
      .then(() => setSignedOut(true))
      .catch(() => setSignedOut(true));
  }, [switchMode]);

  async function signOutAndSwitch() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.replace("/login?changeAccount=1");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mb-4 w-full max-w-sm rounded-xl border border-border bg-muted/40 p-4 text-sm">
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UserRoundIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {switchMode && signedOut ? "حساب قبلی خارج شد" : `وارد شده‌اید: ${fullName}`}
          </p>
          {!switchMode || !signedOut ? (
            <p className="text-xs text-muted-foreground">نقش: {roleLabel(role)}</p>
          ) : (
            <p className="text-xs text-muted-foreground">برای ادامه، حساب تازه را انتخاب کنید.</p>
          )}
        </div>
      </div>
      {!switchMode ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => router.replace(next)}>
            ادامه با همین حساب
          </Button>
          <Button size="sm" variant="outline" onClick={() => void signOutAndSwitch()} disabled={busy}>
            <LogOutIcon className="size-3.5" aria-hidden="true" />
            خروج و تغییر حساب
          </Button>
        </div>
      ) : null}
    </div>
  );
}
