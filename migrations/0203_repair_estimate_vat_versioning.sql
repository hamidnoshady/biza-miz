-- Issue #795 item 11 — the estimate becomes financially complete and its
-- approval becomes versioned.
--
-- Before: the estimate stored labour+parts only, so the customer approved a
-- number the final bill (which adds VAT) never matched; and the approval was
-- a bare timestamp, so a financial change after the signature (a raised
-- labour charge, a new chargeable part) silently kept the old approval.
--
-- Now the estimate carries its own discount and VAT (computed with the
-- ticket's own vat_percent, the same engine the close uses) so the approved
-- total IS the payable total; and every re-estimate bumps estimate_version
-- while approval records WHICH version was approved. Any financial change —
-- re-estimate, labour/VAT edit, chargeable part added or removed — clears
-- the approval: a changed number is a new document to approve.

ALTER TABLE repair_tickets
    ADD COLUMN estimated_discount_rial bigint NOT NULL DEFAULT 0 CHECK (estimated_discount_rial >= 0),
    ADD COLUMN estimated_vat_rial bigint NOT NULL DEFAULT 0 CHECK (estimated_vat_rial >= 0),
    ADD COLUMN estimate_version integer NOT NULL DEFAULT 0,
    ADD COLUMN estimate_approved_version integer;

-- Existing estimates become version 1; an existing approval approved that
-- same version (there was no other), so history stays valid.
UPDATE repair_tickets SET estimate_version = 1 WHERE estimated_at IS NOT NULL;
UPDATE repair_tickets SET estimate_approved_version = 1 WHERE estimate_approved_at IS NOT NULL;
