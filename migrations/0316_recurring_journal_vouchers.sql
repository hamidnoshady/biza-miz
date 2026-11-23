-- Issue #1323 / ESH-160 — recurring journal voucher templates and scheduled
-- entries.
--
-- This is a scheduling and controlled *draft-generation* layer over the
-- existing manual-journal workflow (migration 0029): every occurrence becomes a
-- `journal_entry_drafts` row and reaches the ledger only through the existing
-- `ledger.approve` route. Nothing here posts an entry, and no column can make
-- it do so.
--
-- ## The exactly-once contract
--
-- `recurring_journal_occurrences` has two unique keys:
--   * `(template_id, scheduled_date)` — one occurrence per template per date,
--     enforced by the database rather than a read-then-write in a worker;
--   * `(business_id, idempotency_key)` — the same deterministic string the
--     generation path hands to `journal_entry_drafts`, whose own unique index
--     (0211) then makes the *draft* exactly-once too.
-- Two workers, a retried tick, an application restart and a replayed event all
-- collide in these indexes instead of creating a second voucher.
--
-- ## Template versions
--
-- A template's lines are snapshotted into the occurrence at claim time
-- (`lines_snapshot`, `template_version`, `memo`, `location_id`). Editing the
-- template bumps `current_version` and appends a `recurring_journal_template_versions`
-- row; it never rewrites an occurrence, a draft or a posted entry. That is what
-- makes «ویرایش از این پس اعمال شود» true rather than aspirational.
--
-- ## Rollback
--
-- Forward-only, like every migration here. To withdraw the feature safely:
--   1. stop the recurring-voucher tick and remove the section from
--      `ACCOUNTING_SECTION_KEYS` — generation stops, existing drafts remain
--      ordinary manual-journal drafts;
--   2. drop the five tables below in reverse dependency order
--      (`recurring_journal_occurrence_events`,
--      `recurring_journal_occurrences`,
--      `recurring_journal_template_versions`,
--      `recurring_journal_template_lines`,
--      `recurring_journal_templates`);
--   3. drop `journal_entry_draft_lines.party_id` only after confirming no
--      manual draft relies on it — dropping it discards that attribution,
--      while the posted entries keep their own `journal_lines.party_id`.
-- Nothing in `journal_entries`, `journal_lines` or `journal_entry_drafts` is
-- deleted or rewritten by this migration, so a rollback cannot change the
-- books.

