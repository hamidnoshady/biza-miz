/**
 * Platform business-wallet operations: balances, the credit ledger, online
 * payments (Zarinpal) and manual top-up approval.
 *
 * This is the single payment system every important platform function spends
 * from. A per-use feature charge is `chargeFeatureUse`; add-on/plan purchases
 * go through the payment flow and land as ledger credits/entitlements.
 *
 * Every balance mutation is a row-locked transaction (`SELECT … FOR UPDATE`
 * on the wallet row) so two concurrent requests can never spend or grant the
 * same Rial twice. Money is integer Rial everywhere.
 */
import { getPool, query, withTenant, type PoolClient } from "./db";
import { consumePlanAllowanceTx, getPlanAllowance } from "./ai-plan-allowance";
import {
  zarinpalRequest,
  zarinpalVerify,
  zarinpalPaymentUrl,
  GatewayError,
  type PaymentGatewayConfig,
} from "./payment-gateway";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LedgerKind =
  | "top_up"
  | "payment"
  | "admin_grant"
  | "refund"
  | "feature_charge"
  | "addon_purchase"
  | "plan_fee"
  | "subscription"
  | "admin_adjust"
  | "free_promo";

export interface WalletSummary {
  businessId: string;
  balanceRial: number;
  totalToppedUpRial: number;
  totalSpentRial: number;
  aiDebtRial?: number;
  netBalanceRial?: number;
}

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  direction: "credit" | "debit";
  amountRial: number;
  balanceAfterRial: number;
  featureKey: string | null;
  note: string | null;
  createdAt: string;
}

export interface CreditPackage {
  id: string;
  name: string;
  priceRial: number;
  creditRial: number;
  isActive: boolean;
  sortOrder: number;
}

export type PaymentStatus = "pending" | "redirect" | "verified" | "failed" | "cancelled";

export type PaymentFulfilmentStatus = "pending" | "succeeded" | "failed";

export interface PaymentRecord {
  id: string;
  businessId: string;
  gateway: "manual" | "zarinpal";
  sandbox?: boolean;
  purpose: "top_up" | "plan_purchase" | "addon_purchase";
  packageId: string | null;
  planKey: string | null;
  featureKey: string | null;
  amountRial: number;
  creditRial: number;
  description: string;
  status: PaymentStatus;
  authority: string | null;
  gatewayRef: string | null;
  fulfilmentStatus?: PaymentFulfilmentStatus;
  fulfilledAt?: string | null;
  fulfilmentError?: string | null;
  createdAt: string;
  verifiedAt: string | null;
  businessName?: string | null;
}

