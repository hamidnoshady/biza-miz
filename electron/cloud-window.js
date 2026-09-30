"use strict";

/**
 * Phase 45 — the «نسخهٔ ابری» window.
 *
 * On a Hybrid desktop the till window shows only the till; every back-office
 * screen opens the cloud here. This window is deliberately powerless: no
 * preload, so a page from the Internet can never reach the till's IPC
 * (folders, firewall, printers), a sandboxed renderer, and a persistent
 * partition of its own so the cloud login survives restarts without sharing
 * the local server's cookies. Navigation stays on the cloud's origin;
 * anything else goes to the system browser.
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
    created.webContents.on("will-navigate", (event, url) => {
      if (sameOrigin(url, origin)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });
    created.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: one navigation replaced by another, not a failure.
      if (isMainFrame && code !== -3 && !String(url).startsWith("data:")) void created.loadURL(offlinePageUrl(url));
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
      if (!win || win.isDestroyed()) win = create();
      origin = target.origin;
      void win.loadURL(target.toString());
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

module.exports = { cloudTarget, sameOrigin, offlinePageUrl, createCloudWindowController };
