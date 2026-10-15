-- ============================================================================
-- 0222_accounting_dimensions_operations.sql — issue #868, remaining phases:
-- operational attribution (purchases / sales / COGS), payroll dimensions,
-- safe bulk assignment on drafts, and dimensioned opening balances.
--
-- Four additions, one policy (ISSUE_868_PLAN.md §8):
--
--   * accounting_dimension_mappings — the deterministic business-level
--     attribution policy for operational postings. A rule maps ONE source
--     reference (an item, a product category, a supplier, a sales channel) to
--     a dimension tuple. Resolution is stamped at posting time and never
--     re-read, so editing a rule never changes a historical journal line.
--     At most one rule per (business, scope, ref): the policy must be
--     unambiguous, so conflicts are refused at write time, not guessed at
--     posting time.
--
--   * employees.*_id — the per-employee default dimension assignment for
--     payroll salary expense. Prospective only: the payroll run copies it into
--     its own snapshot at accrual, so changing a default never rewrites a
--     posted run.
--
--   * payroll_run_allocations — the per-run, per-member allocation snapshot
--     (shares in basis points + dimension tuple per share + the exact Rial
--     amount each share was charged). The run's journal lines are split by it
--     to the Rial; it is written once at accrual and never updated, which is
--     what keeps posted payroll history intact.
--
--   * journal_entry_draft_dimension_audit — one row per draft line changed by
--     a bulk assignment, before and after. Deliberately NOT foreign-keyed to
--     the draft: approving a draft deletes it (see approveDraft) and the
--     audit of what was assigned must outlive the draft it named.
--
--   * opening_balance_lines gains the four attribution columns, so generated
--     carry-forward openings preserve the prior year's dimension split and a
--     manual opening entry can carry attribution of its own.
--
-- Every dimension reference is structurally guarded with the same
-- `accounting_dimension_check_all` migration 0216 defines (business ownership
-- and kind), and every new table gets the repo's forced-RLS tenant policy in
-- the same migration (AGENTS.md golden rule).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Business-level mapping rules for operational postings.
-- ---------------------------------------------------------------------------

CREATE TABLE accounting_dimension_mappings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- What the rule is keyed by. `item` and `product_category` refs are the
    -- inventory/menu ids a document line carries; `supplier` is the supplier's
    -- id on the purchase; `sales_channel` is the stable channel key the
    -- posting engine already knows (`dine_in`, `takeaway`, `delivery`,
    -- `platform:<method>`, `channel:<name>`).
    scope               text NOT NULL CHECK (scope IN ('item', 'product_category', 'supplier', 'sales_channel')),
    ref                 text NOT NULL CHECK (char_length(btrim(ref)) BETWEEN 1 AND 64),
    cost_center_id      uuid REFERENCES accounting_dimension_values (id),
    profit_center_id    uuid REFERENCES accounting_dimension_values (id),
    department_id       uuid REFERENCES accounting_dimension_values (id),
    detail_dimension_id uuid REFERENCES accounting_dimension_values (id),
    is_active           boolean NOT NULL DEFAULT true,
    effective_from      date,
    effective_to        date,
    note                text CHECK (note IS NULL OR char_length(note) <= 200),
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from),
    -- At least one dimension must be set: an empty rule would silently clear
    -- attribution instead of assigning it.
    CHECK (cost_center_id IS NOT NULL OR profit_center_id IS NOT NULL
        OR department_id IS NOT NULL OR detail_dimension_id IS NOT NULL)
);

-- One rule per (business, scope, ref), ignoring case and surrounding spaces,
-- archived rows included: a retired rule's reference is never silently reused.
CREATE UNIQUE INDEX uq_accounting_dimension_mappings_ref
    ON accounting_dimension_mappings (business_id, scope, lower(btrim(ref)));
CREATE INDEX idx_accounting_dimension_mappings_scope
    ON accounting_dimension_mappings (business_id, scope, is_active);

