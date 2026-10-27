/**
 * Issue #902 — wholesale reconciliation: does the provider agree with us?
 *
 * There are two independent records of the same money:
 *
 *   * **ours** — `kavenegar_credit_transfers` (what we funded) minus
 *     `message_outbox.provider_cost_rial` (what the provider said each send
 *     cost), per child;
 *   * **the provider's** — the child's `remaincredit`.
 *
 * If they disagree by more than the in-flight tolerance, one of them is wrong
 * and the console has to say so before a tenant's messages start failing for
 * lack of credit. The run is stored, not logged, so "was it right yesterday?"
 * is answerable.
 *
 * The comparison and the tolerance rule are pure; the pass that fetches the
 * child and writes the row is at the bottom, with an injectable client. Retail
 * money is read but never written: this module is evidence, not a ledger.
 */
import { query, withoutTenantScope } from "../db";
import type { KavenegarManagementClient } from "./rest";
import type { ProvisionState } from "./provisioning";
import { getManagedChildPolicy } from "./policy";

export type ReconciliationState = "ok" | "drift" | "incomplete";

export interface ReconciliationInput {
  /** Provider-reported child balance, or null when the read failed. */
  providerBalanceRial: number | null;
  /** Sum of applied positive transfers in the window. */
  creditTransferredRial: number;
  /** Sum of provider cost recorded on sent messages in the window. */
  providerCostRial: number;
  /** What the tenant's wallet was charged in the window (evidence only). */
  retailChargedRial: number;
  /**
   * Rial of tolerance. In-flight sends and provider rounding mean an exact
   * match is unrealistic; the tolerance is explicit so drift is never hidden by
   * a subtraction that "looks close".
   */
  toleranceRial: number;
}

export interface ReconciliationResult {
  expectedBalanceRial: number | null;
  deltaRial: number | null;
  state: ReconciliationState;
  detail: {
    toleranceRial: number;
    negative: boolean;
    /** Retail minus provider cost in the window; null when cost is unknown. */
    marginRial: number | null;
  };
}

/** Default tolerance: one Persian message at a typical wholesale rate. */
export const DEFAULT_RECONCILIATION_TOLERANCE_RIAL = 1_000;

/**
 * Compare our journal with the provider's balance.
 *
 * `expected = funded − spent`. A provider balance ABOVE expected means we
 * under-recorded funding or provider cost (or a send failed after billing);
 * BELOW means we spent more than we recorded. Either direction is drift; the
 * sign is kept so the operator knows which way to look.
 */
export function reconcileProviderBalance(input: ReconciliationInput): ReconciliationResult {
  const tolerance = Math.max(0, Math.trunc(input.toleranceRial));
  const expected =
    Math.trunc(input.creditTransferredRial) - Math.trunc(input.providerCostRial);
  const marginRial = input.retailChargedRial - input.providerCostRial;
  if (input.providerBalanceRial === null || !Number.isFinite(input.providerBalanceRial)) {
    return {
      expectedBalanceRial: expected,
      deltaRial: null,
      state: "incomplete",
      detail: { toleranceRial: tolerance, negative: expected < 0, marginRial },
    };
  }
  const providerBalance = Math.trunc(input.providerBalanceRial);
  const delta = providerBalance - expected;
  return {
    expectedBalanceRial: expected,
    deltaRial: delta,
    state: Math.abs(delta) <= tolerance ? "ok" : "drift",
    detail: { toleranceRial: tolerance, negative: expected < 0, marginRial },
  };
}

/**
 * The bucket end a run writes: the next whole hour (or the current one when the
 * clock is exactly on the hour).
 *
 * The bucket, not the exact timestamp, is the run's identity: two passes in the
 * same hour must not produce two rows for the same account. The window itself
 * starts when the child was provisioned, because the provider's `remaincredit`
 * is a lifetime balance — reconciling only the last 24 hours against a lifetime
 * balance would report drift that is really just history.
 */
