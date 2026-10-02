"use strict";

/**
 * Phase 46 — cloud screens inside the till window.
 *
 * Phase 45 opened every cloud screen (CRM, growth, the assistant, the books)
 * in a second window. Owners asked for one app instead: the desktop keeps the
 * full menu, and a cloud screen renders in the till window's content area
 * through a <webview> — like a built-in browser, with no new window.
 *
 * The guest is deliberately powerless, the same guarantees the old window
 * had: no preload (a page from the Internet never reaches the till's IPC —
 * folders, firewall, printers), a sandboxed renderer, and a persistent
 * partition of its own so the cloud login survives restarts without sharing
 * the local server's cookies. Navigation and redirects stay on the cloud's
 * origin; anything else goes to the system browser. So do billing and
 * subscription: the payment gateway returns to a page that needs a session,
 * and it must be the browser's, which completes the flow end to end.
 */

const CLOUD_PARTITION = "persist:cloud";

function cloudTarget(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function sameOrigin(raw, origin) {
  try {
    return new URL(String(raw)).origin === origin;
  } catch {
    return false;
  }
}

/** Billing and subscription pay through a gateway, so they run in the system browser. */
function opensInBrowser(raw) {
  try {
    const { pathname } = new URL(String(raw));
    return ["/settings/billing", "/settings/subscription"].some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
  } catch {
    return false;
  }
}

/**
 * `will-attach-webview`: whatever the page asked for, the guest gets no
 * preload, no Node, a sandbox and the cloud partition. Returns the origin the
 * guest is pinned to, or null to refuse the attach (not an https address).
 */
function hardenCloudPane(webPreferences, params) {
  const target = cloudTarget(params?.src);
  if (!target) return null;
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  params.partition = CLOUD_PARTITION;
  delete params.allowpopups;
  return target.origin;
}

/** `did-attach-webview`: the guest's navigation stays on the origin it was attached with. */
function guardCloudPane(contents, origin, shell) {
  // The last cloud page the pane showed, where a client-side billing move returns.
  let lastPage = null;
  const external = (url) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  contents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  const allowed = (url) => sameOrigin(url, origin) && !opensInBrowser(url);
  contents.on("will-navigate", (event, url) => {
    if (allowed(url)) return;
    event.preventDefault();
    external(url);
  });
  // A 3xx does not fire will-navigate. Any other host — a renamed business
  // subdomain included — goes to the browser: a pane with no address bar must
  // never adopt an origin it was not opened with.
  contents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    // A subframe (a website preview, a video embed) may redirect anywhere.
    if ((event.isMainFrame ?? isMainFrame) === false) return;
    if (allowed(url)) return;
    event.preventDefault();
    external(url);
  });
  contents.on("did-navigate", (_event, url) => {
    if (allowed(url)) lastPage = url;
  });
  // A client-side (Next.js) link fires neither of the above: send billing to
  // the browser and reload the last cloud page.
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (!opensInBrowser(url)) {
      if (allowed(url)) lastPage = url;
      return;
    }
    external(url);
    if (lastPage) contents.loadURL(lastPage).catch(() => {});
  });
}

module.exports = { CLOUD_PARTITION, cloudTarget, sameOrigin, opensInBrowser, hardenCloudPane, guardCloudPane };
