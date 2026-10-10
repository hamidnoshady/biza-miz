-- ============================================================================
-- 0216_accounting_dimensions.sql — issue #868: accounting dimensions.
--
-- Cost centre, profit centre, department and one configurable «detail»
-- dimension, attributed per JOURNAL LINE (the canonical model — see
-- ISSUE_868_PLAN.md §1 for why line rather than entry).
--
--   * accounting_dimension_settings — per business and per kind: is the kind
--     enabled for new postings, and (for the detail kind) what it is called.
--     No row means disabled: a tenant pays for no dimension it has not turned on.
--   * accounting_dimension_values  — the records. Business scoped, code, name,
--     optional parent (same kind, no cycles), optional branch restriction,
--     optional effective dates, and an active flag. Archive, never delete,
--     once a value has postings (the service enforces that; the foreign keys
--     below make a hard delete of a referenced value impossible anyway).
--
-- Project and branch are NOT dimensions here. They already live on
-- `journal_entries` (`project_id`, `location_id`) and stay there — a line never
-- copies them, so a report that needs both reads the header and the line.
--
-- The four line columns carry the attribution. The database guards what can
-- never be true of any row, whatever the service decided: the value belongs to
-- the same business as the entry, and it is a value of the right kind. The
-- *policy* questions (is the kind enabled, is the value active or a leaf, is it
-- open on this date, is it open at this branch) change over time and are
-- decided by the service, so an archived value still satisfies a historical
-- posting and a reversal of it.
-- ============================================================================

CREATE TABLE accounting_dimension_settings (
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('cost_center', 'profit_center', 'department', 'detail')),
    is_enabled  boolean NOT NULL DEFAULT false,
    -- The name the business gives its one configurable detail dimension. The
    -- three fixed kinds are named by the product, so they carry no label.
    label       text CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 80),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (business_id, kind),
    CHECK (kind = 'detail' OR label IS NULL)
);

ALTER TABLE accounting_dimension_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_dimension_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounting_dimension_settings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE accounting_dimension_values (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind            text NOT NULL CHECK (kind IN ('cost_center', 'profit_center', 'department', 'detail')),
    code            text NOT NULL CHECK (char_length(btrim(code)) BETWEEN 1 AND 32),
    name            text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
    parent_id       uuid,
    -- NULL means the value may be used at every branch and by business-wide
    -- entries. A value restricted to a branch can only be posted by that branch.
    location_id     uuid REFERENCES locations(id) ON DELETE SET NULL,
    effective_from  date,
    effective_to    date,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (parent_id IS NULL OR parent_id <> id),
    CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from),
    -- A parent is the same kind in the same business. The composite key makes
    -- a cross-kind or cross-tenant hierarchy a foreign-key error, not a report
    -- that quietly sums the wrong thing.
    UNIQUE (id, business_id, kind),
    FOREIGN KEY (parent_id, business_id, kind)
        REFERENCES accounting_dimension_values (id, business_id, kind)
);

-- Codes are unique per business and kind, ignoring case and surrounding spaces,
-- and that includes archived values: an archived code is never handed to a new
-- value, so a historical report can never show one code meaning two things.
CREATE UNIQUE INDEX uq_accounting_dimension_values_code
    ON accounting_dimension_values (business_id, kind, lower(btrim(code)));
CREATE INDEX idx_accounting_dimension_values_kind
    ON accounting_dimension_values (business_id, kind, is_active);
CREATE INDEX idx_accounting_dimension_values_parent
    ON accounting_dimension_values (parent_id) WHERE parent_id IS NOT NULL;

ALTER TABLE accounting_dimension_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_dimension_values FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounting_dimension_values FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- A parent chain that loops back to the value itself would make every rollup
-- of it recurse forever. Refuse the write rather than trust the screen.
CREATE OR REPLACE FUNCTION accounting_dimension_no_cycle() RETURNS trigger AS $$
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        WITH RECURSIVE ancestors AS (
            SELECT id, parent_id FROM accounting_dimension_values WHERE id = NEW.parent_id
            UNION ALL
            SELECT v.id, v.parent_id
              FROM accounting_dimension_values v
              JOIN ancestors a ON v.id = a.parent_id
        )
        SELECT 1 FROM ancestors WHERE id = NEW.id
    ) THEN
        RAISE EXCEPTION 'dimension_cycle' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_accounting_dimension_no_cycle
    BEFORE INSERT OR UPDATE OF parent_id ON accounting_dimension_values
    FOR EACH ROW EXECUTE FUNCTION accounting_dimension_no_cycle();

-- The structural guard shared by every table that carries the four columns.
-- A NULL id is always allowed; a set id must name a value of this business and
-- of the kind its column stands for. Row-level security applies to the lookup,
-- so a value of another tenant is simply not found.
CREATE OR REPLACE FUNCTION accounting_dimension_check_one(p_business uuid, p_id uuid, p_kind text)
RETURNS void AS $$
DECLARE
    v_business uuid;
    v_kind text;
