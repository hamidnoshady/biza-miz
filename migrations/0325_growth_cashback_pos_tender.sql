-- ============================================================================
-- 0325_growth_cashback_pos_tender.sql — issue #901, Wave 2 (P0 financial engine).
--
-- Until now a campaign reward could only leave the business as a cash/bank
-- payout (`growth_reward_redemptions`, 0324). This migration makes the reward a
-- **POS tender**: the customer spends it on part of a bill at the till, and the
-- sale's own payment entry debits the 2445 liability instead of collecting that
-- much money.
--
-- Three pieces:
--
--   * `cashback` on the `payment_method` enum, so the `payments` row that
--     records the tender is a first-class row like cash or card. It is *not* a
--     `payment_methods` row: a reward balance is a system capability tied to a
--     customer, not a way the business configures, renames or reorders.
--   * `growth_reward_redemptions` grows a `channel` (`wallet` payout vs
--     `pos_tender`), the `order_id` it was spent on, and `refunded_rial` — how
--     much of it a customer return has already given back. The unique
--     `request_key` stays the idempotency guarantee: a replayed checkout sends
--     `pos-tender:<order id>` and pays/spends once.
--   * `growth_reward_events` accepts `restored`: the value a refund gives back
--     to the customer's wallet. It is a new event type rather than a negative
--     `redeemed` amount, because the ledger's amounts are positive and every
--     balance is a SUM over these rows — a reversal has to be its own row.
--
-- Accounting for the tender and its refund (campaign-posting-rules.ts):
--
--   sale paid partly with a reward
--       Dr 2445 بازگشت وجه تبلیغاتی   (the reward portion)
--       Dr 1100/1110                  (the money portion)
--       Cr revenue + VAT              (the whole bill, as always)
--     No `growth.cashback_redeemed` entry is posted for this leg: the sale's
--     own entry already carries the 2445 debit, and posting a payout as well
--     would debit the liability twice.
--
--   customer return of that sale
--       Dr 4400 برگشت از فروش (net)  +  Dr VAT (its share)
--       Cr 2445 بازگشت وجه تبلیغاتی   (gross)
--     The customer gets the reward back on their wallet, not as cash, so the
--     return's cash refund capacity excludes the reward portion
--     (`customer-return-service.ts` sums only real tenders).
--
-- Additive: no existing table, row or posting is rewritten.
-- ============================================================================

-- The tender class. PostgreSQL 12+ allows this outside a transaction's later
-- use, which is why nothing below inserts or checks the literal 'cashback'.
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'cashback';

-- ── a redemption can be a till tender ───────────────────────────────────────
ALTER TABLE growth_reward_redemptions
    ADD COLUMN channel       text NOT NULL DEFAULT 'wallet',
    ADD COLUMN order_id      uuid REFERENCES orders(id) ON DELETE RESTRICT,
    ADD COLUMN location_id   uuid REFERENCES locations(id) ON DELETE RESTRICT,
    -- How much of this tender a customer return has already restored. A
    -- partial refund restores part of it; replaying the same sweep or return
    -- restores only the difference, which is what keeps this idempotent.
    ADD COLUMN refunded_rial bigint NOT NULL DEFAULT 0;

ALTER TABLE growth_reward_redemptions
    ADD CONSTRAINT growth_reward_redemptions_channel_check
    CHECK (channel IN ('wallet', 'pos_tender'));

-- A reward paid out in cash/bank is not tied to an order; a till tender is
-- unreadable without one.
ALTER TABLE growth_reward_redemptions
    ADD CONSTRAINT growth_reward_redemptions_channel_shape
    CHECK (
        (channel = 'wallet' AND order_id IS NULL AND payout_method IN ('cash', 'bank'))
        OR (channel = 'pos_tender' AND order_id IS NOT NULL AND payout_method = 'pos_tender')
    );

ALTER TABLE growth_reward_redemptions
    DROP CONSTRAINT growth_reward_redemptions_payout_method_check;

ALTER TABLE growth_reward_redemptions
    ADD CONSTRAINT growth_reward_redemptions_payout_method_check
    CHECK (payout_method IN ('cash', 'bank', 'pos_tender'));

-- Never restore more than was spent.
ALTER TABLE growth_reward_redemptions
    ADD CONSTRAINT growth_reward_redemptions_refunded_check
    CHECK (refunded_rial >= 0 AND refunded_rial <= amount_rial);

-- One till tender per order, whichever worker or replay asks for it.
CREATE UNIQUE INDEX uq_growth_reward_redemptions_order
    ON growth_reward_redemptions (business_id, order_id)
    WHERE channel = 'pos_tender';

-- ── restored: value a refund gives back to the wallet ───────────────────────
ALTER TABLE growth_reward_events
    DROP CONSTRAINT IF EXISTS growth_reward_events_event_type_check;

ALTER TABLE growth_reward_events
    ADD CONSTRAINT growth_reward_events_event_type_check
    CHECK (event_type IN ('earned', 'redeemed', 'reversed', 'expired', 'restored'));

-- A restore is located by its redemption (the tender being given back); the
-- report and the replay guard both read it that way.
CREATE INDEX idx_growth_reward_events_redemption
    ON growth_reward_events (redemption_id)
    WHERE redemption_id IS NOT NULL;
