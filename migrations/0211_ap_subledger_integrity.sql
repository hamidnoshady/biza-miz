-- Issue #826 — canonical A/P subledger attribution, retry safety and reversals.
--
-- The payment row and its journal entry remain one transaction. The opaque
-- client request id is scoped to a business; the request fingerprint prevents
-- a caller from reusing that key with a different supplier or amount. NULL is
-- retained for historical/imported rows written before idempotency existed.
ALTER TABLE ap_payments
    ADD COLUMN client_request_id text,
    ADD COLUMN request_fingerprint text;

ALTER TABLE ap_payments
    ADD CONSTRAINT ap_payments_client_request_id_length
        CHECK (client_request_id IS NULL OR length(btrim(client_request_id)) BETWEEN 1 AND 200),
    ADD CONSTRAINT ap_payments_request_fingerprint_shape
        CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT ap_payments_request_metadata_pair
        CHECK ((client_request_id IS NULL) = (request_fingerprint IS NULL));

CREATE UNIQUE INDEX uq_ap_payments_business_client_request_id
    ON ap_payments (business_id, client_request_id)
    WHERE client_request_id IS NOT NULL;

-- The subledger reads the AP control account first, joins the entry date, then
-- applies the attribution contract. These composites cover that access path
-- and preserve stable entry ordering without returning the whole ledger to JS.
CREATE INDEX idx_journal_lines_account_entry
    ON journal_lines (account_id, entry_id, id);

CREATE INDEX idx_journal_entries_business_date_posted_id
    ON journal_entries (business_id, entry_date, posted_at, id);

CREATE INDEX idx_ap_payments_business_supplier_date
    ON ap_payments (business_id, supplier_id, payment_date DESC, created_at DESC, id DESC);
