/**
 * Phase 46 — a cloud screen inside the desktop's till window.
 *
 * The desktop keeps the full menu and renders a cloud screen in its content
 * area (`<CloudPane>`, a hardened `<webview>`, electron/cloud-pane.js). The
 * cloud then renders that page without its own sidebar, so the desktop's menu
 * is the only one. It learns it is embedded from a user-agent token the pane
 * sends: presentation only — nothing is granted or withheld on the strength of
 * it, the cloud's session and API guards still decide everything.
 *
 * Framework-free and unit-tested.
 */

export const CLOUD_EMBED_UA_TOKEN = "BusinessSuiteEmbed/1";

export function isCloudEmbedUserAgent(userAgent: string | null | undefined): boolean {
  return Boolean(userAgent?.includes(CLOUD_EMBED_UA_TOKEN));
}

/**
 * The attribute the marker script below puts on `<html>` inside the pane.
 * globals.css hides the workspace shell's `[data-workspace-sidebar]` under it.
 */
export const CLOUD_EMBED_ATTRIBUTE = "data-cloud-embed";

/**
 * Why the server's user-agent check is not enough on its own: once the
 * cloud's service worker controls the pane, it forwards every page navigation
 * with Electron's *default* agent, not the <webview>'s, so the server never
 * sees the token and draws the sidebar (reproduced in Electron 44; setting the
 * agent on the pane's session does not reach those requests either). The
 * page's own `navigator.userAgent` always carries it, so the root layout runs
 * this inline, before the body is painted, and the sidebar never flashes.
 */
export const CLOUD_EMBED_MARKER_SCRIPT =
  `if(navigator.userAgent.indexOf(${JSON.stringify(CLOUD_EMBED_UA_TOKEN)})!==-1)` +
  `document.documentElement.setAttribute(${JSON.stringify(CLOUD_EMBED_ATTRIBUTE)},"")`;

/** `pathAndQuery` on the cloud's origin, or null: https only, and a `//host` path never re-aims it. */
export function cloudPageUrl(cloudUrl: string | null, pathAndQuery: string): string | null {
  if (!cloudUrl) return null;
  try {
    const base = new URL(cloudUrl);
    const url = new URL(pathAndQuery, base);
    return base.protocol === "https:" && url.origin === base.origin ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Cloud pages the desktop's address must not copy: signing in happens on the cloud, not here. */
const UNMIRRORED_PREFIXES = ["/login", "/desktop-login", "/api"];

/**
 * Where the desktop's own address should move when the embedded cloud page
 * navigates (so the menu highlights the right entry), or null to leave it.
 */
export function mirroredPath(guestUrl: string, cloudUrl: string | null): string | null {
  if (!cloudUrl) return null;
  try {
    const url = new URL(guestUrl);
    if (url.origin !== new URL(cloudUrl).origin) return null;
    if (UNMIRRORED_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
      return null;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** The key next-themes keeps the choice under (its default `storageKey`). */
const THEME_STORAGE_KEY = "theme";

/**
 * The script the desktop runs inside the pane so the cloud page wears the
 * till's light/dark theme. The pane is another origin with its own storage,
 * and the cloud's theme toggle lives in the sidebar the pane hides, so without
 * this the two halves of one window could disagree and nothing could fix it.
 * It stores the choice where next-themes reads it on the next load, and fires
 * the `storage` event next-themes listens to so the open page switches now.
 * Returns null for anything but `light`/`dark`: nothing else is ever sent.
 */
export function cloudThemeScript(theme: string | null | undefined): string | null {
  if (theme !== "light" && theme !== "dark") return null;
  const key = JSON.stringify(THEME_STORAGE_KEY);
  const value = JSON.stringify(theme);
  return (
    `(function(){try{var o=localStorage.getItem(${key});` +
    `if(o===${value})return;localStorage.setItem(${key},${value});` +
    `window.dispatchEvent(new StorageEvent("storage",{key:${key},oldValue:o,newValue:${value}}));` +
    `}catch(e){}})()`
  );
}
