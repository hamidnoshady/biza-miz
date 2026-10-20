-- Issue #913 — POS cashier audit follow-up (10 Oct 2026 read-only audit).
--
-- Three columns that make the checkout's promises durable:
--
--  1. orders.request_fingerprint — payload fingerprint paired with the
--     existing client_request_id (migration 0129). A retry with the SAME key
--     and the SAME business intent returns the original order; the same key
--     with a CHANGED payload is a hard conflict (409), never a silent second
--     order and never a silent collapse of two genuinely different purchases.
--     Same shape as ap_payments.request_fingerprint (migration 0211): the two
--     columns are written together or not at all.
--
--  2. orders.promotion_ids — the promotion-eligibility SNAPSHOT taken when an
--     F&B order is opened (issue #913 item 4). recomputeOrderTotals re-prices
--     an open order on every amendment; without this, a campaign that starts,
--     ends or is paused between opening and editing would change the bill the
--     guest already agreed to. NULL means "no snapshot" (every order that
--     predates this migration), which keeps live evaluation for legacy rows.
--
--  3. order_items.tax_rate_snapshot — the category VAT rate frozen when the
--     line entered the order (issue #913 item 11), mirroring how unit_price is
--     already snapshotted while menu_categories.tax_rate stays live for lines
--     not yet sold. NULL = legacy line, priced from the live category rate as
--     before.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promotion_ids jsonb;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_rate_snapshot numeric;

-- F&B orders now rewrite their effectiveness rows on every recompute
-- (order-totals.ts); retail invoices write them once. One index serves both
-- the rewrite's DELETE and the per-order audit reads.
CREATE INDEX IF NOT EXISTS idx_promotion_applications_source
  ON promotion_applications (source_type, source_id);

-- New writes must pair the key with its fingerprint (app-enforced in
-- order-mutations.ts / retail-invoice-service.ts). NOT VALID: rows written by
-- an older bundle may hold a key without a fingerprint, and existing keys are
-- already short uuids — the check governs what this release writes.
ALTER TABLE orders
  ADD CONSTRAINT orders_client_request_pairing
  CHECK ((client_request_id IS NULL) = (request_fingerprint IS NULL))
  NOT VALID;
ALTER TABLE orders
  ADD CONSTRAINT orders_client_request_length
  CHECK (client_request_id IS NULL OR length(btrim(client_request_id)) BETWEEN 1 AND 200)
  NOT VALID;
