"use client";

/**
 * Phase 35 — the browser half of subscribing to push.
 *
 * Lives next to the settings screen rather than in `src/lib/` because every
 * line of it touches `navigator`, `window` or the service worker registration:
 * it is browser plumbing, not the framework-free decision logic `src/lib/*.ts`
 * is unit-tested for. The decisions — who hears what, when — are in
 * `src/lib/notifications.ts` and are tested there.
 *
 * The whole file exists to make one platform's rules survivable. On Android,
 * Windows, macOS and Linux, Chrome and Edge will subscribe an ordinary tab. On
 * **iOS, Safari refuses unless the app was added to the home screen** — and it
 * refuses by simply not exposing `PushManager`, with no error and no prompt. A
 * user who taps «فعال کردن» in Safari on an iPhone would otherwise watch
 * nothing happen, forever, and conclude the feature is broken. So the
 * unsupported case is detected up front and answered with the instruction that
 * actually fixes it.
 */

export type PushSupport =
  | { supported: true }
  | {
      supported: false;
      reason: "ios_needs_install" | "unsupported" | "insecure_context";
      message: string;
    };

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; the touch-point count is what still
  // separates an iPad from a MacBook.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Why this browser can or cannot receive push, in the user's own language. */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { supported: false, reason: "unsupported", message: "" };
  }
  // Push needs a secure context. On a LAN install over plain HTTP that is the
  // real reason it will not work, and it is worth saying so rather than letting
  // it read as a browser limitation.
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: "insecure_context",
      message:
        "برای دریافت اعلان، برنامه باید روی نشانی امن (HTTPS) باز شود. روی localhost هم کار می‌کند.",
    };
  }
  if (!("serviceWorker" in navigator) || !("Notification" in window)) {
    return {
      supported: false,
      reason: "unsupported",
      message:
        "این مرورگر از اعلان پشتیبانی نمی‌کند. مرورگر را به‌روز کنید یا از کروم/اج استفاده کنید.",
    };
  }
  if (!("PushManager" in window)) {
    if (isIos() && !isStandalone()) {
      return {
        supported: false,
        reason: "ios_needs_install",
        message:
          "در آیفون و آیپد، اعلان فقط وقتی کار می‌کند که برنامه را به صفحهٔ اصلی اضافه کرده باشید: از دکمهٔ اشتراک‌گذاری «Add to Home Screen» را بزنید، برنامه را از همان آیکون باز کنید و دوباره اینجا بیایید.",
      };
    }
    return {
      supported: false,
      reason: "unsupported",
      message: "این مرورگر از اعلان پشتیبانی نمی‌کند.",
    };
  }
  return { supported: true };
}

/** The label the settings list shows for a device, so a row isn't a 200-character URL. */
export function devicePlatform(): "ios" | "android" | "windows" | "macos" | "linux" | "other" {
  const ua = navigator.userAgent;
  if (isIos()) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Linux|X11/.test(ua)) return "linux";
  return "other";
}

export function deviceLabel(): string {
  const platform = devicePlatform();
  const names: Record<ReturnType<typeof devicePlatform>, string> = {
    ios: "آیفون / آیپد",
    android: "اندروید",
    windows: "ویندوز",
    macos: "مک",
    linux: "لینوکس",
    other: "دستگاه",
  };
  const browser = /Edg\//.test(navigator.userAgent)
    ? "Edge"
    : /Chrome\//.test(navigator.userAgent)
      ? "Chrome"
      : /Firefox\//.test(navigator.userAgent)
        ? "Firefox"
        : /Safari\//.test(navigator.userAgent)
          ? "Safari"
          : "";
  return browser ? `${names[platform]} — ${browser}` : names[platform];
}

/**
 * base64url → the raw bytes `pushManager.subscribe` insists on.
 *
 * Typed as `ArrayBuffer` rather than `Uint8Array` because the DOM signature
 * wants a `BufferSource` backed by a plain `ArrayBuffer`, and `Uint8Array`'s
 * type admits a `SharedArrayBuffer` it will never actually hold here.
 */
function applicationServerKey(base64Url: string): ArrayBuffer {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return buffer;
}

