/**
 * Unsaved pay-term drafts (wage, allowances, fixed deduction), kept across a
 * navigation the guard cannot stop — issue #835 §7.
 *
 * The navigation guard (`unsaved-changes-guard.tsx`) turns a click on a link
 * into a prompt. Browser Back/Forward is different: the App Router offers no way
 * to cancel it, and faking one with sentinel history entries corrupts the back
 * stack. So when the payroll section unmounts with edits still in it, the edits
 * are kept here — in this tab's memory, for this signed-in member only — and
 * handed back, flagged as unsaved, if the section is opened again soon.
 *
 * Deliberately narrow, because it is compensation data:
 *
 *   - **memory only** — a module-level map, never `localStorage`/`sessionStorage`,
 *     so a reload (which the browser already warns about) clears it and nothing
 *     is written to disk;
 *   - **per member** — keyed by the member's own id (a membership is per
 *     business), so another person signing in on the same tab cannot be handed
 *     somebody else's half-typed salaries;
 *   - **short-lived** — forgotten after `DRAFT_MEMORY_TTL_MS`;
 *   - **explicit discard wins** — choosing «ترک صفحه و حذف تغییرات» forgets them.
 *
 * Drafts keep the unit they were typed in (`payroll-amount-drafts.ts`), so they
 * stay correct even if the display unit changed in between.
 */
import type { TermDrafts } from "./payroll-amount-drafts";

export const DRAFT_MEMORY_TTL_MS = 30 * 60 * 1000;

interface Remembered {
  drafts: Record<string, TermDrafts>;
  at: number;
}

const memory = new Map<string, Remembered>();

/** Keep `drafts` for `owner`; an empty set forgets instead (nothing to protect). */
export function rememberDrafts(owner: string, drafts: Record<string, TermDrafts>, now = Date.now()): void {
  if (Object.keys(drafts).length === 0) {
    memory.delete(owner);
    return;
  }
  memory.set(owner, { drafts: { ...drafts }, at: now });
}

/** What `owner` left unsaved, or `{}` when there is none or it is too old to trust. */
export function recallDrafts(owner: string, now = Date.now()): Record<string, TermDrafts> {
  const found = memory.get(owner);
  if (!found) return {};
  if (now - found.at > DRAFT_MEMORY_TTL_MS) {
    memory.delete(owner);
    return {};
  }
  return { ...found.drafts };
}

export function forgetDrafts(owner: string): void {
  memory.delete(owner);
}

/** For tests: drop everything. */
export function clearAllDrafts(): void {
  memory.clear();
}
