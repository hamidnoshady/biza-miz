-- Opaque fencing token: status can revisit 'sending' / 'submitted', a claim cannot.
ALTER TABLE tax_invoice_submissions ADD COLUMN claim_token uuid;
