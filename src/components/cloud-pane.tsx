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
 * The guest wears this window's light/dark theme, and follows it when the
 * desktop's toggle changes it: the cloud's own toggle is in the hidden sidebar.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { CloudIcon, CloudOffIcon, RefreshCwIcon } from "lucide-react";
import { cardClass, PageShell } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ACCOUNTING_WORKSPACE_HREFS } from "@/lib/app-routes";
import { CLOUD_EMBED_UA_TOKEN, cloudPageUrl, cloudThemeScript, isCloudAuthLanding, mirroredPath } from "@/lib/cloud-embed";
import { isSiteLocalRoute } from "@/lib/site-routes";

/** The parts of Electron's <webview> element the pane uses. */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
}

type PaneState = "starting" | "embedded" | "link" | "offline" | "auth-required";

export function CloudPane({ pathAndQuery, cloudUrl }: { pathAndQuery: string; cloudUrl: string | null }) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const target = cloudPageUrl(cloudUrl, pathAndQuery);
  const [state, setState] = useState<PaneState>("starting");
  const [attempt, setAttempt] = useState(0);
  const [authBusy, setAuthBusy] = useState(false);

  // Issue #948 P0-3 — the explicit, safe auth action: «ورود با حساب ابری»
  // opens the system browser on the cloud's own login with a one-use, state-
  // bound handoff (POST /api/auth/cloud-login/start → businesssuite://
  // callback). Never a silent form inside the pane.
  async function startCloudSignIn() {
    setAuthBusy(true);
    try {
      const res = await fetch("/api/auth/cloud-login/start", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { url?: string };
      if (res.ok && data.url) {
        // The desktop shell opens https links in the system browser.
        window.open(data.url, "_blank", "noopener,noreferrer");
      }
    } catch {
      // Offline: the till below still works; retry later.
    } finally {
      setAuthBusy(false);
    }
  }
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
      if (!target) return setState("link");
      // The browser reporting *no network interface at all* is authoritative
      // in the negative direction (the same contract as `probeServer`): a
      // cloud screen cannot load, and the one-use handoff code must not be
      // consumed for an attempt that cannot succeed — so the internet card is
      // shown here, before any handoff is spent. Everything else is decided by
      // actual outcomes: the guest's load result, and where it lands (issue
      // #948 — a missing cloud session is "cloud sign-in required", never a
      // navigator.onLine guess and never a login-loop).
      if (!navigator.onLine) return setState("offline");
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
        // No code to spend is fine: the `persist:cloud` partition may already
        // hold a cloud session. If it does not, the guest lands on the cloud's
        // own login page and `onNavigate` below turns that into an explicit
        // "cloud sign-in required" card — never an uncontrolled login-loop in
        // the pane, and never an "internet is down" claim.
      } catch {
        // The handoff lookup itself failed; load the plain target and let the
        // load outcome decide between the guest and the offline card.
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
      // Issue #948 P0-3 — the guest landing on the cloud's own sign-in page
      // means the `persist:cloud` partition holds no cloud session. That is
      // "cloud sign-in required", not an internet outage and not something to
      // leave the pane looping through: show the explicit, one-use handoff
      // action. (Checked on the raw URL — `mirroredPath` deliberately returns
      // null for login paths.)
      if (isCloudAuthLanding(url, cloudUrl)) {
        setState("auth-required");
        return;
      }
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

  // The desktop's theme is the one theme: apply it on every load of the guest
  // and again whenever the desktop's toggle changes it.
  useEffect(() => {
    const element = webview.current;
    const script = cloudThemeScript(resolvedTheme);
    if (state !== "embedded" || !element || !script) return;
    const apply = () => void element.executeJavaScript(script).catch(() => {});
    element.addEventListener("dom-ready", apply);
    // A guest already showing a page has had its dom-ready: switch it now.
    try {
      if (element.getURL()) apply();
    } catch {
      // Not attached yet: dom-ready will apply it.
    }
    return () => element.removeEventListener("dom-ready", apply);
  }, [state, resolvedTheme]);

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

  if (state === "auth-required") {
    return (
      <PageShell className="py-6">
        <section className={`${cardClass} mx-auto mt-6 max-w-2xl p-6 sm:p-8`}>
          <div className="flex items-start gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
              <CloudIcon className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="font-bold text-foreground">برای نمایش این بخش باید وارد حساب ابری شوید</h2>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">
                نشست ابری روی این دستگاه فعال نیست. صندوق، سفارش‌ها، میزها، آشپزخانه و شیفت روی همین دستگاه کار می‌کنند؛
                این بخش با ورود حساب ابری باز می‌شود. این پیام به معنی قطع بودن اینترنت نیست.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button onClick={() => void startCloudSignIn()} disabled={authBusy}>
                  <CloudIcon className="size-4" aria-hidden="true" />
                  {authBusy ? "در حال بازکردن مرورگر…" : "ورود با حساب ابری"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setState("starting");
                    setAttempt((count) => count + 1);
                  }}
                >
                  <RefreshCwIcon className="size-4" aria-hidden="true" />
                  تلاش دوباره
                </Button>
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
