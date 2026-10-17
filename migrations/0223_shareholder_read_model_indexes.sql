-- Read-model indexes for complete, cursor-paginated shareholder history.
-- These indexes preserve append-only source facts and add no shadow balances.
SELECT set_config('app.rls_bypass', 'on', true);

CREATE INDEX IF NOT EXISTS idx_shareholder_events_history_page
    ON shareholder_events (business_id, effective_on DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_shareholder_distributions_history_page
    ON shareholder_distributions (business_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_shareholder_distributions_year_page
    ON shareholder_distributions (business_id, fiscal_year_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_shareholder_distributions_status_page
    ON shareholder_distributions (business_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_shareholder_distribution_payments_history_page
    ON shareholder_distribution_payments (business_id, paid_on DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_shareholder_distribution_payments_distribution_page
    ON shareholder_distribution_payments (business_id, distribution_id, paid_on DESC, created_at DESC, id DESC);