BEGIN
    IF p_id IS NULL THEN
        RETURN;
    END IF;
    SELECT business_id, kind INTO v_business, v_kind
      FROM accounting_dimension_values WHERE id = p_id;
    IF NOT FOUND OR v_business IS DISTINCT FROM p_business OR v_kind IS DISTINCT FROM p_kind THEN
        RAISE EXCEPTION 'dimension_mismatch' USING ERRCODE = 'P0001';
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION accounting_dimension_check_all(
    p_business uuid,
    p_cost_center uuid,
    p_profit_center uuid,
    p_department uuid,
    p_detail uuid
) RETURNS void AS $$
BEGIN
    PERFORM accounting_dimension_check_one(p_business, p_cost_center, 'cost_center');
    PERFORM accounting_dimension_check_one(p_business, p_profit_center, 'profit_center');
    PERFORM accounting_dimension_check_one(p_business, p_department, 'department');
    PERFORM accounting_dimension_check_one(p_business, p_detail, 'detail');
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- The attribution columns. Nullable, because most lines of most documents carry
-- none, and NO ACTION (not RESTRICT) so that deleting a business — which cascades
-- through these rows in one statement — is not blocked by the order the cascade
-- happens to visit them in. Deleting a *referenced* value is blocked at the end
-- of the statement, which is the protection that matters.
-- ---------------------------------------------------------------------------
ALTER TABLE journal_lines
    ADD COLUMN cost_center_id uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN profit_center_id uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN department_id uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN detail_dimension_id uuid REFERENCES accounting_dimension_values (id);

CREATE INDEX idx_journal_lines_cost_center ON journal_lines (cost_center_id) WHERE cost_center_id IS NOT NULL;
CREATE INDEX idx_journal_lines_profit_center ON journal_lines (profit_center_id) WHERE profit_center_id IS NOT NULL;
CREATE INDEX idx_journal_lines_department ON journal_lines (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX idx_journal_lines_detail_dimension ON journal_lines (detail_dimension_id) WHERE detail_dimension_id IS NOT NULL;

CREATE OR REPLACE FUNCTION accounting_dimension_guard_journal_line() RETURNS trigger AS $$
DECLARE
    v_business uuid;
BEGIN
    IF NEW.cost_center_id IS NULL AND NEW.profit_center_id IS NULL
       AND NEW.department_id IS NULL AND NEW.detail_dimension_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT business_id INTO v_business FROM journal_entries WHERE id = NEW.entry_id;
    PERFORM accounting_dimension_check_all(
        v_business, NEW.cost_center_id, NEW.profit_center_id, NEW.department_id, NEW.detail_dimension_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE TRIGGER trg_journal_lines_dimension_guard
    BEFORE INSERT OR UPDATE OF entry_id, cost_center_id, profit_center_id, department_id, detail_dimension_id
    ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION accounting_dimension_guard_journal_line();

ALTER TABLE journal_entry_draft_lines
    ADD COLUMN cost_center_id uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN profit_center_id uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN department_id uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN detail_dimension_id uuid REFERENCES accounting_dimension_values (id);

CREATE OR REPLACE FUNCTION accounting_dimension_guard_draft_line() RETURNS trigger AS $$
DECLARE
    v_business uuid;
BEGIN
    IF NEW.cost_center_id IS NULL AND NEW.profit_center_id IS NULL
       AND NEW.department_id IS NULL AND NEW.detail_dimension_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT business_id INTO v_business FROM journal_entry_drafts WHERE id = NEW.draft_id;
    PERFORM accounting_dimension_check_all(
        v_business, NEW.cost_center_id, NEW.profit_center_id, NEW.department_id, NEW.detail_dimension_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE TRIGGER trg_journal_entry_draft_lines_dimension_guard
    BEFORE INSERT OR UPDATE OF draft_id, cost_center_id, profit_center_id, department_id, detail_dimension_id
    ON journal_entry_draft_lines
    FOR EACH ROW EXECUTE FUNCTION accounting_dimension_guard_draft_line();

-- An expense is the document an expense line's attribution comes from: the
-- debit to the expense account carries it, and reversal copies it, so the
-- expense row keeps what its journal says.
ALTER TABLE expenses
    ADD COLUMN cost_center_id uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN profit_center_id uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN department_id uuid REFERENCES accounting_dimension_values (id),
    ADD COLUMN detail_dimension_id uuid REFERENCES accounting_dimension_values (id);

CREATE OR REPLACE FUNCTION accounting_dimension_guard_expense() RETURNS trigger AS $$
BEGIN
    PERFORM accounting_dimension_check_all(
        NEW.business_id, NEW.cost_center_id, NEW.profit_center_id, NEW.department_id, NEW.detail_dimension_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE TRIGGER trg_expenses_dimension_guard
    BEFORE INSERT OR UPDATE OF business_id, cost_center_id, profit_center_id, department_id, detail_dimension_id
    ON expenses
    FOR EACH ROW EXECUTE FUNCTION accounting_dimension_guard_expense();
