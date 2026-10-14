-- ---------------------------------------------------------------------------
-- Issue #867 (Scope B) — the optional accountant reference number on manual
-- journal drafts.
--
-- A posted document may carry the number it was known by before it entered
-- this ledger (the "original source reference"). On the manual journal the
-- reference is typed when the draft is written and travels with the draft
-- until approval, where `postJournalEntry` writes it onto the entry as
-- `journal_entries.voucher_reference` — advisory metadata only, never part
-- of the fiscal-year sequence (migration 0217 owns that column's CHECK, and
-- it is repeated here so a draft cannot hold a reference the entry could
-- not store).
-- ---------------------------------------------------------------------------

ALTER TABLE journal_entry_drafts
    ADD COLUMN voucher_reference text
        CHECK (voucher_reference IS NULL OR voucher_reference ~ '^[A-Za-z0-9._/-]{1,64}$');
