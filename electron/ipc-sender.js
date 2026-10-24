"use strict";

/**
 * Issue #1001 — who may call a `desktop:*` IPC handler.
 *
 * The preload bridge (`window.businessSuiteDesktop`) is exposed to whatever the
 * window's main frame loads. `contextIsolation` keeps an untrusted page away
 * from Node, but it does not stop one from *calling* the bridge: any document
 * that ends up in that frame — a server-side redirect to another origin, an
 * error page, an injected iframe in the same frame — inherits the same
 * privileged bridge. So every handler that can act with desktop authority
 * (firewall/UAC, update install, the local gateway, printing, folder picking)
 * must re-check, on every invocation, that the caller is:
 *
 *   1. this window's own webContents (not a <webview> guest),
 *   2. its **main frame** (not a subframe), and
 *   3. still on the application origin the window was created for.
 *
 * Check (3) is repeated after any asynchronous work in a handler that already
 * does it (`gateway-ipc-authorization.js`) because the renderer can navigate
 * while an answer is in flight. `registerTrustedHandler` is the one wrapper
 * `main.js` uses so a new handler cannot quietly skip the check.
 */

/** Is this IPC event the main frame of `window` on `appUrl`'s origin? */
function isTrustedAppFrame(event, window, appUrl) {
  if (!event || !window || typeof window.isDestroyed !== "function") return false;
  if (window.isDestroyed() || !appUrl) return false;
  const contents = window.webContents;
  if (!contents) return false;
  if (event.sender !== contents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== contents.mainFrame) return false;
  try {
    return new URL(frame.url).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

function assertTrustedSender(event, window, appUrl) {
  if (!isTrustedAppFrame(event, window, appUrl)) throw new Error("ipc_sender_forbidden");
}

/**
 * `ipcMain.handle`, with the sender check in front of the handler.
 * `context` is read per invocation so the wrapper survives a recreated window.
 */
function registerTrustedHandler(ipcMain, channel, context, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    assertTrustedSender(event, context.window?.(), context.appUrl?.());
    return handler(event, payload);
  });
}

module.exports = { isTrustedAppFrame, assertTrustedSender, registerTrustedHandler };
