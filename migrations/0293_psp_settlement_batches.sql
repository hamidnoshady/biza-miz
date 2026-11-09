-- A confirmed installment is an existing exact financial transfer. Unpaid
-- funds remain on the terminal's clearing GL; this adds no second balance.
ALTER TABLE financial_transfers
    ADD COLUMN psp_batch_reference text,
    ADD COLUMN psp_movement_reference text,
    ADD COLUMN psp_batch_gross_amount bigint,
    ADD COLUMN psp_expected_on date,
    ADD CONSTRAINT financial_transfers_psp_settlement_shape CHECK (
        (psp_batch_reference IS NULL AND psp_movement_reference IS NULL
            AND psp_batch_gross_amount IS NULL AND psp_expected_on IS NULL)
        OR (psp_batch_reference IS NOT NULL AND char_length(btrim(psp_batch_reference)) BETWEEN 1 AND 60
            AND psp_movement_reference IS NOT NULL AND char_length(btrim(psp_movement_reference)) BETWEEN 1 AND 60
            AND psp_batch_gross_amount IS NOT NULL AND psp_batch_gross_amount >= amount
            AND posting_mode = 'transfer' AND currency_code = 'IRR' AND fee_payer = 'destination'
            AND fee_amount < amount AND reference_number IS NOT NULL AND reference_number = psp_movement_reference
            AND idempotency_key IS NOT NULL AND idempotency_key LIKE 'psp-settlement:%')
    );

CREATE UNIQUE INDEX uq_financial_transfers_psp_movement
    ON financial_transfers (business_id, source_account_id, psp_movement_reference)
    WHERE psp_batch_reference IS NOT NULL;

CREATE INDEX idx_financial_transfers_psp_batch
    ON financial_transfers (business_id, source_account_id, psp_batch_reference)
    WHERE psp_batch_reference IS NOT NULL;
