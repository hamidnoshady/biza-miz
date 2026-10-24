/**
 * A tiny, dependency-free bridge between `unsaved-changes-guard.tsx` and
 * `navigation-pending.tsx` (issue #909 §9 — a single, consistent navigation
 * acknowledgment, regardless of whether the click went through the sidebar, a
 * section chip/quick action, or the guard's own «leave this page?» dialog).
 *
 * Both modules need one fact from the other — the guard needs to announce
 * "a navigation has now actually been committed" and the pending-indicator
 * needs to hear it — and importing one from the other directly would make the
 * two circular. A bare `window` event, declared once here, keeps them
 * independent: either can be used (or tested) without the other existing.
 */
export const NAVIGATION_COMMITTED_EVENT = "app:navigation-committed";

export interface NavigationCommittedDetail {
  /** Where the committed navigation is going. */
  href: string;
}
