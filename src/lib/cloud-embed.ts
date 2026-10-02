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
