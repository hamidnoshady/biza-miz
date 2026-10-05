-- Issue #795 (watch lifecycle audit) Phase 1 — accounting-correctness guards
-- for the shared repair workflow.
--
-- 1. Warranty billing must be a server-enforced invariant, not a UI hint:
--    an under-warranty ticket may only carry customer charges (labor or
--    parts) when the shop has recorded an explicit out-of-coverage reason
--    agreed with the customer. The column below is that record; the
--    enforcement lives in src/lib/repairs-service.ts, which refuses a
--    charge on a warranty ticket while this is NULL.
ALTER TABLE repair_tickets
  ADD COLUMN non_covered_reason text;

-- 2. Repair parts need an explicit cost source so the closing COGS posting
--    can derive from parts that really left the shop's own inventory:
--      - 'stock'    — consumed from the shop's own inventory; relieved from
--                     the industry's inventory account when the ticket
--                     closes (watch → 1330, jewelry → 1320).
--      - 'external' — bought outside for this job (or supplied by the
--                     customer); its cost is recorded by the purchase or
--                     expense that acquired it, so the close must NOT credit
--                     the shop's inventory for it.
--    Existing rows default to 'stock', which preserves the posting behavior
--    they were created under.
ALTER TABLE repair_ticket_parts
  ADD COLUMN source text NOT NULL DEFAULT 'stock'
    CHECK (source IN ('stock', 'external'));
