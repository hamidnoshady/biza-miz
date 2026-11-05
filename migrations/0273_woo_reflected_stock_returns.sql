-- Issue 951: a sale already included in the imported snapshot relieved zero local
-- units. A later confirmed Woo restock must still return those sold units.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
    WHERE conrelid = 'online_sale_lines'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%restored_quantity <= relieved_quantity%';
  IF constraint_name IS NULL THEN RAISE EXCEPTION 'sale restoration bound missing'; END IF;
  EXECUTE format('ALTER TABLE online_sale_lines DROP CONSTRAINT %I', constraint_name);
END $$;
ALTER TABLE online_sale_lines ADD CONSTRAINT online_sale_lines_return_stock_bound
  CHECK (restored_quantity <= CASE WHEN stock_outcome = 'already_reflected'
    THEN quantity - short_quantity ELSE relieved_quantity END);
