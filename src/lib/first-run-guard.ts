/**
 * The one server-side first-run guard (issue #1239 / ESH-90).
 *
 * Before this module existed the only place a *new* business was sent to the
 * wizard was `/` (`src/lib/root-landing.ts`). Everything the owner could reach
 * afterwards — a bookmark, browser Back, `?next=/dashboard` after login, the
 * native app's deep link, another business switched to through the desktop
 * client — landed straight in the workspace with an unfinished setup. The
 * wizard was therefore advisory, not enforced.
 *
 * The decision lives here, pure and framework-free, for the same reason
 * `root-landing.ts` does: the tests pin the policy without standing up Next,
 * and the one caller (the workspace shell) cannot drift from it.
 *
 * ## Who is sent back
 *
 * Only a member who can actually *finish* the wizard — `settings.manage`, which
 * is what `/setup` itself demands. A cashier, a waiter or a CRM agent is never
 * redirected into a screen they are forbidden to use (that was the "trapped in
 * an owner-only wizard" failure the epic names); they keep the dashboard they
 * have always had.
 *
 * ## What stays reachable
 *
 * An unfinished owner still needs a way to pay for a connection, top up the
 * wallet, secure their account, read help and ask support. Those paths are
 * exempt, so the guard cannot create a redirect loop with the wizard's own
 * hand-off — and `/setup` never redirects to `/settings` while incomplete, so
 * the two cannot bounce a request between them.
 */

/**
 * The workspace routes the guard owns. `/knowledge`, `/support` and `/media`
 * are deliberately absent: they are the recovery/help surfaces an owner may
 * genuinely need mid-setup, and they carry their own permission gates.
 * `/dashboard` is the one landing page every login and `?next=` target points
 * at.
 *
 * GitHub #1580 adds `/settings` and `/petty-cash`: before onboarding finishes,
 * the internal settings area (data transfer, tax/users configuration, the
 * technical connection hub's non-recovery pages) and the petty-cash workspace
 * are ordinary operational screens, not onboarding surfaces. The narrow
 * `/settings/*` exceptions below stay reachable — an owner still has to be able
 * to pay, secure the account, recover a provider connection or read help.
 */
const GUARDED_PREFIXES = [
  "/dashboard",
  "/accounting",
  "/crm",
  "/growth",
  "/websites",
  "/workspace",
  "/ai",
  "/overview",
  "/settings",
  "/petty-cash",
] as const;

/** Reachable during first-run setup, even though they sit under `/settings`. */
const EXEMPT_PREFIXES = [
  "/setup",
  "/settings/billing",
  "/settings/security",
  "/settings/profile",
  "/settings/connections",
] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export interface FirstRunGateInput {
  /** The request's pathname, without the query string. */
  pathname: string;
  /** `setup.progress.completedAt` — the canonical marker, nothing else. */
  setupComplete: boolean;
  /** The member's *effective* permission set for this request. */
  canManageSettings: boolean;
}

/**
 * `"/setup"` when this request must be sent to the wizard, otherwise `null`.
 *
 * A missing/empty pathname answers `null`: the shell only knows the path
 * because middleware stamps `x-pathname`, and a runtime that did not stamp it
 * (a direct component render, a test) must not be answered with a blanket
 * redirect to the wizard for every page.
 */
export function firstRunRedirect(input: FirstRunGateInput): string | null {
  if (input.setupComplete) return null;
  if (!input.canManageSettings) return null;

  const pathname = input.pathname.trim();
  if (!pathname) return null;
  if (EXEMPT_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) return null;
  if (!GUARDED_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) return null;
  return "/setup";
}