export class WalletInsufficientFundsError extends Error {
  constructor(
    public requiredRial: number,
    public balanceRial: number,
  ) {
    super("insufficient_credits");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function n(v: string | number | null | undefined): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function positiveInt(v: number): boolean {
  return Number.isSafeInteger(v) && v > 0;
}

/**
 * Credit or debit the wallet on a connection that is already inside a
 * transaction. Does not BEGIN or COMMIT.
 */
export async function postWalletEntryTx(
  client: PoolClient,
  entry: {
    businessId: string;
    kind: LedgerKind;
    direction: "credit" | "debit";
    amountRial: number;
    featureKey?: string | null;
    paymentId?: string | null;
    note?: string | null;
    metadata?: Record<string, unknown>;
    userId?: string | null;
    platformAdminId?: string | null;
  },
): Promise<{ id: string; balanceAfterRial: number }> {
  await client.query(
    `INSERT INTO business_wallets (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`,
    [entry.businessId],
  );
  await client.query(`SELECT business_id FROM business_wallets WHERE business_id = $1 FOR UPDATE`, [entry.businessId]);
  if (entry.direction === "debit") {
    const { rows } = await client.query<{ balance_rial: string }>(
      `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
      [entry.businessId],
    );
    const balance = n(rows[0]?.balance_rial);
    if (balance < entry.amountRial) throw new WalletInsufficientFundsError(entry.amountRial, balance);
  }
  return writeLedger(client, entry);
}

/** Runs `fn` inside a transaction with the row lock on the wallet held. */
async function withWalletTx<T>(
  client: PoolClient,
  businessId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    await client.query("BEGIN");
    // Ensures the wallet row exists and locks it for the transaction.
    await client.query(
      `INSERT INTO business_wallets (business_id) VALUES ($1)
       ON CONFLICT (business_id) DO NOTHING`,
      [businessId],
    );
    await client.query(
      `SELECT business_id FROM business_wallets WHERE business_id = $1 FOR UPDATE`,
      [businessId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

async function writeLedger(
  client: PoolClient,
  entry: {
    businessId: string;
    kind: LedgerKind;
    direction: "credit" | "debit";
    amountRial: number;
    featureKey?: string | null;
    paymentId?: string | null;
    note?: string | null;
    metadata?: Record<string, unknown>;
    userId?: string | null;
    platformAdminId?: string | null;
  },
): Promise<{ id: string; balanceAfterRial: number }> {
  const delta = entry.direction === "credit" ? entry.amountRial : -entry.amountRial;
  // Callers that debit (chargeFeatureUse / deductCredits) check cover before
  // writing; the GREATEST keeps a bug from ever producing a negative balance.
  const isTopUp = entry.kind === "top_up" || entry.kind === "payment";
  const reversesSpend = entry.direction === "credit" && entry.metadata?.reversesSpend === true;
  await client.query(
    `UPDATE business_wallets
        SET balance_rial = GREATEST(0, balance_rial + $2),
            total_topped_up_rial = CASE WHEN $3 THEN total_topped_up_rial + $4 ELSE total_topped_up_rial END,
            total_spent_rial     = CASE
                                     WHEN $5 THEN total_spent_rial + $4
                                     WHEN $6 THEN GREATEST(0, total_spent_rial - $4)
                                     ELSE total_spent_rial
                                   END,
            updated_at = now()
      WHERE business_id = $1`,
    [entry.businessId, delta, isTopUp, entry.amountRial, entry.direction === "debit", reversesSpend],
  );
  const { rows: ledgerRows } = await client.query<{ id: string; balance_after_rial: string }>(
    `INSERT INTO wallet_ledger
       (business_id, kind, direction, amount_rial, balance_after_rial,
        feature_key, payment_id, note, metadata, created_by_user_id, platform_admin_id)
     SELECT $1, $2, $3, $4, balance_rial, $5, $6, $7, $8::jsonb, $9, $10
       FROM business_wallets WHERE business_id = $1
     RETURNING id, balance_after_rial`,
    [
      entry.businessId,
      entry.kind,
      entry.direction,
      entry.amountRial,
      entry.featureKey ?? null,
      entry.paymentId ?? null,
      entry.note ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.userId ?? null,
      entry.platformAdminId ?? null,
    ],
  );
  return { id: ledgerRows[0].id, balanceAfterRial: n(ledgerRows[0].balance_after_rial) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getWallet(businessId: string): Promise<WalletSummary> {
  await query(
    `INSERT INTO business_wallets (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`,
    [businessId],
  );
  const { rows } = await query<{
    balance_rial: string;
    total_topped_up_rial: string;
    total_spent_rial: string;
    ai_debt_rial: string;
  }>(
    `SELECT w.balance_rial, w.total_topped_up_rial, w.total_spent_rial,
            COALESCE(d.debt_rial, 0)::text AS ai_debt_rial
       FROM business_wallets w
       LEFT JOIN ai_wallet_debt d ON d.business_id = w.business_id
      WHERE w.business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  const balanceRial = n(row?.balance_rial);
  const aiDebtRial = n(row?.ai_debt_rial);
  return {
    businessId,
    balanceRial,
    totalToppedUpRial: n(row?.total_topped_up_rial),
    totalSpentRial: n(row?.total_spent_rial),
    aiDebtRial,
    netBalanceRial: balanceRial - aiDebtRial,
  };
}

/** Fast balance-only read for the header badge. */
export async function getWalletBalanceRial(businessId: string): Promise<number> {
  const wallet = await getWallet(businessId);
  return wallet.balanceRial;
}

export async function listLedger(businessId: string, limit = 50, offset = 0): Promise<LedgerEntry[]> {
  const { rows } = await query<{
    id: string;
    kind: LedgerKind;
    direction: "credit" | "debit";
    amount_rial: string;
    balance_after_rial: string;
    feature_key: string | null;
    note: string | null;
    created_at: string;
  }>(
    `SELECT id, kind, direction, amount_rial, balance_after_rial, feature_key, note, created_at
       FROM wallet_ledger WHERE business_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [businessId, limit, offset],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    direction: r.direction,
    amountRial: n(r.amount_rial),
    balanceAfterRial: n(r.balance_after_rial),
    featureKey: r.feature_key,
    note: r.note,
    createdAt: r.created_at,
  }));
}

/**
 * How many ledger rows this business has in total.
 *
 * The console pages the ledger (issue #755 §17) instead of silently showing
 * the newest 50 and calling it the ledger, so it needs a denominator to say
 * "50 of 312" and to know when "load more" has nothing left to fetch.
 */
export async function countLedger(businessId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM wallet_ledger WHERE business_id = $1`,
    [businessId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function listCreditPackages(activeOnly = false): Promise<CreditPackage[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    price_rial: string;
    credit_rial: string;
    is_active: boolean;
    sort_order: number;
  }>(
    `SELECT id, name, price_rial, credit_rial, is_active, sort_order
       FROM credit_packages
      WHERE ($1::boolean = false OR is_active)
      ORDER BY sort_order, created_at, id`,
    [activeOnly],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    priceRial: n(r.price_rial),
    creditRial: n(r.credit_rial),
    isActive: r.is_active,
    sortOrder: r.sort_order,
  }));
}

// ---------------------------------------------------------------------------
// Credit packages catalogue (super-admin)
// ---------------------------------------------------------------------------

export async function saveCreditPackage(input: {
  id?: string;
  name: string;
  priceRial: number;
  creditRial: number;
  isActive: boolean;
  sortOrder: number;
}): Promise<CreditPackage> {
  const name = input.name.trim();
  if (!name) throw new Error("missing_fields");
  if (!positiveInt(input.priceRial) || !positiveInt(input.creditRial)) throw new Error("bad_amount");

  const { rows } = await query<{ id: string }>(
    `INSERT INTO credit_packages (id, name, price_rial, credit_rial, is_active, sort_order)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, price_rial = EXCLUDED.price_rial,
       credit_rial = EXCLUDED.credit_rial, is_active = EXCLUDED.is_active,
       sort_order = EXCLUDED.sort_order, updated_at = now()
     RETURNING id`,
    [input.id ?? null, name, input.priceRial, input.creditRial, input.isActive, input.sortOrder || 0],
  );
  const saved = await listCreditPackages();
  const pkg = saved.find((p) => p.id === rows[0].id);
  if (!pkg) throw new Error("save_failed");
  return pkg;
}

export async function deleteCreditPackage(id: string): Promise<void> {
  await query(`DELETE FROM credit_packages WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// Admin grants / adjustments
// ---------------------------------------------------------------------------

/** Super-admin: grant credits directly (manual grant / comp / refund). */
export async function grantCredits(input: {
  businessId: string;
  amountRial: number;
  note?: string;
  platformAdminId?: string | null;
}): Promise<{ balanceRial: number; grossBalanceRial: number; debtPaidRial: number; debtRial: number }> {
  if (!positiveInt(input.amountRial)) throw new Error("bad_amount");
  const client = await getPool().connect();
  try {
    return await withWalletTx(client, input.businessId, async (c) => {
      const { balanceAfterRial } = await writeLedger(c, {
        businessId: input.businessId,
        kind: "admin_grant",
        direction: "credit",
        amountRial: input.amountRial,
        note: input.note ?? "شارژ دستی توسط مدیر سامانه",
        platformAdminId: input.platformAdminId ?? null,
      });
      const reconciled = await reconcileAiDebtTx(c, input.businessId);
      return {
        balanceRial: reconciled.balanceRial,
        grossBalanceRial: balanceAfterRial,
        debtPaidRial: Math.max(0, balanceAfterRial - reconciled.balanceRial),
        debtRial: reconciled.debtRial,
      };
    });
  } finally {
    client.release();
  }
}

/** Super-admin: deduct credits (correction). Refuses if the balance cannot cover it. */
export async function deductCredits(input: {
  businessId: string;
  amountRial: number;
  note?: string;
  platformAdminId?: string | null;
}): Promise<{ balanceRial: number }> {
  if (!positiveInt(input.amountRial)) throw new Error("bad_amount");
  const client = await getPool().connect();
  try {
    return await withWalletTx(client, input.businessId, async (c) => {
      const { rows } = await c.query<{ balance_rial: string }>(
        `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
        [input.businessId],
      );
      if (n(rows[0]?.balance_rial) < input.amountRial) {
        throw new WalletInsufficientFundsError(input.amountRial, n(rows[0]?.balance_rial));
      }
      const { balanceAfterRial } = await writeLedger(c, {
        businessId: input.businessId,
        kind: "admin_adjust",
        direction: "debit",
        amountRial: input.amountRial,
        note: input.note ?? "کسر دستی توسط مدیر سامانه",
        platformAdminId: input.platformAdminId ?? null,
      });
      return { balanceRial: balanceAfterRial };
    });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Per-use feature charge — what every important function calls
// ---------------------------------------------------------------------------

/**
 * Charge a business's wallet for one metered use of `featureKey`.
 *
 * Returns the new balance. Throws `WalletInsufficientFundsError` when the
 * wallet cannot cover the charge — callers turn that into the "buy credits"
 * prompt. The charge is one row-locked transaction with its ledger entry, so
 * concurrent uses can never double-spend.
 *
 * `free` (zero-cost) calls are recorded in `feature_usage` counters but never
 * touch the ledger, matching the plan builder's "free / no cost" pricing.
 */
export async function chargeFeatureUse(input: {
  businessId: string;
  featureKey: string;
  priceRial: number;
  note?: string;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{ charged: boolean; balanceRial: number }> {
  const price = Math.max(0, Math.floor(n(input.priceRial)));
  const client = await getPool().connect();
  try {
    if (price <= 0) {
      // Free / unpriced use: no money moves and (for an unpriced function that
      // the metering layer does not know) no usage row either; a zero-price
      // *metered* feature still counts usage so the free-for-N-uses promo can
      // tick. Callers signal a metered feature via metadata.metered.
      const metered = input.metadata?.metered === true;
      if (metered) {
        await client.query(
          `INSERT INTO feature_usage (business_id, feature_key, used_count, charged_count, spent_rial)
           VALUES ($1, $2, 1, 0, 0)
           ON CONFLICT (business_id, feature_key) DO UPDATE SET
             used_count = feature_usage.used_count + 1, updated_at = now()`,
          [input.businessId, input.featureKey],
        );
      }
      const { rows } = await client.query<{ balance_rial: string }>(
        `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
        [input.businessId],
      );
      return { charged: false, balanceRial: n(rows[0]?.balance_rial) };
    }

    // The paid use is counted inside the wallet transaction (below), only
    // after the balance check succeeds — a refused charge must not tick the
    // charged/spent counters.

    return await withWalletTx(client, input.businessId, async (c) => {
      const { rows } = await c.query<{ balance_rial: string }>(
        `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
        [input.businessId],
      );
      const balance = n(rows[0]?.balance_rial);
      if (balance < price) {
        throw new WalletInsufficientFundsError(price, balance);
      }
      // Count the use on the same locked transaction so usage never moves
      // without the matching debit.
      await c.query(
        `INSERT INTO feature_usage (business_id, feature_key, used_count, charged_count, spent_rial)
         VALUES ($1, $2, 1, 1, $3)
         ON CONFLICT (business_id, feature_key) DO UPDATE SET
           used_count = feature_usage.used_count + 1,
           charged_count = feature_usage.charged_count + 1,
           spent_rial = feature_usage.spent_rial + $3,
           updated_at = now()`,
        [input.businessId, input.featureKey, price],
      );
      const { balanceAfterRial } = await writeLedger(c, {
        businessId: input.businessId,
        kind: "feature_charge",
        direction: "debit",
        amountRial: price,
        featureKey: input.featureKey,
        note: input.note ?? `هزینهٔ استفاده از قابلیت «${input.featureKey}»`,
        userId: input.userId ?? null,
        metadata: input.metadata,
      });
      return { charged: true, balanceRial: balanceAfterRial };
    });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Subscription fee (migration 0176) — the renewal debit, inside the caller's
// transaction so «invoice claim → wallet debit → period advance» is atomic.
// ---------------------------------------------------------------------------

/**
 * Debit one subscription fee from the wallet, INSIDE the caller's already-open
 * transaction (the renewal holds it: invoice claim, this debit and the period
 * advance must commit or roll back together). Ledger kind 'subscription'; the
 * invoice id rides in metadata. Throws WalletInsufficientFundsError without
 * moving anything when the balance cannot cover the fee.
 */
export async function chargeSubscriptionFeeTx(
  client: PoolClient,
  input: {
    businessId: string;
    amountRial: number;
    invoiceId?: string | null;
    note?: string | null;
  },
): Promise<{ balanceRial: number }> {
  const amount = Math.floor(n(input.amountRial));
  if (amount <= 0) {
    const { rows } = await client.query<{ balance_rial: string }>(
      `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
      [input.businessId],
    );
    return { balanceRial: n(rows[0]?.balance_rial) };
  }
  await client.query(
    `INSERT INTO business_wallets (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`,
    [input.businessId],
  );
  await client.query(`SELECT business_id FROM business_wallets WHERE business_id = $1 FOR UPDATE`, [
    input.businessId,
  ]);
  const { rows } = await client.query<{ balance_rial: string }>(
    `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
    [input.businessId],
  );
  const balance = n(rows[0]?.balance_rial);
  if (balance < amount) {
    throw new WalletInsufficientFundsError(amount, balance);
  }
  const { balanceAfterRial } = await writeLedger(client, {
    businessId: input.businessId,
    kind: "subscription",
    direction: "debit",
    amountRial: amount,
    note: input.note ?? "هزینهٔ اشتراک",
    metadata: { invoiceId: input.invoiceId ?? null, kind: "subscription_fee" },
  });
  return { balanceRial: balanceAfterRial };
}

/** Standalone subscription debit (opens its own transaction). */
export async function chargeSubscriptionFee(input: {
  businessId: string;
  amountRial: number;
  invoiceId?: string | null;
  note?: string | null;
}): Promise<{ balanceRial: number }> {
  const client = await getPool().connect();
  try {
    return await withWalletTx(client, input.businessId, (c) =>
      chargeSubscriptionFeeTx(c, input),
    );
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// AI wallet billing (Phase B — post-request settlement against the ONE wallet)
//
// The AI subsystem used to bill a second balance (`ai_business_billing`) with a
// reserve→settle→cancel dance. It now spends from THIS wallet like every other
// metered feature, under `feature_key = 'ai'`, but with two differences that
// the generic `chargeFeatureUse` cannot express:
//
//   1. Post-request settlement. The real cost is only known AFTER the provider
//      has already answered (and already incurred cost upstream). So a partial
//      debit is legitimate: if the wallet can no longer cover the full settled
//      cost, we debit what is there and record the remainder as AI debt rather
//      than either refusing (the cost is already sunk) or driving the balance
//      negative (the wallet's invariant must hold). The next turn is then
//      blocked by the affordability gate until a top-up clears the debt.
//   2. Idempotency by request id. A retried settlement for the same turn is a
//      no-op — `ai_wallet_settlements` has a unique (business_id, request_id).
// ---------------------------------------------------------------------------

/** Feature key the canonical AI wallet debit is booked under. */
export const AI_FEATURE_KEY = "ai";

export interface AiAffordability {
  affordable: boolean;
  balanceRial: number;
  debtRial: number;
  requiredRial: number;
  /**
   * Plan-included monthly AI credit still unused this month (migration 0168).
   * The gate admits a turn when balance + this allowance covers the ceiling —
   * a plan's «اعتبار ماهانهٔ هوش مصنوعی» is real spendable credit, not a hint.
   */
  allowanceRemainingRial: number;
}

export interface AiSettlementInput {
  businessId: string;
  /** The application's per-turn identity, generated before the request. */
  requestId: string;
  /** Real cost to charge the wallet (provider cost + platform margin), integer Rial. */
  chargedRial: number;
  requestType?: string;
  litellmCallId?: string | null;
  model?: string | null;
  costUsd?: number | null;
  providerCostRial?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheHit?: boolean;
  pricedBy?: "gateway" | "token_rate" | "free";
  conversationId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  automationId?: string | null;
  coworkerId?: string | null;
  locationId?: string | null;
  userId?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
  // Issue #812 §12 — per-turn attribution. Columns, not metadata keys, because
  // the usage report groups on them and a typo in a jsonb key is a silent NULL
  // group forever.
  /** The runtime mode in force: `auto`, `instant` or `deep_research`. */
  runtimeMode?: string | null;
  /** The Superadmin system agent invoked, if the turn ran as one. */
  systemAgentId?: string | null;
  /** The assignment (suggestion card) that surfaced the agent. */
  suggestionId?: string | null;
  /** The Deep Research run this settlement belongs to. */
  researchRunId?: string | null;
  /** The prompt layers the resolver composed, in composition order. */
  promptLayers?: unknown;
  /** The app this turn was focused on, or null when it was not app-focused. */
  appFocus?: string | null;
  /** The prompt versions that were live, as `{ scope, version }` in order. */
  promptVersions?: unknown;
}

export interface AiSettlementResult {
  /** The full settled cost of the turn (what it *should* cost). */
  chargedRial: number;
  /** The part covered by the plan's monthly AI allowance, not the wallet. */
  allowanceAppliedRial: number;
  /** What was actually debited from the wallet this call. */
  debitedRial: number;
  /** New debt added because the wallet could not cover the full cost. */
  debtAddedRial: number;
  /** Total outstanding AI debt after this settlement. */
  debtRial: number;
  balanceRial: number;
  settlementId: string;
  walletLedgerId: string | null;
  /** True when this exact request was already settled (idempotent no-op). */
  duplicate: boolean;
}

async function readAiDebt(client: PoolClient, businessId: string): Promise<number> {
  const { rows } = await client.query<{ debt_rial: string }>(
    `SELECT debt_rial FROM ai_wallet_debt WHERE business_id = $1`,
    [businessId],
  );
  return n(rows[0]?.debt_rial);
}

/**
 * Pay down any outstanding AI debt from whatever balance exists, inside the
 * given locked wallet transaction. Returns the balance and debt afterwards.
 * The paydown is a normal `feature_charge` debit so it shows on the ledger.
 */
async function reconcileAiDebtTx(
  client: PoolClient,
  businessId: string,
): Promise<{ balanceRial: number; debtRial: number }> {
  const debt = await readAiDebt(client, businessId);
  const { rows } = await client.query<{ balance_rial: string }>(
    `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
    [businessId],
  );
  const balance = n(rows[0]?.balance_rial);
  if (debt <= 0 || balance <= 0) return { balanceRial: balance, debtRial: debt };

  const pay = Math.min(balance, debt);
  const { balanceAfterRial } = await writeLedger(client, {
    businessId,
    kind: "feature_charge",
    direction: "debit",
    amountRial: pay,
    featureKey: AI_FEATURE_KEY,
    note: "تسویهٔ بدهی هوش مصنوعی",
    metadata: { aiDebtPaydown: true },
  });
  await client.query(
    `INSERT INTO feature_usage (business_id, feature_key, used_count, charged_count, spent_rial)
     VALUES ($1, $2, 0, 1, $3)
     ON CONFLICT (business_id, feature_key) DO UPDATE SET
       charged_count = CASE WHEN feature_usage.charged_count = 0 THEN 1 ELSE feature_usage.charged_count END,
       spent_rial = feature_usage.spent_rial + $3,
       updated_at = now()`,
    [businessId, AI_FEATURE_KEY, pay],
  );
  const remaining = debt - pay;
  await client.query(
    `INSERT INTO ai_wallet_debt (business_id, debt_rial, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (business_id) DO UPDATE SET debt_rial = $2, updated_at = now()`,
    [businessId, remaining],
  );
  return { balanceRial: balanceAfterRial, debtRial: remaining };
}

/**
 * The pre-request affordability gate. Opportunistically clears AI debt from
 * any available balance first, then reports whether the business can start a
 * new AI turn: it must have no remaining debt AND at least `requiredRial`
 * (the configured per-turn ceiling, used here as a minimum-balance guard so a
 * turn is never started that the wallet plainly cannot cover). This is the
 * "block the next request when the business cannot afford AI" policy, without
 * reintroducing an up-front reservation.
 */
export async function checkAiAffordability(
  businessId: string,
  requiredRial: number,
): Promise<AiAffordability> {
  const required = Math.max(0, Math.floor(n(requiredRial)));
  const client = await getPool().connect();
  try {
    const { balanceRial, debtRial } = await withWalletTx(client, businessId, (c) =>
      reconcileAiDebtTx(c, businessId),
    );
    // The plan's monthly AI allowance counts toward affordability: a business
    // whose plan includes credit may start a turn with an empty wallet, as
    // long as the unused allowance covers the per-turn ceiling.
    const allowance = await getPlanAllowance(businessId);
    return {
      affordable: debtRial <= 0 && balanceRial + allowance.remainingRial >= required,
      balanceRial,
      debtRial,
      requiredRial: required,
      allowanceRemainingRial: allowance.remainingRial,
    };
  } finally {
    client.release();
  }
}

/**
 * Settle one AI turn against the wallet after the provider has answered.
 * Idempotent by (businessId, requestId). Debits the wallet by the settled
 * cost, or by as much as the balance allows — booking any shortfall as AI
 * debt so it is never hidden and blocks the next turn.
 */
export async function settleAiWalletCharge(input: AiSettlementInput): Promise<AiSettlementResult> {
  const cost = Math.max(0, Math.floor(n(input.chargedRial)));
  const client = await getPool().connect();
  try {
    return await withWalletTx(client, input.businessId, async (c) => {
      // Idempotency: a settlement already recorded for this request wins.
      const existing = await c.query<{
        id: string;
        charged_rial: string;
        debt_rial: string;
        wallet_ledger_id: string | null;
      }>(
        `SELECT id, charged_rial, debt_rial, wallet_ledger_id
           FROM ai_wallet_settlements
          WHERE business_id = $1 AND request_id = $2`,
        [input.businessId, input.requestId],
      );
      if (existing.rows[0]) {
        const debtRial = await readAiDebt(c, input.businessId);
        const { rows } = await c.query<{ balance_rial: string }>(
          `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
          [input.businessId],
        );
        return {
          chargedRial: n(existing.rows[0].charged_rial),
          allowanceAppliedRial: 0,
          debitedRial: 0,
          debtAddedRial: 0,
          debtRial,
          balanceRial: n(rows[0]?.balance_rial),
          settlementId: existing.rows[0].id,
          walletLedgerId: existing.rows[0].wallet_ledger_id,
          duplicate: true,
        };
      }

      // Plan allowance first (migration 0168): the plan's monthly AI credit is
      // consumed before a single Rial leaves the wallet, inside this same
      // locked transaction. A business whose plan covers the whole turn is not
      // debited at all — the allowance row is the record.
      const allowanceAppliedRial = await consumePlanAllowanceTx(c, input.businessId, cost);
      const walletCost = cost - allowanceAppliedRial;

      const { rows: balRows } = await c.query<{ balance_rial: string }>(
        `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
        [input.businessId],
      );
      const balance = n(balRows[0]?.balance_rial);
      const debitedRial = Math.min(walletCost, balance);
      const debtAddedRial = walletCost - debitedRial;

      let walletLedgerId: string | null = null;
      let balanceAfter = balance;
      if (debitedRial > 0) {
        const led = await writeLedger(c, {
          businessId: input.businessId,
          kind: "feature_charge",
          direction: "debit",
          amountRial: debitedRial,
          featureKey: AI_FEATURE_KEY,
          note: input.note ?? "هزینهٔ استفاده از هوش مصنوعی",
          userId: input.userId ?? null,
          metadata: {
            ...input.metadata,
            requestType: input.requestType ?? "chat",
            pricedBy: input.pricedBy ?? "token_rate",
            ...(input.litellmCallId ? { litellmCallId: input.litellmCallId } : {}),
            ...(allowanceAppliedRial > 0 ? { allowanceAppliedRial } : {}),
            ...(debtAddedRial > 0 ? { partial: true, debtAddedRial } : {}),
          },
        });
        walletLedgerId = led.id;
        balanceAfter = led.balanceAfterRial;
        // Tick the feature-usage counters like chargeFeatureUse does, so the
        // AI feature participates in the same usage reporting as every other.
        await c.query(
          `INSERT INTO feature_usage (business_id, feature_key, used_count, charged_count, spent_rial)
           VALUES ($1, $2, 1, 1, $3)
           ON CONFLICT (business_id, feature_key) DO UPDATE SET
             used_count = feature_usage.used_count + 1,
             charged_count = feature_usage.charged_count + 1,
             spent_rial = feature_usage.spent_rial + $3,
             updated_at = now()`,
          [input.businessId, AI_FEATURE_KEY, debitedRial],
        );
      } else {
        // Metered-but-free (zero cost or nothing to debit): still count use.
        await c.query(
          `INSERT INTO feature_usage (business_id, feature_key, used_count, charged_count, spent_rial)
           VALUES ($1, $2, 1, 0, 0)
           ON CONFLICT (business_id, feature_key) DO UPDATE SET
             used_count = feature_usage.used_count + 1, updated_at = now()`,
          [input.businessId, AI_FEATURE_KEY],
        );
      }

      let debtRial = await readAiDebt(c, input.businessId);
      if (debtAddedRial > 0) {
        debtRial += debtAddedRial;
        await c.query(
          `INSERT INTO ai_wallet_debt (business_id, debt_rial, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (business_id) DO UPDATE SET
             debt_rial = ai_wallet_debt.debt_rial + $2, updated_at = now()`,
          [input.businessId, debtAddedRial],
        );
      }

      const { rows: settleRows } = await c.query<{ id: string }>(
        `INSERT INTO ai_wallet_settlements
           (business_id, request_id, litellm_call_id, request_type, model,
            conversation_id, project_id, agent_id, automation_id, coworker_id,
            location_id, input_tokens, output_tokens, cache_hit,
            cost_usd, provider_cost_rial, charged_rial, debt_rial, priced_by,
            wallet_ledger_id, created_by_user_id, metadata,
            runtime_mode, system_agent_id, suggestion_id, research_run_id, prompt_layers,
            app_focus, prompt_versions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,
                 $23,$24,$25,$26,$27::jsonb,$28,$29::jsonb)
         RETURNING id`,
        [
          input.businessId,
          input.requestId,
          input.litellmCallId ?? null,
          input.requestType ?? "chat",
          input.model ?? null,
          input.conversationId ?? null,
          input.projectId ?? null,
          input.agentId ?? null,
          input.automationId ?? null,
          input.coworkerId ?? null,
          input.locationId ?? null,
          input.inputTokens == null ? null : Math.max(0, Math.floor(input.inputTokens)),
          input.outputTokens == null ? null : Math.max(0, Math.floor(input.outputTokens)),
          input.cacheHit ?? false,
          input.costUsd == null ? null : Math.max(0, input.costUsd),
          Math.max(0, Math.floor(n(input.providerCostRial))),
          cost,
          debtAddedRial,
          input.pricedBy ?? "token_rate",
          walletLedgerId,
          input.userId ?? null,
          JSON.stringify({
            ...(input.metadata ?? {}),
            ...(allowanceAppliedRial > 0 ? { allowanceAppliedRial } : {}),
          }),
          // §12 — the attribution columns. `runtimeMode` stays NULL when the
          // surface has no mode: an OCR call or a vision count never touched a
          // mode alias, and writing `auto` on it would invent one. The chat path
          // always writes a mode explicitly.
          input.runtimeMode ?? null,
          input.systemAgentId ?? null,
          input.suggestionId ?? null,
          input.researchRunId ?? null,
          JSON.stringify(Array.isArray(input.promptLayers) ? input.promptLayers : []),
          input.appFocus ?? null,
          JSON.stringify(Array.isArray(input.promptVersions) ? input.promptVersions : []),
        ],
      );

      return {
        chargedRial: cost,
        allowanceAppliedRial,
        debitedRial,
        debtAddedRial,
        debtRial,
        balanceRial: balanceAfter,
        settlementId: settleRows[0].id,
        walletLedgerId,
        duplicate: false,
      };
    });
  } finally {
    client.release();
  }
}

/** Current outstanding AI debt for a business (0 when none). */
export async function getAiDebtRial(businessId: string): Promise<number> {
  const { rows } = await query<{ debt_rial: string }>(
    `SELECT debt_rial FROM ai_wallet_debt WHERE business_id = $1`,
    [businessId],
  );
  return n(rows[0]?.debt_rial);
}

// ---------------------------------------------------------------------------
// Payments: create / start / verify / review
// ---------------------------------------------------------------------------

export async function getPaymentConfig(): Promise<PaymentGatewayConfig> {
  await query(
    `INSERT INTO platform_payment_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING`,
  );
  const { rows } = await query<{
    gateway: "manual" | "zarinpal";
    merchant_id: string;
    sandbox: boolean;
    callback_url: string;
    currency: "IRR" | "IRT";
  }>(
    `SELECT gateway, merchant_id, sandbox, callback_url, currency
       FROM platform_payment_config WHERE id = true`,
  );
  const row = rows[0];
  return {
    gateway: row?.gateway ?? "manual",
    merchantId: row?.merchant_id ?? "",
    sandbox: row?.sandbox ?? true,
    callbackUrl: row?.callback_url ?? "",
    currency: row?.currency ?? "IRR",
  };
}

export async function savePaymentConfig(
  input: Partial<PaymentGatewayConfig> & { platformAdminId?: string | null },
): Promise<PaymentGatewayConfig> {
  const current = await getPaymentConfig();
  const next: PaymentGatewayConfig = {
    gateway: input.gateway ?? current.gateway,
    merchantId: input.merchantId ?? current.merchantId,
    sandbox: input.sandbox ?? current.sandbox,
    callbackUrl: input.callbackUrl ?? current.callbackUrl,
    currency: input.currency ?? current.currency,
  };
  if (!["manual", "zarinpal"].includes(next.gateway)) throw new Error("bad_gateway");
  await query(
    `UPDATE platform_payment_config
        SET gateway = $1, merchant_id = $2, sandbox = $3, callback_url = $4,
            currency = $5, updated_by = $6, updated_at = now()
      WHERE id = true`,
    [next.gateway, next.merchantId.trim(), next.sandbox, next.callbackUrl.trim(), next.currency, input.platformAdminId ?? null],
  );
  return next;
}

/**
 * Create a payment row (status pending). For top-ups pass packageId/amount;
 * for plan/addon purchases pass planKey/featureKey. Returns the new id so the
 * caller can then call the gateway and redirect.
 */
export async function createPayment(input: {
  businessId: string;
  gateway?: "manual" | "zarinpal";
  purpose: "top_up" | "plan_purchase" | "addon_purchase";
  amountRial: number;
  creditRial?: number;
  packageId?: string | null;
  planKey?: string | null;
  featureKey?: string | null;
  description: string;
  userId?: string | null;
}): Promise<PaymentRecord> {
  if (!positiveInt(input.amountRial)) throw new Error("bad_amount");
  if (input.purpose === "top_up" && !input.packageId) {
    const { rows: settingsRows } = await query<{ minimum_top_up_rial: string }>(
      `SELECT minimum_top_up_rial FROM billing_commercial_settings WHERE id = true`,
    );
    const minTopUp = n(settingsRows[0]?.minimum_top_up_rial);
    if (minTopUp > 0 && input.amountRial < minTopUp) {
      throw new Error("below_minimum_top_up");
    }
  }
  const config = await getPaymentConfig();
  const effectiveGateway = input.gateway ?? config.gateway;
  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO billing_payments
       (business_id, gateway, sandbox, purpose, package_id, plan_key, feature_key,
        amount_rial, credit_rial, description, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      input.businessId,
      effectiveGateway,
      Boolean(config.sandbox),
      input.purpose,
      input.packageId ?? null,
      input.planKey ?? null,
      input.featureKey ?? null,
      input.amountRial,
      Math.max(0, n(input.creditRial)),
      input.description,
      input.userId ?? null,
    ],
  );
  return rowToPayment(rows[0]);
}

/**
 * Start a pending payment: ask Zarinpal for an authority and persist it.
 * Returns the URL to redirect the browser to. For the `manual` gateway there
 * is no redirect — the payment simply waits for admin approval.
 */
export async function startPayment(
  paymentId: string,
  opts: { email?: string | null; mobile?: string | null } = {},
): Promise<{ redirectUrl: string | null; gateway: string }> {
  const config = await getPaymentConfig();
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM billing_payments WHERE id = $1 FOR UPDATE`,
    [paymentId],
  );
  const payment = rows[0] ? rowToPayment(rows[0]) : null;
  if (!payment) throw new GatewayError("payment_not_found");
  if (payment.status !== "pending") throw new GatewayError("payment_not_pending");

  if (config.gateway === "manual") {
    return { redirectUrl: null, gateway: "manual" };
  }

  const { authority, redirectUrl } = await zarinpalRequest(config, {
    amountRial: payment.amountRial,
    description: payment.description,
    paymentId: payment.id,
    email: opts.email ?? null,
    mobile: opts.mobile ?? null,
  });
  await query(
    `UPDATE billing_payments
        SET status = 'redirect', authority = $2, gateway = 'zarinpal', sandbox = $3
      WHERE id = $1 AND status = 'pending'`,
    [paymentId, authority, Boolean(config.sandbox)],
  );
  return { redirectUrl, gateway: "zarinpal" };
}

/**
 * Verify a payment the gateway redirected back. Idempotent: a second verify
 * of an already-verified payment returns its record without double-crediting
 * (the unique payment_id ledger index is the hard guarantee).
 */
export async function verifyPayment(input: {
  paymentId: string;
  businessId?: string;
  authority: string;
  status?: string; // Zarinpal returns 'OK' / 'NOK' in query params
  statusParam?: string;
}): Promise<PaymentRecord> {
  const config = await getPaymentConfig();
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM billing_payments WHERE id = $1`,
    [input.paymentId],
  );
  const payment = rows[0] ? rowToPayment(rows[0]) : null;
  if (!payment) throw new GatewayError("payment_not_found");
  if (input.businessId && payment.businessId !== input.businessId) {
    throw new GatewayError("forbidden_business");
  }
  if (payment.gateway !== "zarinpal") {
    throw new GatewayError("invalid_payment_gateway");
  }
  if (payment.status !== "redirect" && payment.status !== "verified" && !payment.authority) {
    throw new GatewayError("payment_not_pending");
  }
  const submittedAuthority = String(input.authority ?? "").trim();
  if (!payment.authority || !submittedAuthority || payment.authority !== submittedAuthority) {
    throw new GatewayError("authority_mismatch");
  }
  if (payment.status === "verified") {
    return payment;
  }
  if (payment.status !== "redirect") {
    throw new GatewayError("payment_not_pending");
  }

  const rawStatus = input.status ?? input.statusParam ?? "";
  const ok = rawStatus.toUpperCase() === "OK";
  if (!ok) {
    await query(
      `UPDATE billing_payments
          SET status = 'cancelled', gateway_status = $2
        WHERE id = $1 AND status = 'redirect' AND authority = $3`,
      [payment.id, rawStatus || "NOK", payment.authority],
    );
    return (await getPaymentById(payment.id))!;
  }

  const result = await zarinpalVerify(config, {
    amountRial: payment.amountRial,
    authority: payment.authority,
  });
  if (!result.verified) {
    await query(
      `UPDATE billing_payments
          SET status = 'failed', gateway_status = COALESCE($2, 'unverified')
        WHERE id = $1 AND status = 'redirect' AND authority = $3`,
      [payment.id, result.code ? String(result.code) : "NOK", payment.authority],
    );
    return (await getPaymentById(payment.id))!;
  }

  await settlePayment(payment.id, {
    gatewayRef: result.refId ?? null,
    gatewayStatus: result.code ? String(result.code) : "100",
    authority: payment.authority,
  });
  return (await getPaymentById(payment.id))!;
}

/**
 * Mark a payment settled and post its wallet credit inside one transaction.
 * Shared by Zarinpal verify and manual admin approval.
 */
export async function settlePayment(
  paymentId: string,
  opts: {
    gatewayRef?: string | null;
    gatewayStatus?: string;
    platformAdminId?: string | null;
    authority?: string | null;
  } = {},
): Promise<PaymentRecord> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT * FROM billing_payments WHERE id = $1 FOR UPDATE`,
      [paymentId],
    );
    const payment = rows[0] ? rowToPayment(rows[0]) : null;
    if (!payment) {
      await client.query("ROLLBACK");
      throw new GatewayError("payment_not_found");
    }
    if (opts.authority !== undefined && opts.authority !== null && payment.authority !== opts.authority) {
      await client.query("ROLLBACK");
      throw new GatewayError("authority_mismatch");
    }
    const cleanGatewayRef = opts.gatewayRef?.trim() ? opts.gatewayRef.trim() : null;
    if (payment.status === "verified") {
      if (cleanGatewayRef && payment.gatewayRef && cleanGatewayRef !== payment.gatewayRef) {
        await client.query("ROLLBACK");
        throw new GatewayError("gateway_ref_mismatch");
      }
      await client.query("COMMIT");
      return payment;
    }
    if (payment.status !== "redirect" && payment.status !== "pending") {
      await client.query("ROLLBACK");
      throw new GatewayError("payment_not_pending");
    }

    if (cleanGatewayRef) {
      const { rows: refCollision } = await client.query<{ id: string }>(
        `SELECT id FROM billing_payments
          WHERE gateway = $1 AND sandbox = $2 AND gateway_ref = $3 AND id <> $4
          LIMIT 1`,
        [payment.gateway, Boolean(payment.sandbox), cleanGatewayRef, payment.id],
      );
      if (refCollision[0]) {
        await client.query("ROLLBACK");
        throw new GatewayError("duplicate_gateway_ref");
      }
    }

    // Wallet credit — the unique payment_id index on wallet_ledger makes the
    // credit exactly-once even if settle is raced.
    await client.query(
      `INSERT INTO business_wallets (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`,
      [payment.businessId],
    );
    await client.query(
      `SELECT business_id FROM business_wallets WHERE business_id = $1 FOR UPDATE`,
      [payment.businessId],
    );
    if (payment.creditRial > 0) {
      await client.query(
        `UPDATE business_wallets
            SET balance_rial = balance_rial + $2,
                total_topped_up_rial = total_topped_up_rial + $2,
                updated_at = now()
          WHERE business_id = $1`,
        [payment.businessId, payment.creditRial],
      );
      await client.query(
        `INSERT INTO wallet_ledger
           (business_id, kind, direction, amount_rial, balance_after_rial,
            payment_id, note, metadata, platform_admin_id)
         SELECT $1, 'top_up', 'credit', $2, balance_rial, $3, $4, '{}'::jsonb, $5
           FROM business_wallets WHERE business_id = $1`,
        [
          payment.businessId,
          payment.creditRial,
          payment.id,
          `شارژ اعتبار از طریق ${payment.gateway === "zarinpal" ? "درگاه زرین‌پال" : "پرداخت دستی"}`,
          opts.platformAdminId ?? null,
        ],
      );
      await reconcileAiDebtTx(client, payment.businessId);
    }

    const isTopUp = payment.purpose === "top_up";
    await client.query(
      `UPDATE billing_payments
          SET status = 'verified',
              gateway_ref = COALESCE($2, gateway_ref),
              gateway_status = COALESCE($3, 'verified'),
              verified_at = now(),
              reviewed_at = COALESCE(reviewed_at, now()),
              reviewed_by = COALESCE(reviewed_by, $4),
              fulfilment_status = CASE WHEN $5 THEN 'succeeded' ELSE fulfilment_status END,
              fulfilled_at = CASE WHEN $5 THEN COALESCE(fulfilled_at, now()) ELSE fulfilled_at END
        WHERE id = $1 AND status IN ('pending', 'redirect')`,
      [payment.id, cleanGatewayRef, opts.gatewayStatus ?? null, opts.platformAdminId ?? null, isTopUp],
    );
    await client.query("COMMIT");
    return (await getPaymentById(payment.id))!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "23505" &&
      "constraint" in err &&
      String((err as { constraint?: string }).constraint).includes("gateway_ref")
    ) {
      throw new GatewayError("duplicate_gateway_ref");
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Super-admin: reject a pending manual payment.
 * Locks the row and refuses to overwrite an already-verified payment.
 * Returns the actual persisted PaymentRecord.
 */
export async function rejectPayment(
  paymentId: string,
  opts: { platformAdminId?: string | null; note?: string } = {},
): Promise<PaymentRecord> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT * FROM billing_payments WHERE id = $1 FOR UPDATE`,
      [paymentId],
    );
    const payment = rows[0] ? rowToPayment(rows[0]) : null;
    if (!payment) {
      await client.query("ROLLBACK");
      throw new GatewayError("payment_not_found");
    }
    if (payment.status === "verified") {
      await client.query("COMMIT");
      return payment;
    }
    if (payment.status === "pending" || payment.status === "redirect") {
      await client.query(
        `UPDATE billing_payments
            SET status = 'failed',
                reviewed_by = $2,
                reviewed_at = now(),
                gateway_status = COALESCE(gateway_status, 'rejected')
          WHERE id = $1 AND status IN ('pending', 'redirect')`,
        [paymentId, opts.platformAdminId ?? null],
      );
    }
    await client.query("COMMIT");
    return (await getPaymentById(paymentId))!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getPaymentById(id: string): Promise<PaymentRecord | null> {
  const { rows } = await query<Record<string, unknown>>(`SELECT * FROM billing_payments WHERE id = $1`, [id]);
  return rows[0] ? rowToPayment(rows[0]) : null;
}

export async function listPayments(
  options: {
    businessId?: string;
    status?: PaymentStatus;
    limit?: number;
    /** Rows to skip — the console pages payments rather than capping at 50. */
    offset?: number;
  } = {},
): Promise<PaymentRecord[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  const offset = Math.max(options.offset ?? 0, 0);
  if (options.businessId) {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM billing_payments WHERE business_id = $1
        AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [options.businessId, options.status ?? null, limit, offset],
    );
    return rows.map(rowToPayment);
  }
  // Platform-wide: join business names. RLS is bypassed in platform scope.
  const { rows } = await query<Record<string, unknown>>(
    `SELECT p.*, b.name AS business_name
       FROM billing_payments p JOIN businesses b ON b.id = p.business_id
      WHERE ($2::text IS NULL OR p.status = $2)
      ORDER BY p.created_at DESC, p.id DESC LIMIT $1 OFFSET $3`,
    [limit, options.status ?? null, offset],
  );
  return rows.map(rowToPayment);
}

/** Total payments matching the same filter `listPayments` pages through. */
export async function countPayments(
  options: { businessId?: string; status?: PaymentStatus } = {},
): Promise<number> {
  if (options.businessId) {
    const { rows } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM billing_payments
        WHERE business_id = $1 AND ($2::text IS NULL OR status = $2)`,
      [options.businessId, options.status ?? null],
    );
    return Number(rows[0]?.count ?? 0);
  }
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM billing_payments WHERE ($1::text IS NULL OR status = $1)`,
    [options.status ?? null],
  );
  return Number(rows[0]?.count ?? 0);
}

function rowToPayment(row: Record<string, unknown>): PaymentRecord {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    gateway: (row.gateway as "manual" | "zarinpal") ?? "zarinpal",
    sandbox: Boolean(row.sandbox ?? false),
    purpose: (row.purpose as PaymentRecord["purpose"]) ?? "top_up",
    packageId: (row.package_id as string | null) ?? null,
    planKey: (row.plan_key as string | null) ?? null,
    featureKey: (row.feature_key as string | null) ?? null,
    amountRial: n(row.amount_rial as string | number),
    creditRial: n(row.credit_rial as string | number),
    description: String(row.description ?? ""),
    status: (row.status as PaymentStatus) ?? "pending",
    authority: (row.authority as string | null) ?? null,
    gatewayRef: (row.gateway_ref as string | null) ?? null,
    fulfilmentStatus: ((row.fulfilment_status as PaymentFulfilmentStatus | null) ?? "pending"),
    fulfilledAt: row.fulfilled_at ? String(row.fulfilled_at) : null,
    fulfilmentError: (row.fulfilment_error as string | null) ?? null,
    createdAt: String(row.created_at),
    verifiedAt: (row.verified_at as string | null) ?? null,
    businessName: (row.business_name as string | null) ?? null,
  };
}

/** Re-exported for routes that build a sandbox URL in tests/diagnostics. */
export { zarinpalPaymentUrl };
