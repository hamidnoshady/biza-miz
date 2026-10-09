-- ============================================================================
-- 0212_payables_invoice_settlement_fields.sql — dashboard audit F11 (the
-- non-payroll half): an expense can be owed rather than paid, a purchase
-- carries its supplier invoice, and a receipt/payment voucher names the cash or
-- bank account it moved through plus the bank's tracking number.
--
-- No new table and no new posting path: every column below annotates a row the
-- existing services already post.
--
-- 1. expenses — «پرداخت بعدی». A `credit` expense posts Debit expense / Credit
--    Accounts Payable (2100) instead of a cash/bank account, so it lands in the
--    A/P subledger and is settled later through the ordinary A/P payment
--    (`payBill`). `payment_account_id` keeps pointing at the account that was
--    credited (2100 for a credit expense), so every existing read still joins.
--    A credit expense names its supplier (the branch alias every A/P write
--    references); without one there would be nothing `payBill` could settle.
--
-- 2. purchases — the supplier's invoice number and date, the VAT on it
--    (integer Rial, posted to input VAT 1220 on receipt so the VAT report reads
--    it), and the payment terms / due date. `total` stays the goods value the
--    stock costing checks against; the payable is total + vat_amount.
--
-- 3. ar_receipts / ap_payments — which cash/bank account the money moved
--    through (NULL = the method's default account, as before) and the bank's
--    tracking/reference number.
-- ============================================================================

ALTER TABLE expenses
    ADD COLUMN settlement text NOT NULL DEFAULT 'paid' CHECK (settlement IN ('paid', 'credit')),
    ADD COLUMN supplier_id uuid REFERENCES suppliers(id) ON DELETE RESTRICT,
    ADD COLUMN due_date date;

ALTER TABLE expenses
    ADD CONSTRAINT expenses_settlement_shape CHECK (
        (settlement = 'paid' AND supplier_id IS NULL AND due_date IS NULL)
        OR (settlement = 'credit' AND supplier_id IS NOT NULL)
    );

CREATE INDEX idx_expenses_supplier ON expenses (supplier_id) WHERE supplier_id IS NOT NULL;

ALTER TABLE purchases
    ADD COLUMN supplier_invoice_number text CHECK (supplier_invoice_number IS NULL OR char_length(supplier_invoice_number) <= 64),
    ADD COLUMN supplier_invoice_date date,
    ADD COLUMN vat_amount bigint NOT NULL DEFAULT 0 CHECK (vat_amount >= 0), -- Rial
    ADD COLUMN payment_terms_days integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 3650),
    ADD COLUMN payment_due_date date;

ALTER TABLE ar_receipts
    ADD COLUMN cash_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
    ADD COLUMN bank_reference text CHECK (bank_reference IS NULL OR char_length(bank_reference) <= 64);

ALTER TABLE ap_payments
    ADD COLUMN cash_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
    ADD COLUMN bank_reference text CHECK (bank_reference IS NULL OR char_length(bank_reference) <= 64);
