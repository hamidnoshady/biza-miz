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
 * The rules about what the triple *means* are pure and live in
 * `master-balance-facts.ts`; this file is only the two database statements, so a
 * client component can import the rules without dragging a pool into the
 * browser bundle.
 */
import { query, withoutTenantScope } from "../db";
import { EMPTY_MASTER_BALANCE_MIRROR, type MasterBalanceMirror } from "./master-balance-facts";

const SCOPE = "kavenegar-master-balance";

export {
  EMPTY_MASTER_BALANCE_MIRROR,
  MASTER_BALANCE_STALE_HOURS,
  masterBalanceView,
  type MasterBalanceMirror,
  type MasterBalanceState,
  type MasterBalanceView,
} from "./master-balance-facts";

/**
 * Record what a funding pass saw.
 *
 * `observed` says whether the pass got an answer at all: a provider that timed
 * out leaves `rial`/`observedAt` untouched but still moves `checkedAt`, which is
 * what makes a previously-good figure readable as `unreadable` instead of
 * `current`. Both columns are written in one statement so the pairing constraint
 * in migration `0269` can never see a half-written observation.
 */
export async function recordMasterBalanceObservation(input: {
  /** The figure the provider reported; `null` when the read failed. */
  rial: number | null;
  /** Defaults to now; injectable so a test can place the observation in time. */
  at?: Date;
}): Promise<void> {
  const at = input.at ?? new Date();
  const rial =
    input.rial === null || !Number.isFinite(input.rial) ? null : Math.max(0, Math.trunc(input.rial));

  await withoutTenantScope(SCOPE, async () => {
    if (rial === null) {
      await query(
        `UPDATE platform_sms_config
            SET managed_master_balance_checked_at = $1
          WHERE id = 1`,
        [at],
      );
      return;
    }
    await query(
      `UPDATE platform_sms_config
          SET managed_master_balance_rial = $1,
              managed_master_balance_at = $2,
              managed_master_balance_checked_at = $2
        WHERE id = 1`,
      [rial, at],
    );
  });
}

/** The stored mirror, for the console snapshot. Never throws on an empty table. */
export async function readMasterBalanceMirror(): Promise<MasterBalanceMirror> {
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<{
      managed_master_balance_rial: string | number | null;
      managed_master_balance_at: Date | null;
      managed_master_balance_checked_at: Date | null;
    }>(
      `SELECT managed_master_balance_rial, managed_master_balance_at,
              managed_master_balance_checked_at
         FROM platform_sms_config WHERE id = 1`,
    );
    const row = rows[0];
    if (!row) return EMPTY_MASTER_BALANCE_MIRROR;
    return {
      // bigint arrives as a string over the pg driver, like every other money
      // column in this service.
      rial:
        row.managed_master_balance_rial === null
          ? null
          : Number(row.managed_master_balance_rial),
      observedAt: row.managed_master_balance_at?.toISOString() ?? null,
      checkedAt: row.managed_master_balance_checked_at?.toISOString() ?? null,
    };
  });
}
