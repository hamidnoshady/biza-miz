"use strict";

/**
 * Phase 45 — the «نسخهٔ ابری» window.
 *
 * On a Hybrid desktop the till window shows only the till; every back-office
 * screen opens the cloud here. This window is deliberately powerless: no
 * preload, so a page from the Internet can never reach the till's IPC
 * (folders, firewall, printers), a sandboxed renderer, and a persistent
 * partition of its own so the cloud login survives restarts without sharing
 * the local server's cookies. Navigation and redirects stay on the cloud's
 * origin; anything else goes to the system browser. So do billing and subscription:
 * the payment gateway returns to a page that needs a session, and it must be
 * the browser's, which completes the flow end to end.
 */

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

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function offlinePageUrl(retryUrl) {
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>نسخهٔ ابری</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;font-family:Tahoma,sans-serif;background:#faf9f7;color:#292524">
<div style="text-align:center;line-height:2">
<p>اتصال به اینترنت برقرار نیست.</p>
<p>صندوق، میزها، آشپزخانه و شیفت روی این دستگاه کار می‌کنند؛ این بخش با برگشت اینترنت باز می‌شود.</p>
<a href="${escapeHtml(retryUrl)}" style="color:#0f766e">دوباره تلاش کنید</a>
</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createCloudWindowController({ BrowserWindow, shell }) {
  let win = null;
  let origin = null;
  // The last cloud page the window showed, where a client-side billing move returns.
  let lastPage = null;

  // A failed load is reported by did-fail-load; the promise's rejection is not news.
  const load = (target, url) => target.loadURL(url).catch(() => {});

  function create() {
    const created = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 620,
      title: "نسخهٔ ابری",
      autoHideMenuBar: true,
      webPreferences: {
        partition: "persist:cloud",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    const toBrowser = (event, url) => {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    };
    created.webContents.on("will-navigate", (event, url) => {
      if (sameOrigin(url, origin) && !opensInBrowser(url)) return;
      toBrowser(event, url);
    });
    // A 3xx does not fire will-navigate. Any other host — a renamed business
    // subdomain included — goes to the browser: a window with no address bar
    // must never adopt an origin it was not opened with.
    created.webContents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
      // A subframe (a website preview, a video embed) may redirect anywhere.
      if ((event.isMainFrame ?? isMainFrame) === false) return;
      if (sameOrigin(url, origin) && !opensInBrowser(url)) return;
      toBrowser(event, url);
    });
    const remember = (url) => {
      if (sameOrigin(url, origin) && !opensInBrowser(url)) lastPage = url;
    };
    created.webContents.on("did-navigate", (_event, url) => remember(url));
    // A client-side (Next.js) link fires neither of the above: send billing to
    // the browser and reload the last cloud page. Not goBack(): after a
    // router.replace there is no history entry to step back over.
    created.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (!opensInBrowser(url)) return remember(url);
      void shell.openExternal(url);
      if (lastPage) load(created, lastPage);
    });
    created.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: one navigation replaced by another, not a failure.
      if (isMainFrame && code !== -3 && !String(url).startsWith("data:")) load(created, offlinePageUrl(url));
    });
    created.on("closed", () => {
      win = null;
    });
    return created;
  }

  return {
    open(raw) {
      const target = cloudTarget(raw);
      if (!target) return false;
      if (opensInBrowser(target)) {
        void shell.openExternal(target.toString());
        return true;
      }
      if (!win || win.isDestroyed()) win = create();
      origin = target.origin;
      lastPage = target.toString();
      load(win, lastPage);
      if (win.isMinimized()) win.restore();
      win.focus();
      return true;
    },
    /** The cloud window never outlives the till: main.js calls this when the till closes. */
    close() {
      if (win && !win.isDestroyed()) win.close();
    },
  };
}

module.exports = { cloudTarget, sameOrigin, opensInBrowser, offlinePageUrl, createCloudWindowController };
