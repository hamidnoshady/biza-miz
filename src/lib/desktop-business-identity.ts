/**
 * electron/profile-registry.js's `recordProfileIdentity` — the #1572 follow-up
 * that names a saved business after its own enrollment/pairing (issue #1571 /
 * #1572 / ESH-223).
 *
 * The picker creates a profile with no identity columns, because at that moment
 * the business has not enrolled yet. The setup wizard then runs *inside* that
 * profile's data root, and `/api/setup/pair` is where it commits the snapshot.
 * That response is the first place the app can prove three facts: the tenant id,
 * the canonical subdomain and the cloud origin. They are handed to the shell,
 * which fills only the still-empty fields of the profile it is actually running
 * and writes them atomically. Nothing secret crosses: the registry keeps
 * metadata only, and the shell never accepts a profile id from the renderer.
 */
import type {
  DesktopBusinessIdentity,
  DesktopBusinessIdentityResult,
} from "./desktop-bridge";

/**
 * Best-effort: a browser (or an older shell) has no bridge and this is a no-op.
 * A refused report is deliberately silent — enrollment has already succeeded,
 * and a metadata gap must never surface as a pairing failure. The next launch
 * re-reads the registry, and the identity is filled in by the next enrollment.
 */
export function recordDesktopBusinessIdentity(
  identity: Partial<DesktopBusinessIdentity>,
): void {
  if (typeof window === "undefined") return;
  const bridge = window.businessSuiteDesktop?.business;
  if (typeof bridge?.recordIdentity !== "function") return;
  if (typeof identity.businessId !== "string" || !identity.businessId) return;
  void bridge
    .recordIdentity({
      businessId: identity.businessId,
      businessSubdomain: identity.businessSubdomain ?? null,
      cloudOrigin: identity.cloudOrigin ?? null,
    })
    .then((result: DesktopBusinessIdentityResult) => {
      if (!result.ok) {
        console.warn("desktop business identity not recorded:", result.error);
      }
    })
    .catch(() => {});
}