ALTER TABLE accounting_dimension_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_dimension_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounting_dimension_mappings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE OR REPLACE FUNCTION accounting_dimension_guard_mapping() RETURNS trigger AS $$
BEGIN
    PERFORM accounting_dimension_check_all(
        NEW.business_id, NEW.cost_center_id, NEW.profit_center_id,
        NEW.department_id, NEW.detail_dimension_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE TRIGGER trg_accounting_dimension_mappings_guard
    BEFORE INSERT OR UPDATE OF business_id, cost_center_id, profit_center_id,
                               department_id, detail_dimension_id
    ON accounting_dimension_mappings
    FOR EACH ROW EXECUTE FUNCTION accounting_dimension_guard_mapping();

-- ---------------------------------------------------------------------------
-- 2. Per-employee default payroll attribution (prospective).
-- ---------------------------------------------------------------------------

ALTER TABLE employees
    ADD COLUMN cost_center_id      uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN profit_center_id    uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN department_id       uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN detail_dimension_id uuid REFERENCES accounting_dimension_values (id);

CREATE INDEX idx_employees_cost_center ON employees (cost_center_id) WHERE cost_center_id IS NOT NULL;
CREATE INDEX idx_employees_profit_center ON employees (profit_center_id) WHERE profit_center_id IS NOT NULL;
CREATE INDEX idx_employees_department ON employees (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX idx_employees_detail_dimension ON employees (detail_dimension_id) WHERE detail_dimension_id IS NOT NULL;

CREATE OR REPLACE FUNCTION accounting_dimension_guard_employee() RETURNS trigger AS $$
BEGIN
    IF NEW.cost_center_id IS NULL AND NEW.profit_center_id IS NULL
       AND NEW.department_id IS NULL AND NEW.detail_dimension_id IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM accounting_dimension_check_all(
        NEW.business_id, NEW.cost_center_id, NEW.profit_center_id,
        NEW.department_id, NEW.detail_dimension_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE TRIGGER trg_employees_dimension_guard
    BEFORE INSERT OR UPDATE OF business_id, cost_center_id, profit_center_id,
                               department_id, detail_dimension_id
    ON employees
    FOR EACH ROW EXECUTE FUNCTION accounting_dimension_guard_employee();

-- ---------------------------------------------------------------------------
-- 3. Per-run payroll allocation snapshot.
-- ---------------------------------------------------------------------------

CREATE TABLE payroll_run_allocations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    run_id              uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The share of the member's salary expense this row carries, in basis
    -- points of 10,000. Shares of one (run, member) sum to exactly 10,000.
    share_bp            integer NOT NULL CHECK (share_bp > 0 AND share_bp <= 10000),
    -- The exact Rial amount charged to this share at accrual time (the
    -- largest-remainder split of the member's gross). Written once, with the
    -- run: the audit trail of what was actually posted.
    amount              bigint NOT NULL CHECK (amount >= 0),
    cost_center_id      uuid REFERENCES accounting_dimension_values (id),
    profit_center_id    uuid REFERENCES accounting_dimension_values (id),
    department_id       uuid REFERENCES accounting_dimension_values (id),
    detail_dimension_id uuid REFERENCES accounting_dimension_values (id),
    label               text CHECK (label IS NULL OR char_length(label) <= 80),
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payroll_run_allocations_run ON payroll_run_allocations (run_id, user_id);
CREATE INDEX idx_payroll_run_allocations_cost_center ON payroll_run_allocations (cost_center_id) WHERE cost_center_id IS NOT NULL;
CREATE INDEX idx_payroll_run_allocations_profit_center ON payroll_run_allocations (profit_center_id) WHERE profit_center_id IS NOT NULL;

ALTER TABLE payroll_run_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_run_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payroll_run_allocations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE OR REPLACE FUNCTION accounting_dimension_guard_payroll_allocation() RETURNS trigger AS $$
DECLARE
    v_business uuid;
BEGIN
    SELECT business_id INTO v_business FROM payroll_runs WHERE id = NEW.run_id;
    IF v_business IS NULL OR v_business IS DISTINCT FROM NEW.business_id THEN
        RAISE EXCEPTION 'dimension_mismatch' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.cost_center_id IS NULL AND NEW.profit_center_id IS NULL
       AND NEW.department_id IS NULL AND NEW.detail_dimension_id IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM accounting_dimension_check_all(
        NEW.business_id, NEW.cost_center_id, NEW.profit_center_id,
        NEW.department_id, NEW.detail_dimension_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE TRIGGER trg_payroll_run_allocations_guard
    BEFORE INSERT OR UPDATE OF business_id, run_id, cost_center_id, profit_center_id,
                               department_id, detail_dimension_id
    ON payroll_run_allocations
    FOR EACH ROW EXECUTE FUNCTION accounting_dimension_guard_payroll_allocation();

-- ---------------------------------------------------------------------------
-- 4. Bulk-assignment audit on drafts.
-- ---------------------------------------------------------------------------

CREATE TABLE journal_entry_draft_dimension_audit (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- No foreign key on purpose: the draft is deleted when it is approved or
    -- rejected, and this row is the surviving record of the assignment.
    draft_id    uuid NOT NULL,
    line_id     uuid,
    line_no     integer NOT NULL,
    actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    action      text NOT NULL CHECK (action IN ('bulk_fill', 'bulk_overwrite')),
    before      jsonb NOT NULL DEFAULT '{}'::jsonb,
    after       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_draft_dimension_audit_draft
    ON journal_entry_draft_dimension_audit (business_id, draft_id, created_at);

ALTER TABLE journal_entry_draft_dimension_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry_draft_dimension_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_entry_draft_dimension_audit FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 5. Opening / carry-forward lines keep their attribution.
-- ---------------------------------------------------------------------------

ALTER TABLE opening_balance_lines
    ADD COLUMN cost_center_id      uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN profit_center_id    uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN department_id       uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN detail_dimension_id uuid REFERENCES accounting_dimension_values (id);

CREATE INDEX idx_opening_balance_lines_cost_center ON opening_balance_lines (cost_center_id) WHERE cost_center_id IS NOT NULL;
CREATE INDEX idx_opening_balance_lines_profit_center ON opening_balance_lines (profit_center_id) WHERE profit_center_id IS NOT NULL;
CREATE INDEX idx_opening_balance_lines_department ON opening_balance_lines (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX idx_opening_balance_lines_detail_dimension ON opening_balance_lines (detail_dimension_id) WHERE detail_dimension_id IS NOT NULL;

CREATE OR REPLACE FUNCTION accounting_dimension_guard_opening_line() RETURNS trigger AS $$
DECLARE
    v_business uuid;
BEGIN
    IF NEW.cost_center_id IS NULL AND NEW.profit_center_id IS NULL
       AND NEW.department_id IS NULL AND NEW.detail_dimension_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT s.business_id INTO v_business
      FROM opening_balance_sets s WHERE s.id = NEW.set_id;
    PERFORM accounting_dimension_check_all(
        v_business, NEW.cost_center_id, NEW.profit_center_id,
        NEW.department_id, NEW.detail_dimension_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE TRIGGER trg_opening_balance_lines_dimension_guard
    BEFORE INSERT OR UPDATE OF set_id, cost_center_id, profit_center_id,
                               department_id, detail_dimension_id
    ON opening_balance_lines
    FOR EACH ROW EXECUTE FUNCTION accounting_dimension_guard_opening_line();
