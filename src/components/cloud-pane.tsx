"use client";

/**
 * Phase 46 — a cloud screen inside the desktop's own window.
 *
 * On a Hybrid desktop every screen that is not the till's is the cloud's.
 * Phase 45 sent it to a second window; now it renders here, in the content
 * area under the desktop's own full menu, through a hardened <webview>
 * (electron/cloud-pane.js: no preload, sandboxed, `persist:cloud`, navigation
 * pinned to the cloud's origin). The cloud recognises the pane by its
 * user-agent token and draws the page without its own sidebar.
 *
 * The two addresses follow each other: a menu click here loads the guest; a
 * link inside the guest moves this window's address (so the menu highlights
 * the right entry), and a link to a till screen opens the local till instead.
 * Offline it says the screen needs the Internet and points back to the till.
 * A browser on the LAN (a phone) has no <webview>, and gets a link instead.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CloudIcon, CloudOffIcon, RefreshCwIcon } from "lucide-react";
import { cardClass, PageShell } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ACCOUNTING_WORKSPACE_HREFS } from "@/lib/app-routes";
import { CLOUD_EMBED_UA_TOKEN, cloudPageUrl, mirroredPath } from "@/lib/cloud-embed";
import { isSiteLocalRoute } from "@/lib/site-routes";

/** The parts of Electron's <webview> element the pane uses. */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
}

type PaneState = "starting" | "embedded" | "link" | "offline";

export function CloudPane({ pathAndQuery, cloudUrl }: { pathAndQuery: string; cloudUrl: string | null }) {
  const router = useRouter();
  const target = cloudPageUrl(cloudUrl, pathAndQuery);
  const [state, setState] = useState<PaneState>("starting");
  const [attempt, setAttempt] = useState(0);
  // The first address the guest loads. Fixed for the guest's lifetime: later
  // moves go through loadURL, so the element is never re-created mid-session.
  const [initialSrc, setInitialSrc] = useState<string | null>(null);
  const guestUrl = useRef<string | null>(null);
  const webview = useRef<WebviewElement | null>(null);

  // Decide once per mount (and again on a connection change) what this pane is.
  useEffect(() => {
    let cancelled = false;
    const decide = async () => {
      if (!window.businessSuiteDesktop?.embedsCloud) return setState("link");
      if (!navigator.onLine) return setState("offline");
      if (!target) return setState("link");
      // A one-click cloud sign-in left a single-use code: spend it on the first load.
      let src = target;
      try {
        const res = await fetch("/api/auth/cloud-login/session-code", { method: "POST" });
        const { code } = (await res.json()) as { code: string | null };
        if (code) {
          const handoff = new URL("/api/auth/desktop-session", target);
          handoff.searchParams.set("code", code);
          handoff.searchParams.set("next", pathAndQuery);
          src = handoff.toString();
        }
      } catch {
        // No code to spend: the guest signs in on the cloud's own login page.
      }
      if (cancelled) return;
      guestUrl.current = target;
      setInitialSrc(src);
      setState("embedded");
    };
    void decide();
    const online = () => void decide();
    const offline = () => setState((current) => (current === "link" ? current : "offline"));
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
    // The guest follows later address changes itself (the effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudUrl, attempt]);

  // A menu click here: point the existing guest at the new screen.
  useEffect(() => {
    const element = webview.current;
    if (state !== "embedded" || !element || !target) return;
    if (guestUrl.current === target) return;
    guestUrl.current = target;
    void element.loadURL(target).catch(() => {});
  }, [state, target]);

  // A link inside the guest: move this window's address, or open the local till.
  useEffect(() => {
    const element = webview.current;
    if (state !== "embedded" || !element) return;
    const onNavigate = (event: Event) => {
      const { url, isMainFrame } = event as Event & { url: string; isMainFrame?: boolean };
      if (isMainFrame === false) return;
      guestUrl.current = url;
      const path = mirroredPath(url, cloudUrl);
      if (!path) return;
      const current = `${window.location.pathname}${window.location.search}`;
      if (path === current) return;
      if (isSiteLocalRoute(path.split("?")[0])) router.push(path);
      else window.history.replaceState(null, "", path);
    };
    const onFail = (event: Event) => {
      const { errorCode, isMainFrame } = event as Event & { errorCode: number; isMainFrame: boolean };
      // -3 is ERR_ABORTED: one navigation replaced by another, not a failure.
      if (isMainFrame && errorCode !== -3) setState("offline");
    };
    element.addEventListener("did-navigate", onNavigate);
    element.addEventListener("did-navigate-in-page", onNavigate);
    element.addEventListener("did-fail-load", onFail);
    return () => {
      element.removeEventListener("did-navigate", onNavigate);
      element.removeEventListener("did-navigate-in-page", onNavigate);
      element.removeEventListener("did-fail-load", onFail);
    };
  }, [state, cloudUrl, router]);

  if (state === "starting") {
    return (
      <div role="status" aria-busy="true" aria-label="در حال بازکردن نسخهٔ ابری" className="p-4">
        <Skeleton aria-hidden="true" className="h-full min-h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (state === "embedded" && initialSrc) {
    return (
      <webview
        ref={(element) => {
          webview.current = element as WebviewElement | null;
        }}
        src={initialSrc}
        partition="persist:cloud"
        useragent={`${navigator.userAgent} ${CLOUD_EMBED_UA_TOKEN}`}
        className="absolute inset-0 flex"
      />
    );
  }

  const offline = state === "offline";
  return (
    <PageShell className="py-6">
      <section className={`${cardClass} mx-auto mt-6 max-w-2xl p-6 sm:p-8`}>
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
            {offline ? <CloudOffIcon className="size-5" aria-hidden="true" /> : <CloudIcon className="size-5" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <h2 className="font-bold text-foreground">
              {offline ? "این بخش به اینترنت نیاز دارد" : "این بخش در نسخهٔ ابری است"}
            </h2>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">
              {!target
                ? "نشانی نسخهٔ ابری تنظیم نشده است. اتصال را از «تنظیمات ← ابر و همگام‌سازی» بررسی کنید."
                : offline
                  ? "اتصال اینترنت برقرار نیست. صندوق، سفارش‌ها، میزها، آشپزخانه و شیفت روی همین دستگاه کار می‌کنند؛ این بخش با برگشت اینترنت خودش باز می‌شود."
                  : "حسابداری، گزارش‌ها، مشتریان، رشد و بازاریابی و دستیار هوشمند روی نسخهٔ ابری کار می‌کنند."}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {offline && target ? (
                <Button
                  onClick={() => {
                    setState("starting");
                    setAttempt((count) => count + 1);
                  }}
                >
                  <RefreshCwIcon className="size-4" aria-hidden="true" />
                  تلاش دوباره
                </Button>
              ) : null}
              {!offline && target ? (
                <Button asChild>
                  <a href={target} target="_blank" rel="noopener noreferrer">
                    <CloudIcon className="size-4" aria-hidden="true" />
                    بازکردن نسخهٔ ابری
                  </a>
                </Button>
              ) : null}
              <Button variant="outline" asChild>
                <Link href={ACCOUNTING_WORKSPACE_HREFS.pos}>بازگشت به صندوق</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
