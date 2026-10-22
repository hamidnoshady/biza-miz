"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { withLoginNextParam } from "@/lib/login-contract";

/**
 * Issue #909 §13 — "401 follows an expired-session path instead of a generic
 * label" (coordinates with, but does not fold in, #885/#889's own
 * login/session work).
 *
 * `api()` (`src/app/dashboard/ui.tsx`) already classifies a bare 401 body as
 * `{ error: "unauthorized" }` — the server's own, already-made statement that
 * the session is gone, never a guess that function invents. Until now nothing
 * used that classification for anything but the caller's own render: every
 * dashboard/accounting/CRM/... screen that hit a dead session mid-use just
 * printed an inert Persian label ("وارد نشده‌اید.") and sat there, with no way
 * back to `/login` short of typing the URL by hand.
 *
 * This component is that path. Mount it once, inside the authenticated shell
 * only (`WorkspaceShell` — never the root/login/setup/platform layouts, which
 * have no session to lose and, for the login/OTP/MFA steps specifically, a
 * deliberate *inline* "this step expired, start over" message of their own
 * that must keep working exactly as before). It listens for the
 * `biza:session-expired` event `api()` dispatches on that exact
 * classification and, on the first one, replaces the current history entry
 * with `/login?next=<here>` — reusing `withLoginNextParam`, the same
 * validated-return-path convention issue #885 built for the login door
 * itself, so signing back in lands the member where they left off instead of
 * back at the dashboard root.
 *
 * Deliberately narrow:
 * - Only a 401 whose normalized error is literally `"unauthorized"` reaches
 *   this event; a 403 (`"forbidden"`) never does — that session is still
 *   valid, just short a permission for that one read, and forcing a logout
 *   over it would be wrong. Ordinary login/OTP/MFA credential failures use
 *   their own codes (`invalid_credentials`, `invalid_code`, ...), never the
 *   bare `"unauthorized"` string, so this cannot misfire mid-login either.
 * - This listener only navigates. It does not call the sign-out endpoint,
 *   revoke anything, or clear any cache itself — it is reacting to a decision
 *   the server already made in its own response, the same way a server
 *   component's own `redirect("/login")` after a null `getSession()` does for
 *   a page load. The actual session/device/trusted-device/login logic stays
 *   owned by #885/#889's work; nothing here duplicates it.
 * - Guarded to fire once per mount. A single page routinely fires several
 *   independent reads at once (issue #909's own "load independent reads
 *   concurrently" requirement makes this more true, not less); without the
 *   guard, every one of them dying together would call `router.replace`
 *   repeatedly and could turn one dead session into a visible redirect storm.
 */
export function SessionExpiryListener() {
  const router = useRouter();
  const firedRef = useRef(false);

  useEffect(() => {
    function handleSessionExpired() {
      if (firedRef.current) return;
      firedRef.current = true;
      const next = `${window.location.pathname}${window.location.search}`;
      router.replace(withLoginNextParam("/login", next));
    }
    window.addEventListener("biza:session-expired", handleSessionExpired);
    return () => window.removeEventListener("biza:session-expired", handleSessionExpired);
  }, [router]);

  return null;
}
