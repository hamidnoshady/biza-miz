-- Issue #915 (follow-up slice) — settlement and the supplier invoice on the
-- retail «خرید», and the ادواری credit note on the F&B supplier return.
--
-- 1) item_purchases: the retail receipt always posted Credit حساب‌های
--    پرداختنی, with no way to say the goods were paid from the till or the
--    bank — and no record of the supplier's own invoice (number/date), the
--    VAT it carried, or when it falls due. These are the same columns the
--    F&B `purchases` table gained in 0212, with the same constraint shapes,
--    so the two models' payables surfaces read identically.
--    `settlement_method` defaults to 'credit' because that is exactly what
--    every historical row did post (Credit AP).
--
-- 2) supplier_return_lines.stock_movement_id becomes nullable: under سیستم
--    ادواری a received purchase is a journal-only fact (Debit 5105, no lots,
--    no stock movements), so its credit note reverses value without a stock
--    movement to point at. Every perpetual return line still writes one —
--    the service never passes NULL on those paths.

ALTER TABLE item_purchases
    ADD COLUMN settlement_method text NOT NULL DEFAULT 'credit'
        CHECK (settlement_method IN ('credit', 'cash', 'bank')),
    ADD COLUMN supplier_invoice_number text
        CHECK (supplier_invoice_number IS NULL OR char_length(supplier_invoice_number) <= 64),
    ADD COLUMN supplier_invoice_date date,
    ADD COLUMN vat_amount bigint NOT NULL DEFAULT 0 CHECK (vat_amount >= 0), -- Rial
    ADD COLUMN payment_terms_days integer
        CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 3650),
    ADD COLUMN payment_due_date date;

ALTER TABLE supplier_return_lines
    ALTER COLUMN stock_movement_id DROP NOT NULL;
