-- Managed floats reference the existing money container and its GL; count snapshots
-- are observations, never balances. Posted movements reference canonical documents.
CREATE TABLE petty_cash_funds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_id uuid NOT NULL UNIQUE REFERENCES financial_accounts(id) ON DELETE RESTRICT,
    funding_account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    custodian_id uuid NOT NULL,
    ceiling bigint NOT NULL CHECK (ceiling > 0),
    policy text NOT NULL CHECK (policy IN ('fixed', 'variable')),
    category_account_ids uuid[] NOT NULL CHECK (cardinality(category_account_ids) BETWEEN 1 AND 100),
    approval_roles text[] NOT NULL CHECK (
        cardinality(approval_roles) BETWEEN 1 AND 4 AND
        approval_roles <@ ARRAY['owner', 'admin', 'manager', 'accountant']::text[]
    ),
    funded_at timestamptz,
    closed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (id, business_id),
    FOREIGN KEY (custodian_id, business_id) REFERENCES employees(id, business_id) ON DELETE RESTRICT,
    CHECK (account_id <> funding_account_id),
    CHECK (closed_at IS NULL OR funded_at IS NOT NULL)
);
CREATE INDEX petty_cash_funds_by_branch ON petty_cash_funds (business_id, location_id, custodian_id);
ALTER TABLE petty_cash_funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_funds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON petty_cash_funds FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE petty_cash_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    fund_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('fund', 'submit', 'replenish', 'reconcile', 'close')),
    status text NOT NULL CHECK (status IN ('posted', 'pending', 'approved', 'rejected', 'matched', 'discrepancy')),
    business_date date NOT NULL,
    amount bigint NOT NULL CHECK (amount >= 0),
    ledger_balance numeric(40,0),
    note text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 500),
    category_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
    receipt_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
    receipt_file_name text,
    transfer_id uuid UNIQUE REFERENCES financial_transfers(id) ON DELETE RESTRICT,
    expense_id uuid UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at timestamptz,
    decision_note text CHECK (decision_note IS NULL OR char_length(btrim(decision_note)) BETWEEN 1 AND 500),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
    request_hash text NOT NULL,
    decision_key text CHECK (decision_key IS NULL OR char_length(decision_key) BETWEEN 1 AND 200),
    decision_hash text,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (fund_id, business_id) REFERENCES petty_cash_funds(id, business_id) ON DELETE CASCADE,
    UNIQUE (business_id, fund_id, idempotency_key),
    UNIQUE (business_id, fund_id, decision_key),
    CHECK ((decision_key IS NULL) = (decision_hash IS NULL)),
    CHECK ((kind = 'submit') = (category_account_id IS NOT NULL)),
    CHECK ((kind = 'submit') = (status IN ('pending', 'approved', 'rejected'))),
    CHECK ((kind = 'reconcile') = (status IN ('matched', 'discrepancy'))),
    CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
    CHECK ((status = 'approved') = (expense_id IS NOT NULL)),
    CHECK ((kind IN ('fund', 'replenish') OR (kind = 'close' AND amount > 0)) = (transfer_id IS NOT NULL)),
    CHECK ((kind IN ('reconcile', 'close')) = (ledger_balance IS NOT NULL))
);
CREATE INDEX petty_cash_operations_history ON petty_cash_operations (business_id, fund_id, created_at DESC, id);
CREATE INDEX petty_cash_operations_pending ON petty_cash_operations (business_id, fund_id) WHERE status = 'pending';
ALTER TABLE petty_cash_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON petty_cash_operations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
