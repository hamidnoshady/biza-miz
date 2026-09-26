-- Phase — the retail invoice line snapshot.
--
-- `order_items` is F&B's shape: `quantity` is an integer column and
-- `unit_price` is meant to be one catalogue price. Retail lines can be
-- fractional (2.5 grams of gold, 0.75 metres of ribbon) and individually
-- priced (an agreed watch price, a negotiated اجرت), so
-- retail-invoice-service.ts has always written `quantity = 1` and folded the
-- whole line's net into `unit_price` to avoid a rounding disagreement with the
-- ledger. That is correct for the money, but it means a historical read of
-- `order_items` alone cannot answer "how many were sold" or "what discount did
-- this line carry" for a retail sale — exactly the fidelity a reprint or an
-- invoice-detail screen needs months later.
--
-- Rather than a second invoice/invoice-lines table duplicating `orders` (the
-- canonical commercial transaction header stays exactly that), this adds one
-- JSONB column carrying the immutable, industry-aware sale snapshot for a
-- retail line: real quantity, unit, unit price, gross/discount/promotion/VAT/
-- net/total, and whichever industry fields applied (gold weight/purity/rate/
-- making-charge/profit, watch serial/warranty/provenance, cosmetics batch/
-- expiry). NULL on every F&B line, which is every line before this column
-- existed and every line a café ever writes.
--
-- No backfill: a historical retail invoice written before this column existed
-- has no way to recover its true quantity/discount split (the information was
-- never persisted), and fabricating one would violate the "do not invent
-- data" rule. `getRetailInvoiceDetail` (src/lib/retail-invoice/read-service.ts)
-- falls back to the legacy `quantity`/`unit_price` columns for those rows and
-- marks them `legacy: true` rather than pretending they have full fidelity.
ALTER TABLE order_items
    ADD COLUMN retail_snapshot jsonb;

COMMENT ON COLUMN order_items.retail_snapshot IS
  'Immutable sold-line snapshot for a retail invoice line (order_items.item_id IS NOT NULL and orders.type = ''retail''). See src/lib/retail-invoice/types.ts.';
