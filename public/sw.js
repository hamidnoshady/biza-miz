/**
 * Service worker (Phase 12) — the minimum needed to make the POS installable
 * as a PWA and to keep the app window openable even if the server is briefly
 * unreachable (e.g. the moment right after boot before Docker is fully up).
 *
 * Deliberately conservative: this is an online-first app whose real offline
 * story is the server itself (the on-site laptop) plus the IndexedDB action
 * queue (Phase 5). So the service worker only:
 *   - Precaches a tiny offline fallback page and the app icon.
 *   - Serves navigations network-first, falling back to the cached shell only
 *     when the network genuinely fails — it never serves stale API data.
 *   - Never caches API responses (/api/*) — those must always hit the server
 *     so orders, auth, and sync are never served from a stale cache.
 */
const CACHE = "cafe-pos-shell-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== "biza-notification-binding").map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET; never touch POST/PUT (orders, sync, login).
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept API calls or the WebSocket — always go to the network so
  // data is never stale and auth/sync behave exactly as when fully online.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  // Navigations (page loads): network-first, fall back to offline page.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())),
    );
    return;
  }

  // Static assets (icons, etc.): cache-first for the few we precache.
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((r) => r || fetch(req)));
  }
});

/* -------------------------------------------------------------------------
 * Push notifications (Phase 35)
 *
 * This is the half of Web Push that runs with the app closed, and it is why
 * one implementation covers iOS, Android and Windows at once: Safari 16.4+
 * wakes this worker for a PWA the user added to the home screen, and
 * Chrome/Edge wake it on Android, Windows, macOS and Linux.
 *
 * Kept deliberately dumb: the server has already decided what to say, in
 * Persian, and rendered it into the payload (src/lib/notifications.ts). A
 * service worker has no session and no way to ask a follow-up question, so
 * anything it had to look up would be a notification that sometimes fails to
 * appear.
 * ------------------------------------------------------------------------- */

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    // A push with an unreadable body still means *something* happened, and a
    // silent drop is worse than a generic card the user can tap.
    payload = { title: "اعلان جدید", body: "", url: "/dashboard" };
  }

  event.waitUntil((async () => {
    const cache = await caches.open("biza-notification-binding");
    const binding = await cache.match("/__notification_binding");
    const identity = binding ? await binding.json() : null;
    // Late provider messages from a prior login must never expose that user's
    // facts on a shared till. A generic visible notice avoids silent-push abuse.
    if (!identity || payload.identity !== identity) {
      payload = { title: "اعلان تازه", body: "برای مشاهده وارد حساب خود شوید.", url: "/login", tag: "signed-out-notification" };
    }
    await self.registration.showNotification(payload.title || "اعلان جدید", {
      body: payload.body || "", icon: "/icon-192.png", badge: "/icon-192.png",
      tag: payload.tag || undefined, renotify: false, requireInteraction: false,
      dir: "rtl", lang: "fa",
      data: { url: payload.url || "/settings/notifications", notificationId: payload.notificationId || null },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/dashboard";

  event.waitUntil(
    (async () => {
      const url = new URL(target, self.location.origin);
      if (url.origin !== self.location.origin) return;
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

      // Reuse an open window rather than piling up tabs — on a till screen the
      // app is usually already open, and a second window on the same origin is
      // a second offline queue (Phase 5) nobody asked for.
      for (const client of clientList) {
        if (new URL(client.url).origin !== url.origin) continue;
        await client.focus();
        if ("navigate" in client) await client.navigate(url.href);
        return;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});

/**
 * The browser rotates a subscription on its own schedule and tells us here.
 * Without this handler the old endpoint stays registered and every push to it
 * fails until the user next opens the settings screen — which, for a phone that
 * only ever receives notifications, may be never.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const oldSubscription = event.oldSubscription || (await self.registration.pushManager.getSubscription());
      const applicationServerKey =
        (event.newSubscription && event.newSubscription.options.applicationServerKey) ||
        (oldSubscription && oldSubscription.options.applicationServerKey);
      if (!applicationServerKey) return;

      const subscription =
        event.newSubscription ||
        (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));

      const json = subscription.toJSON();
      await fetch("/api/notifications/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          p256dh: json.keys && json.keys.p256dh,
          auth: json.keys && json.keys.auth,
        }),
      }).catch(() => {
        // Nothing useful to do from a worker with no UI; the settings screen
        // re-registers on its next load.
      });
    })(),
  );
});

// Persistent across worker restarts; cleared by every first-party logout path.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "notification-binding") return;
  const identity = typeof event.data.identity === "string" ? event.data.identity : null;
  event.waitUntil((async () => {
    const cache = await caches.open("biza-notification-binding");
    await cache.put("/__notification_binding", new Response(JSON.stringify(identity), { headers: { "Content-Type": "application/json" } }));
    if (!identity) for (const notification of await self.registration.getNotifications()) notification.close();
  })());
});
