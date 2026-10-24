-- Issue #915 — purchase integrity for the retail «خرید» path.
--
-- P0: POST /api/stock/purchases created a fresh purchase UUID on every
-- request, so a client retry after a committed-but-lost response produced a
-- SECOND receipt, a second stock receive and a second Debit inventory /
-- Credit AP posting. The fix is the same contract item_supplier_returns and
-- item_stock_transfers already carry: a client-generated idempotency key,
-- unique per business, so the first writer wins and a retry returns the
-- original receipt.
--
-- Both documents additionally record a canonical payload hash so a retry
-- that reuses a key with a DIFFERENT payload is a deterministic conflict
-- (409), never a silent "here is some other purchase's receipt".
--
-- The columns are nullable because historical rows predate the contract;
-- the unique index is partial for the same reason.

ALTER TABLE item_purchases
    ADD COLUMN idempotency_key text,
    ADD COLUMN request_hash    text;

CREATE UNIQUE INDEX idx_item_purchases_idempotency
    ON item_purchases (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Supplier returns already had the unique key (0084); they only gain the
-- payload hash so "same key, different payload" can be refused there too.
ALTER TABLE item_supplier_returns
    ADD COLUMN request_hash text;
