-- ============================================================================
-- 0306_billing_quote_checkout.sql — ESH-193 / #1378, stages 4–5.
--
-- Wires the persisted quote (0304) into checkout, wallet settlement and the
-- prepaid subscription lifecycle. Additive only:
--
--   1. `billing_quotes.stacking_policy` — the policy a quote was priced under.
--      Re-pricing at settlement must reproduce the same arithmetic, and a
--      quote priced under `best_single` must not become a stacked quote if the
--      configuration later changes.
--   2. `billing_payments.quote_id` — the quote a purchase settles. A quote can
--      back at most one payment, so a replayed checkout cannot consume it
--      twice by creating a second payment row.
--   3. `term_months` on the payment and the subscription — the prepaid term
--      chosen at checkout. Defaults to 1, which is exactly the legacy monthly
--      behaviour: existing subscriptions and payments are unchanged.
--   4. Duration discounts as configuration, disabled by default, plus the one
--      explicit switch that lets a coupon stack with them. A hardcoded
--      promotion is a promise nobody can turn off; a default-on stack is a
--      discount nobody priced.
--   5. `wallet` as a payment gateway for plan purchases paid from the balance.
--      Wallet settlement still debits `business_wallets` through
--      `wallet_ledger`; this only labels the payment row it produces.
--
-- Rollback: additive. Dropping the columns and restoring the two-option
-- gateway CHECK returns the schema to 0304/0305; no row is rewritten.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Quote policy + payment/term links
-- ---------------------------------------------------------------------------
ALTER TABLE billing_quotes
    ADD COLUMN IF NOT EXISTS stacking_policy text NOT NULL DEFAULT 'best_single'
        CHECK (stacking_policy IN ('best_single', 'stack'));

ALTER TABLE billing_payments
    ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES billing_quotes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS term_months integer NOT NULL DEFAULT 1
        CHECK (term_months IN (1, 3, 12));

-- One payment per quote. The quote is the idempotency key of a checkout, so a
-- repeated request with the same quote returns the same payment instead of
-- opening a second, independently consumable one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payments_quote
    ON billing_payments (quote_id)
 WHERE quote_id IS NOT NULL;

-- Wallet-paid plan purchases: the balance is debited through the existing
-- wallet ledger, and this label keeps them distinguishable from a manual
-- bank-transfer payment in the payment list.
ALTER TABLE billing_payments DROP CONSTRAINT IF EXISTS billing_payments_gateway_check;
ALTER TABLE billing_payments
    ADD CONSTRAINT billing_payments_gateway_check
        CHECK (gateway IN ('manual', 'zarinpal', 'wallet'));

-- ---------------------------------------------------------------------------
-- 2. Prepaid term on the subscription
-- ---------------------------------------------------------------------------
ALTER TABLE business_subscriptions
    ADD COLUMN IF NOT EXISTS term_months integer NOT NULL DEFAULT 1
        CHECK (term_months IN (1, 3, 12));

COMMENT ON COLUMN business_subscriptions.term_months IS
    'Paid prepayment term (ESH-193). Default 1 keeps legacy monthly subscriptions byte-for-byte unchanged; renewal repeats this term.';

-- ---------------------------------------------------------------------------
-- 3. Promotion configuration
--
--    Every discount starts at 0 and stacking starts OFF. Turning on a 3- or
--    12-month rate is a super-admin decision recorded in this row; turning on
--    stacking is a separate, explicit decision.
-- ---------------------------------------------------------------------------
ALTER TABLE billing_commercial_settings
    ADD COLUMN IF NOT EXISTS term_discount_bps_1 integer NOT NULL DEFAULT 0
        CHECK (term_discount_bps_1 BETWEEN 0 AND 10000),
    ADD COLUMN IF NOT EXISTS term_discount_bps_3 integer NOT NULL DEFAULT 0
        CHECK (term_discount_bps_3 BETWEEN 0 AND 10000),
    ADD COLUMN IF NOT EXISTS term_discount_bps_12 integer NOT NULL DEFAULT 0
        CHECK (term_discount_bps_12 BETWEEN 0 AND 10000),
    ADD COLUMN IF NOT EXISTS coupon_stacking_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN billing_commercial_settings.term_discount_bps_1 IS
    'Duration discount per sold term, in basis points (ESH-193). Zero by default: no promotion is shipped in code.';
COMMENT ON COLUMN billing_commercial_settings.coupon_stacking_enabled IS
    'When false (default) a coupon and the duration discount never combine; the larger single discount applies. Only an explicit true allows both.';