export function reconciliationBucketEnd(now: Date): Date {
  const end = new Date(now);
  end.setUTCMinutes(0, 0, 0);
  if (end.getTime() < now.getTime()) end.setUTCHours(end.getUTCHours() + 1);
  return end;
}

export type ReconciliationRunRow = {
  id: string;
  business_id: string;
  account_id: string | null;
  window_start: Date;
  window_end: Date;
  provider_balance_rial: string | number | null;
  expected_balance_rial: string | number | null;
  delta_rial: string | number | null;
  credit_transferred_rial: string | number;
  provider_cost_rial: string | number;
  retail_charged_rial: string | number;
  state: ReconciliationState;
  detail: Record<string, unknown>;
  created_at: Date;
};

interface WindowSums {
  creditTransferredRial: number;
  providerCostRial: number;
  retailChargedRial: number;
}

async function sumsFor(
  businessId: string,
  start: Date,
  end: Date,
): Promise<WindowSums> {
  const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
    query<{
      transferred: string | number | null;
      provider_cost: string | number | null;
      retail: string | number | null;
    }>(
      `SELECT
         (SELECT COALESCE(sum(amount_rial), 0)
            FROM kavenegar_credit_transfers
           WHERE business_id = $1 AND state = 'applied'
             AND amount_rial > 0
             AND applied_at >= $2 AND applied_at < $3) AS transferred,
         (SELECT COALESCE(sum(provider_cost_rial), 0)
            FROM message_outbox
           WHERE business_id = $1 AND status IN ('sent', 'delivered')
             AND sent_at >= $2 AND sent_at < $3) AS provider_cost,
         (SELECT COALESCE(sum(r.rated_amount_rial), 0)
            FROM billing_usage_events e
            JOIN billing_usage_ratings r ON r.usage_event_id = e.id
           WHERE e.business_id = $1 AND e.source = 'messaging'
             AND e.occurred_at >= $2 AND e.occurred_at < $3) AS retail`,
      [businessId, start, end],
    ),
  );
  const row = rows[0];
  return {
    creditTransferredRial: numberOr(row?.transferred, 0),
    providerCostRial: numberOr(row?.provider_cost, 0),
    retailChargedRial: numberOr(row?.retail, 0),
  };
}

export interface ReconcileBusinessInput {
  businessId: string;
  client: KavenegarManagementClient;
  now?: Date;
  toleranceRial?: number;
}

/**
 * Reconcile one child for one window and store the result.
 *
 * The provider read is by the child's stable local id, which works even when
 * our stored key is the suspect — reconciliation is exactly the moment a key
 * problem would otherwise hide the balance.
 */
