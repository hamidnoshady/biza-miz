"use strict";

/**
 * Issue #1001 — the till window must never render a foreign page.
 *
 * `contextIsolation`/`sandbox` protect the main process from the page, but the
 * page itself still carries the privileged `window.businessSuiteDesktop`
 * preload. Anything that pulls an outside document into that main frame would
 * then hand that bridge to a foreign origin. `will-navigate` alone is not
 * enough: it does not fire for HTTP redirects (`will-redirect`) or for frame
 * navigations (`will-frame-navigate`, Electron 26+). A server-side redirect —
 * or an open redirect on the local server, or on any page the app loads — would
 * otherwise load an external document into the window.
 *
 * The one allowed document origin is the loopback application origin the
 * window was created for. A plain http(s) link leaves the app in the system
 * browser instead (the «بازکردن نسخهٔ ابری» link), and every other scheme
 * (`javascript:`, `file:`, `data:` …) is refused outright.
 */

const OPEN_EXTERNAL_DEDUPE_MS = 1_000;

/** "allow" (stay in the window) | "external" (system browser) | "deny". */
function navigationDecision(rawUrl, appUrl) {
  let target;
  let app;
  try {
    target = new URL(String(rawUrl));
    app = new URL(String(appUrl));
  } catch {
    return "deny";
  }
  if (target.origin === app.origin) return "allow";
  if (target.protocol === "http:" || target.protocol === "https:") return "external";
  return "deny";
}

/**
 * `will-redirect` and `will-frame-navigate` fire for the same navigation that
 * `will-navigate` reports, so the same refused URL would otherwise open two
 * browser tabs. One tab per URL per second is enough for a real click.
 */
function externalOpener(shell, now = () => Date.now()) {
  let last = { url: null, at: 0 };
  return (url) => {
    const stamp = now();
    if (last.url === url && stamp - last.at < OPEN_EXTERNAL_DEDUPE_MS) return;
    last = { url, at: stamp };
    void shell.openExternal(url);
  };
}

/**
 * Wire the guard onto a BrowserWindow's webContents. Returns the same handler
 * builder so a unit test can drive it without a real window.
 */
function installNavigationGuard(contents, appUrl, shell, { now } = {}) {
  const openExternal = externalOpener(shell, now);
  const guard = (event, url, mainFrame) => {
    const decision = navigationDecision(url, appUrl);
    if (decision === "allow") return;
    event.preventDefault();
    // A subframe that navigates off the app is stopped silently: opening a
    // browser tab from an embedded frame is not something a user asked for.
    if (decision === "external" && mainFrame !== false) openExternal(String(url));
  };
  contents.on("will-navigate", (event, url, _isInPlace, isMainFrame) => {
    guard(event, url, isMainFrame);
  });
  contents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    guard(event, url, event?.isMainFrame ?? isMainFrame);
  });
  contents.on("will-frame-navigate", (event, url, _isInPlace, isMainFrame) => {
    guard(event, url, event?.isMainFrame ?? isMainFrame);
  });
  return guard;
}

module.exports = { navigationDecision, installNavigationGuard, externalOpener, OPEN_EXTERNAL_DEDUPE_MS };
