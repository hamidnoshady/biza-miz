-- Issue #902 §9 item 3 (second half) — invoice lines emitted from the ratings.
--
-- 0270 taught a rating to say which price produced its amount. That answers
-- "how was this number computed?" for one row. It does not answer the question a
-- business actually asks when it receives a bill: *what am I being charged for
-- this month, on what terms?* An invoice line is that answer, and until now
-- `billing_invoice_lines` had no `kind = 'usage'` writer at all — usage was
-- reported (`billing_usage_ratings`, the spend breakdown, the console) but never
-- invoiced, so a business's rated usage and its invoices were two ledgers that
-- never met.
--
-- Two things are added, and both are about the line being *checkable*:
--
--   1. The line carries the same provenance vocabulary as the rating
--      (`price_basis`, `retail_price_version_id`, `retail_price_version`), so a
--      line can be traced to the catalogue and version that priced it instead of
--      citing whatever meter version happened to be current. The pairing CHECKs
--      mirror 0270's exactly, for the same reason: `billing_price_versions` and
--      `kavenegar_retail_price_versions` are different catalogues.
--
--      Legacy lines are all-NULL and still valid: NULL means "not one of the
--      usage bases" (a plan or add-on line, whose price version is a plan price)
--      or "written before 0274" — the same unknown-not-guessed rule as 0268/0270.
--
--   2. `billing_invoice_line_usage` links a line to the ratings it was built
--      from, one row per rating, with a UNIQUE index on `usage_event_id`. That is
--      what makes a usage invoice idempotent in the only sense that matters: a
--      rating can be billed **at most once, ever**, by any invoice. The invoice's
--      own `UNIQUE (business_id, reference)` claim stops a second invoice for the
--      same month; this index stops a rating that arrived late (or with an
--      occurrence date in a previous window) from being collected twice by the
--      next month's run.
--
-- Amounts stay integers in Rial, as everywhere else.

ALTER TABLE billing_invoice_lines
    ADD COLUMN price_basis text
        CHECK (price_basis IN ('meter_price_version', 'retail_price_version', 'explicit_amount')),
    -- The retail catalogue, by id when the row still exists…
    ADD COLUMN retail_price_version_id uuid
        REFERENCES kavenegar_retail_price_versions(id) ON DELETE SET NULL,
    -- …and by number always: the built-in default is version 0 with no row.
    ADD COLUMN retail_price_version integer
        CHECK (retail_price_version IS NULL OR retail_price_version >= 0);

COMMENT ON COLUMN billing_invoice_lines.price_basis IS
    'Issue #902 §9 item 3: which price produced this line. NULL = a plan/add-on line (its own catalogue) or a line written before 0274.';
COMMENT ON COLUMN billing_invoice_lines.retail_price_version IS
    'The kavenegar_retail_price_versions number that priced this usage line. 0 = the built-in default, which has no row.';

ALTER TABLE billing_invoice_lines
    -- Only a usage line has one of these bases; a plan line's provenance is its
    -- plan price version in `price_version_id`, and that stays as it was.
    ADD CONSTRAINT billing_invoice_lines_basis_is_usage
        CHECK (price_basis IS NULL OR kind = 'usage'),
    -- The basis and the retail version are one fact, not two (0270's rule).
    ADD CONSTRAINT billing_invoice_lines_retail_basis_paired
        CHECK ((price_basis = 'retail_price_version') = (retail_price_version IS NOT NULL)),
    -- A retail-priced line must not point at the meter catalogue.
    ADD CONSTRAINT billing_invoice_lines_retail_has_no_meter_version
        CHECK (price_basis IS DISTINCT FROM 'retail_price_version' OR price_version_id IS NULL);

-- ---------------------------------------------------------------------------
-- Which ratings a line was built from
-- ---------------------------------------------------------------------------
CREATE TABLE billing_invoice_line_usage (
    line_id             uuid NOT NULL REFERENCES billing_invoice_lines(id) ON DELETE CASCADE,
    -- The rating is identified by its usage event: one rating per event.
    usage_event_id      uuid NOT NULL REFERENCES billing_usage_ratings(usage_event_id) ON DELETE RESTRICT,
    -- Denormalised so the RLS policy does not have to walk two parents, and so
    -- "what has this business been billed for?" is one index scan.
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    meter_key           text NOT NULL,
    -- What this rating contributed to the line. The line's `amount_rial` is the
    -- sum of these, and a test asserts it: a line that does not add up is a bill
    -- nobody can defend.
    rated_amount_rial   bigint NOT NULL CHECK (rated_amount_rial >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (line_id, usage_event_id)
);

-- One rating is billed once, ever — across invoices, across months, across
-- retries. This is the guarantee the whole slice rests on.
CREATE UNIQUE INDEX billing_invoice_line_usage_once
    ON billing_invoice_line_usage (usage_event_id);
CREATE INDEX idx_billing_invoice_line_usage_business
    ON billing_invoice_line_usage (business_id, created_at DESC);

ALTER TABLE billing_invoice_line_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoice_line_usage FORCE ROW LEVEL SECURITY;
-- Tenant-visible: an invoice line is the business's own bill. The bypass is the
-- platform console, which reads every business's invoices.
CREATE POLICY tenant_isolation ON billing_invoice_line_usage FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
