"use client";

/**
 * #1585 — silent renewal after the access session ends.
 *
 * The remembered-login credential stays valid after the browser is closed, but
 * the *access session* deliberately does not: it is a short-lived JWT, and it
 * is supposed to be gone by the time someone reopens their laptop the next
 * morning. Nothing renews it in the background, because a renewal is a
 * server-side decision (identity, membership, token version, risk, assurance)
 * and the server is the only thing that may make it.
 *
 * This component is the one place a page load asks. It:
 *
 *  - fires **once** per mount, on the login page only;
 *  - posts to `/api/auth/refresh`, which reads the HttpOnly host-only cookie the
 *    page's JavaScript cannot see;
 *  - on success, walks straight into the app — no credential re-entry, no
 *    redirect loop (the destination is the same validated `next` the login page
 *    already computed);
 *  - on `409 concurrent_refresh`, retries once: a sibling tab rotated
 *    microseconds earlier and the browser now holds that tab's cookie;
 *  - on any refusal, does nothing at all. The login form underneath is already
 *    rendered and usable, so a signed-out visitor sees no spinner, no error and
 *    no flash — just the normal sign-in screen.
 */
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export function RememberedSessionBootstrap({ next }: { next: string }) {
  const router = useRouter();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    let cancelled = false;

    async function attempt(retry: boolean) {
      let res: Response;
      try {
        res = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // An empty body: this is the silent low-risk path. A step-up is never
          // attempted here — the form below is how a person proves themselves.
          body: "{}",
          credentials: "same-origin",
        });
      } catch {
        return;
      }
      if (cancelled) return;
      if (res.ok) {
        router.replace(next);
        router.refresh();
        return;
      }
      if (res.status === 409 && !retry) {
        // The sibling tab that won the race already set the new cookie.
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!cancelled) await attempt(true);
      }
    }

    void attempt(false);
    return () => {
      cancelled = true;
    };
  }, [next, router]);

  return null;
}
