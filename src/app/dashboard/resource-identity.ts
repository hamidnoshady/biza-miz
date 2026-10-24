"use client";

/**
 * A single, app-wide signal for "the business/branch/user/permission context
 * a scoped resource was loaded under may no longer be the one in effect" —
 * issue #909 §13's `useResourceState` gap: the hook's own doc said a
 * `scopeKey` must encode "anything from the business/branch/permission
 * context that the same component could re-render under", but no section
 * actually did, because most of that context never changes without the page
 * itself unmounting (a login, a `switch-business` redirect) — *except* the
 * branch switcher, which deliberately stays mounted across a switch
 * (`branch-switcher.tsx`'s `switchTo()` calls `router.refresh()`, not a
 * navigation) so the sidebar does not flash. A mounted `useResourceState`
 * instance's own `scopeKey` (dates, filters, a party id) is untouched by a
 * branch switch, so without this it kept showing the *previous* branch's
 * figures — VAT, trial balance, installments, the journal, the ledger
 * overview — until something unrelated happened to bump its `refreshSignal`.
 *
 * Rather than threading the business/branch/user id into every section's own
 * `scopeKey` (most do not have one or more of those to hand without new prop
 * drilling, and every one of them would have to remember to), every
 * `useResourceState` instance mixes in a shared "identity generation" number
 * from here. Anything that changes who the session effectively is —
 * today, only the branch switcher — bumps it once; every mounted resource
 * everywhere then sees its *effective* scope key change and clears its data
 * exactly like a real scope change, with no section-specific wiring. A user
 * or permission change today always arrives with a full page load (sign-in,
 * sign-out, a `switch-business` redirect), which already remounts every
 * hook instance from scratch — this module is what covers the one case that
 * does not.
 */
import { useSyncExternalStore } from "react";

let generation = 0;
const listeners = new Set<() => void>();

/** Call after anything that changes the effective business/branch/user/permission context in place (no navigation). */
export function invalidateResourceIdentity() {
  generation += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return generation;
}

/** Always `0` on the server — identity only ever changes client-side, after hydration. */
function getServerSnapshot() {
  return 0;
}

/** The current identity generation, re-rendering the caller whenever `invalidateResourceIdentity` runs. */
export function useResourceIdentityGeneration(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test-only escape hatch: resets the module-level counter between test files that import this singleton. */
export function __resetResourceIdentityForTests() {
  generation = 0;
  listeners.clear();
}