export async function reconcileManagedChild(
  input: ReconcileBusinessInput,
): Promise<ReconciliationRunRow | null> {
  const now = input.now ?? new Date();
  const windowEnd = reconciliationBucketEnd(now);

  const account = await withoutTenantScope("kavenegar-provisioning", async () => {
    const { rows } = await query<{
      id: string;
      localid: string;
      provision_state: ProvisionState;
      created_at: Date;
      provisioned_at: Date | null;
    }>(
      `SELECT id, localid, provision_state, created_at, provisioned_at
         FROM kavenegar_business_accounts WHERE business_id = $1`,
      [input.businessId],
    );
    return rows[0] ?? null;
  });
  if (!account) return null;
  // Lifetime window: the provider's balance is cumulative for the child.
  const windowStart = account.provisioned_at ?? account.created_at;

  let providerBalanceRial: number | null = null;
  try {
    const child = await input.client.fetchChildByLocalId(account.localid);
    providerBalanceRial = child.remainCreditRial;
    await withoutTenantScope("kavenegar-provisioning", async () => {
      await query(
        `UPDATE kavenegar_business_accounts
            SET provider_balance_rial = $2, provider_balance_at = now(), updated_at = now()
          WHERE id = $1`,
        [account.id, providerBalanceRial],
      );
    });
  } catch (error) {
    // A failed read is `incomplete`, not `drift`: the difference is whether we
    // know the provider's number, and pretending otherwise would page someone
    // for a network blip.
    console.error(
      `kavenegar reconciliation read failed for business ${input.businessId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  const sums = await sumsFor(input.businessId, windowStart, windowEnd);
  const result = reconcileProviderBalance({
    providerBalanceRial,
    ...sums,
    toleranceRial: input.toleranceRial ?? DEFAULT_RECONCILIATION_TOLERANCE_RIAL,
  });

  const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
    query<ReconciliationRunRow>(
      `INSERT INTO kavenegar_reconciliation_runs
         (business_id, account_id, window_start, window_end,
          provider_balance_rial, expected_balance_rial, delta_rial,
          credit_transferred_rial, provider_cost_rial, retail_charged_rial,
          state, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (business_id, window_end) DO NOTHING
       RETURNING id, business_id, account_id, window_start, window_end,
                 provider_balance_rial, expected_balance_rial, delta_rial,
                 credit_transferred_rial, provider_cost_rial, retail_charged_rial,
                 state, detail, created_at`,
      [
        input.businessId,
        account.id,
        windowStart,
        windowEnd,
        providerBalanceRial,
        result.expectedBalanceRial,
        result.deltaRial,
        sums.creditTransferredRial,
        sums.providerCostRial,
        sums.retailChargedRial,
        result.state,
        JSON.stringify(result.detail),
      ],
    ),
  );
  return rows[0] ?? null;
}

export interface ReconciliationSweepResult {
  checked: number;
  drifted: number;
  incomplete: number;
}

/**
 * Reconcile a bounded set of children.
 *
 * Bounded on purpose: each child costs one provider read, and a fleet-wide pass
 * must never turn a provider hiccup into a queue of retries. Drift is logged —
 * the console shows the stored runs, so an operator sees it without reading
 * server logs.
 */
export async function runManagedReconciliationSweep(input: {
  client: KavenegarManagementClient;
  now?: Date;
  limit?: number;
}): Promise<ReconciliationSweepResult> {
  // Same rule as funding: no opt-in, no scheduled provider traffic.
  const policy = await getManagedChildPolicy();
  if (!policy.enabled) return { checked: 0, drifted: 0, incomplete: 0 };
  const limit = Math.min(Math.max(1, input.limit ?? 25), 100);
  const businesses = await withoutTenantScope("platform", async () => {
    const { rows } = await query<{ business_id: string }>(
      `SELECT business_id
         FROM kavenegar_business_accounts
        WHERE provision_state = 'active'
        ORDER BY COALESCE(provider_balance_at, created_at) ASC
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => row.business_id);
  });

  const result: ReconciliationSweepResult = { checked: 0, drifted: 0, incomplete: 0 };
  for (const businessId of businesses) {
    try {
      const run = await reconcileManagedChild({
        businessId,
        client: input.client,
        now: input.now,
      });
      if (!run) continue;
      result.checked += 1;
      if (run.state === "drift") {
        result.drifted += 1;
        console.error(`kavenegar reconciliation drift for business ${businessId}`);
      }
      if (run.state === "incomplete") result.incomplete += 1;
    } catch (error) {
      console.error(
        `kavenegar reconciliation failed for business ${businessId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return result;
}

/** Console read: newest runs, drift first. */
export async function listReconciliationRuns(input: {
  limit?: number;
} = {}): Promise<ReconciliationRunRow[]> {
  const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
  const { rows } = await withoutTenantScope("platform", async () =>
    query<ReconciliationRunRow>(
      `SELECT id, business_id, account_id, window_start, window_end,
              provider_balance_rial, expected_balance_rial, delta_rial,
              credit_transferred_rial, provider_cost_rial, retail_charged_rial,
              state, detail, created_at
         FROM kavenegar_reconciliation_runs
        ORDER BY (state = 'drift') DESC, created_at DESC
        LIMIT $1`,
      [limit],
    ),
  );
  return rows;
}

function numberOr(value: string | number | null | undefined, fallback: number): number {
  const parsed = value === null || value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