/**
 * The service worker registration to subscribe against.
 *
 * `PwaRegister` (src/components/pwa-register.tsx) deliberately skips
 * registration in development so the shell is never cached while iterating,
 * which also means there is no worker to subscribe to there. Registering it
 * here on demand keeps «فعال کردن اعلان» working in `npm run dev` without
 * bringing the caching back: the worker only starts existing once someone asks
 * for notifications.
 */
async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

export type EnableResult = { ok: true } | { ok: false; message: string };

/**
 * Asks for permission, subscribes, and registers the subscription with the
 * server. Safe to call when already subscribed — `getSubscription()` returns
 * the existing one and the server-side upsert refreshes the row.
 */
export async function enablePush(): Promise<EnableResult> {
  const support = pushSupport();
  if (!support.supported) return { ok: false, message: support.message };

  // Must be called from a user gesture; the settings button is one. A browser
  // that has already been told "never" answers `denied` without prompting, and
  // there is nothing the page can do about that except say so.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      ok: false,
      message:
        permission === "denied"
          ? "اجازهٔ نمایش اعلان برای این نشانی رد شده است. از تنظیمات مرورگر آن را دوباره اجازه دهید."
          : "اجازهٔ نمایش اعلان داده نشد.",
    };
  }

  const keyResponse = await fetch("/api/notifications/public-key");
  if (!keyResponse.ok) return { ok: false, message: "دریافت کلید اعلان از سرور ناموفق بود." };
  const key = (await keyResponse.json()) as { configured: boolean; publicKey: string | null };
  if (!key.configured || !key.publicKey) {
    return { ok: false, message: "ارسال اعلان روی این سرور هنوز آماده نیست." };
  }

  const registration = await pushRegistration();
  let previous = await registration.pushManager.getSubscription();
  if (previous && !(await currentSubscriptionEndpoint())) {
    // A disabled/unregistered subscription may belong to a previous account
    // or business. Rotate it rather than attempting a cross-tenant upsert.
    if (!(await previous.unsubscribe()))
      return { ok: false, message: "لغو اشتراک قبلی ناموفق بود؛ دوباره تلاش کنید." };
    previous = null;
  }
  const subscription =
    previous ??
    (await registration.pushManager.subscribe({
      // Required — and on every current browser the only value that works: a
      // push that shows nothing is not allowed to be silent.
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(key.publicKey),
    }));

  const json = subscription.toJSON();
  const response = await fetch("/api/notifications/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
      platform: devicePlatform(),
      label: deviceLabel(),
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    return { ok: false, message: body.message ?? "ثبت دستگاه در سرور ناموفق بود." };
  }
  const result = (await response.json()) as { binding?: string };
  registration.active?.postMessage({
    type: "notification-binding",
    identity: result.binding ?? null,
  });
  return { ok: true };
}

/**
 * Unsubscribes this browser and forgets it server-side.
 *
 * The server is told even if the browser-side unsubscribe fails: a row that
 * outlives its subscription is a push that fails forever, which is the worse of
 * the two leftovers.
 */
export async function disablePush(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  const response = await fetch(
    `/api/notifications/devices?endpoint=${encodeURIComponent(endpoint)}`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok) throw new Error("حذف ثبت دستگاه در سرور ناموفق بود؛ دوباره تلاش کنید.");
  if (!(await subscription.unsubscribe()))
    throw new Error("ثبت سرور حذف شد اما لغو اشتراک مرورگر ناموفق بود؛ دوباره تلاش کنید.");
}

/** Whether *this* browser currently holds a subscription — what the toggle reflects. */
export async function currentSubscriptionEndpoint(): Promise<string | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return null;
  const response = await fetch("/api/notifications/devices", { cache: "no-store" });
  if (!response.ok) throw new Error("بررسی ثبت دستگاه ناموفق بود.");
  const data = (await response.json()) as {
    devices: { endpoint: string; disabledAt: string | null }[];
  };
  return data.devices.some((d) => d.endpoint === subscription.endpoint && !d.disabledAt)
    ? subscription.endpoint
    : null;
}
