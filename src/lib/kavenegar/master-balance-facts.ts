/**
 * Issue #902 §9 item 4, second half — the master balance the last pass saw.
 *
 * §5g made the funding pass read the master's own credit from the provider, so
 * a configured floor stopped being a switch that silently halted automation.
 * What it left out is the *evidence*: the figure lived inside the tick's local
 * variable and vanished when the tick returned, so the console could not show
 * it and an operator asking "how much headroom is left above the floor?" had to
 * read it live, by hand, from the provider.
 *
 * The mirror here is that figure plus the two timestamps needed to trust it:
 *
 *   * `rial` — what the provider reported, or `null` when it has never said.
 *   * `observedAt` — when that value was read. A balance with no age is a
 *     rumour: 40 000 000 Rial from yesterday and 40 000 000 Rial from four
 *     minutes ago say opposite things about whether the floor is safe.
 *   * `checkedAt` — when a pass last *tried*. Newer than `observedAt` means the
 *     last read failed, so the number on the screen is the previous observation
 *     and not the current balance. Collapsing the two into one timestamp is
 *     exactly how a stale figure comes to look live.
 *
 * Only a pass that read the provider writes `rial`/`observedAt`. An operator's
 * typed figure is an instruction, not an observation, and must never overwrite
 * evidence about what the provider said.
 *
 * The table is `platform_sms_config` — one row, the same row the policy lives
 * in — so the mirror costs no new table, no new key and no tenant scope.
 *
 * This half is **pure on purpose**: it carries no `db` import, because the
 * console is a client component and `client-bundle-boundary.test.ts` refuses to
 * let a database pool into the browser bundle. The persistence half lives in
 * `master-balance.ts`.
 */


/**
 * How old an observation may be before the console stops calling it current.
 *
 * The funding pass runs every 15 minutes, so anything measured in the last hour
 * is live. Six hours is six missed chances: the value is still the best evidence
 * available, but it is no longer a statement about *now*, and the console says
 * so rather than formatting it like a live number.
 */
export const MASTER_BALANCE_STALE_HOURS = 6;

export interface MasterBalanceMirror {
  /** The provider's last reported credit in Rial, or `null` if it never said. */
  rial: number | null;
  /** ISO instant the value was observed. `null` when there is no value. */
  observedAt: string | null;
  /** ISO instant a funding pass last tried to read, whatever the outcome. */
  checkedAt: string | null;
}

export const EMPTY_MASTER_BALANCE_MIRROR: MasterBalanceMirror = {
  rial: null,
  observedAt: null,
  checkedAt: null,
};

/**
 * The verdict the console renders, separated from the rendering so it can be
 * tested without a browser, a clock or a database.
 *
 * - `unknown`   — never observed. Not zero, and not "fine".
 * - `current`   — observed, and the last read attempt did not fail after it.
 * - `unreadable`— observed once, but a later pass could not read it. The figure
 *                 is honest history; it is not a claim about now.
 * - `stale`     — observed, but too long ago to describe the present.
 */
export type MasterBalanceState = "unknown" | "current" | "unreadable" | "stale";

export interface MasterBalanceView extends MasterBalanceMirror {
  state: MasterBalanceState;
  /** Age of the observation in whole minutes; `null` when nothing was observed. */
  ageMinutes: number | null;
}

/**
 * Turn the stored mirror into a verdict.
 *
 * `unreadable` outranks `stale`: a failed read is evidence *about* the figure,
 * and an operator needs to know the number is a leftover before they need to
 * know its age. A pass that failed five minutes ago on a value observed five
 * minutes before that is the one case where the age is uninteresting.
 */
export function masterBalanceView(
  mirror: MasterBalanceMirror,
  now: Date = new Date(),
): MasterBalanceView {
  if (mirror.rial === null || mirror.observedAt === null) {
    return { ...mirror, state: "unknown", ageMinutes: null };
  }

  const observed = Date.parse(mirror.observedAt);
  if (!Number.isFinite(observed)) {
    return { ...mirror, state: "unknown", ageMinutes: null };
  }

  // A clock skew that puts the observation in the future is age 0, not a
  // negative age that reads as "fresher than possible".
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - observed) / 60_000));

  const checked = mirror.checkedAt ? Date.parse(mirror.checkedAt) : Number.NaN;
  if (Number.isFinite(checked) && checked > observed) {
    return { ...mirror, state: "unreadable", ageMinutes };
  }
  if (ageMinutes > MASTER_BALANCE_STALE_HOURS * 60) {
    return { ...mirror, state: "stale", ageMinutes };
  }
  return { ...mirror, state: "current", ageMinutes };
}
