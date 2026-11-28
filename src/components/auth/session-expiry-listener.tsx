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
 * - This listener never decides *whether* the session is over. It first asks
 *   `/api/auth/refresh` (#1585) whether this browser's remembered login can
 *   mint a new short-lived session — that decision is the server's, made from
 *   identity, membership, token version and risk — and only when the answer is
 *   no does it navigate. It never calls the sign-out endpoint, revokes
 *   anything, or clears any cache itself, exactly as before: it is reacting to
 *   a decision the server already made in its own response.
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
    async function handleSessionExpired() {
      if (firedRef.current) return;
      firedRef.current = true;

      /*
       * #1585 — a dead access session is not necessarily the end of the
       * session. If this browser was remembered, the server can mint a new
       * short-lived one after re-validating identity, membership, token version
       * and risk; that decision belongs to the server, so this asks rather than
       * decides, and only then falls back to the sign-in page.
       *
       * A refusal (401) or an unavailable endpoint simply means "no remembered
       * login", which is the pre-#1585 behaviour. `409` means a sibling tab
       * rotated first and already set the new cookie, so one retry is enough.
       */
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const res = await fetch("/api/auth/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            credentials: "same-origin",
          });
          if (res.ok) {
            // Renewed: re-render the page in place. Re-arm so a later expiry
            // can renew again instead of being swallowed by this guard.
            firedRef.current = false;
            router.refresh();
            return;
          }
          if (res.status !== 409) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        } catch {
          break;
        }
      }

      const next = `${window.location.pathname}${window.location.search}`;
      router.replace(withLoginNextParam("/login", next));
    }
    const listener = () => void handleSessionExpired();
    window.addEventListener("biza:session-expired", listener);
    return () => window.removeEventListener("biza:session-expired", listener);
  }, [router]);

  return null;
}