-- ---------------------------------------------------------------------------
-- 1. A draft line may carry a party
-- ---------------------------------------------------------------------------
-- A recurring line's «طرف‌حساب» is part of the document the template describes.
-- The draft table predates journal party attribution, so without this column a
-- recurring rent template could name its landlord on the template screen and
-- silently lose that name on the way to the ledger. `journal_lines.party_id`
-- already exists; this closes the gap between drafting and approval.
ALTER TABLE journal_entry_draft_lines
    ADD COLUMN party_id uuid REFERENCES parties(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. Templates
-- ---------------------------------------------------------------------------
CREATE TABLE recurring_journal_templates (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id           uuid REFERENCES locations(id) ON DELETE SET NULL,
    name                  text NOT NULL,
    description           text,
    memo                  text NOT NULL,
    voucher_reference     text,
    frequency             text NOT NULL,
    month_end_policy      text NOT NULL DEFAULT 'clamp',
    start_date            date NOT NULL,
    end_date              date,
    status                text NOT NULL DEFAULT 'active',
    current_version       integer NOT NULL DEFAULT 1,
    next_occurrence_date  date,
    last_generated_date   date,
    owner_user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT recurring_journal_templates_name_length
        CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT recurring_journal_templates_memo_length
        CHECK (length(btrim(memo)) BETWEEN 1 AND 500),
    CONSTRAINT recurring_journal_templates_description_length
        CHECK (description IS NULL OR length(description) <= 1000),
    CONSTRAINT recurring_journal_templates_frequency
        CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
    CONSTRAINT recurring_journal_templates_month_end_policy
        CHECK (month_end_policy IN ('clamp', 'last_day', 'skip')),
    CONSTRAINT recurring_journal_templates_status
        CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
    CONSTRAINT recurring_journal_templates_dates_ordered
        CHECK (end_date IS NULL OR end_date >= start_date),
    CONSTRAINT recurring_journal_templates_version_positive
        CHECK (current_version >= 1)
);
CREATE INDEX idx_recurring_journal_templates_due
    ON recurring_journal_templates (business_id, status, next_occurrence_date);

-- ---------------------------------------------------------------------------
-- 3. Template lines (the frozen document)
-- ---------------------------------------------------------------------------
CREATE TABLE recurring_journal_template_lines (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id        uuid NOT NULL REFERENCES recurring_journal_templates(id) ON DELETE CASCADE,
    line_no            integer NOT NULL,
    account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    party_id           uuid REFERENCES parties(id) ON DELETE SET NULL,
    debit              bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit             bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
    description        text,
    cost_center_id     uuid REFERENCES accounting_dimension_values(id),
    profit_center_id   uuid REFERENCES accounting_dimension_values(id),
    department_id      uuid REFERENCES accounting_dimension_values(id),
    detail_dimension_id uuid REFERENCES accounting_dimension_values(id),
    CONSTRAINT recurring_journal_template_lines_debit_xor_credit
        CHECK ((debit = 0) <> (credit = 0)),
    CONSTRAINT recurring_journal_template_lines_description_length
        CHECK (description IS NULL OR length(description) <= 300),
    UNIQUE (template_id, line_no)
);
CREATE INDEX idx_recurring_journal_template_lines_template
    ON recurring_journal_template_lines (template_id, line_no);

-- ---------------------------------------------------------------------------
-- 4. Version history (prospective edits only)
-- ---------------------------------------------------------------------------
CREATE TABLE recurring_journal_template_versions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    template_id    uuid NOT NULL REFERENCES recurring_journal_templates(id) ON DELETE CASCADE,
    version        integer NOT NULL CHECK (version >= 1),
    change_kind    text NOT NULL CHECK (change_kind IN ('created', 'edited', 'status_changed')),
    snapshot       jsonb NOT NULL,
    actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
-- `version` is the document version an occurrence snapshots, not a unique
-- event id: a template can be paused, resumed and paused again all at version
-- 3, and each decision belongs in the history. Ordering is therefore by time,
-- and the content versions are 1..N from the edit path.
CREATE INDEX idx_recurring_journal_template_versions_template
    ON recurring_journal_template_versions (template_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Occurrences
-- ---------------------------------------------------------------------------
CREATE TABLE recurring_journal_occurrences (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    template_id       uuid NOT NULL REFERENCES recurring_journal_templates(id) ON DELETE CASCADE,
    template_version  integer NOT NULL CHECK (template_version >= 1),
    scheduled_date    date NOT NULL,
    status            text NOT NULL DEFAULT 'pending',
    idempotency_key   text NOT NULL,
    memo              text NOT NULL,
    location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
    lines_snapshot    jsonb NOT NULL,
    draft_id          uuid REFERENCES journal_entry_drafts(id) ON DELETE SET NULL,
    entry_id          uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    attempt_count     integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error        text,
    held_reason       text,
    generated_at      timestamptz,
    posted_at         timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT recurring_journal_occurrences_status
        CHECK (status IN ('pending', 'draft', 'posted', 'skipped', 'failed')),
    CONSTRAINT recurring_journal_occurrences_idempotency_key_length
        CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    CONSTRAINT recurring_journal_occurrences_once_per_date
        UNIQUE (template_id, scheduled_date),
    CONSTRAINT recurring_journal_occurrences_idempotency
        UNIQUE (business_id, idempotency_key)
);
CREATE INDEX idx_recurring_journal_occurrences_register
    ON recurring_journal_occurrences (business_id, scheduled_date DESC);
CREATE INDEX idx_recurring_journal_occurrences_open
    ON recurring_journal_occurrences (business_id, status, scheduled_date)
    WHERE status IN ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- 6. Audit / observability
-- ---------------------------------------------------------------------------
-- Every template change and every generation decision is a row here, written in
-- the same transaction as the change it describes. A failed occurrence is not
-- just a status: `detail` carries the code the human needs (a locked period, an
-- archived account) so the register can say *why* it is held.
CREATE TABLE recurring_journal_occurrence_events (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    template_id    uuid REFERENCES recurring_journal_templates(id) ON DELETE CASCADE,
    occurrence_id  uuid REFERENCES recurring_journal_occurrences(id) ON DELETE SET NULL,
    action         text NOT NULL,
    actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    detail         jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_recurring_journal_occurrence_events_template
    ON recurring_journal_occurrence_events (template_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 7. Tenant isolation
-- ---------------------------------------------------------------------------
ALTER TABLE recurring_journal_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_journal_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recurring_journal_templates FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Lines carry no business_id of their own; their policy joins through their
-- template, exactly like journal_entry_draft_lines joins through its draft.
ALTER TABLE recurring_journal_template_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_journal_template_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recurring_journal_template_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM recurring_journal_templates t
         WHERE t.id = recurring_journal_template_lines.template_id
           AND t.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM recurring_journal_templates t
         WHERE t.id = recurring_journal_template_lines.template_id
           AND t.business_id = app_current_business()));

ALTER TABLE recurring_journal_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_journal_template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recurring_journal_template_versions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE recurring_journal_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_journal_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recurring_journal_occurrences FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE recurring_journal_occurrence_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_journal_occurrence_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recurring_journal_occurrence_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
