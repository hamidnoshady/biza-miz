-- Issue #1590 / ESH-233 (consolidates retired #1012): ready-to-run playbooks.
--
-- `playbook_instances`: one launched instance of a versioned playbook. The
-- catalog itself lives in typed code (repo convention, see migration 0262);
-- this table stores tenant launches. A published template change NEVER mutates
-- a launched instance: `template_version` + `schema_version` + `config` snapshot
-- are immutable history. Retries are safe: `UNIQUE (business_id, idempotency_key)`.
-- No second automation engine, no second customer/campaign/ledger table; this
-- references canonical CRM/Growth executor refs only.
--
-- `playbook_preferences`: per (business, member) UI preference; never widens
-- authorization. Tenant isolation by RLS in this same migration.

CREATE TABLE playbook_instances (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Branch/site scope; NULL = business-wide.
    branch_id         uuid REFERENCES locations(id) ON DELETE SET NULL,
    template_key      text NOT NULL CHECK (char_length(btrim(template_key)) BETWEEN 1 AND 120),
    template_version  text NOT NULL CHECK (char_length(btrim(template_version)) BETWEEN 1 AND 40),
    schema_version    integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    -- Immutable configuration snapshot at launch.
    config            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
    initiator_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    approver_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    executor_app      text NOT NULL CHECK (executor_app IN ('crm', 'growth')),
    -- Reference to the canonical executor output (activity ids, campaign id, segment id, saved view id...).
    executor_ref      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(executor_ref) = 'object'),
    idempotency_key   text NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
    status            text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','pending_approval','scheduled','running','paused','completed','failed','canceled')),
    scheduled_at      timestamptz,
    started_at        timestamptz,
    completed_at      timestamptz,
    last_error        text,
    retry_count       integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    -- Human-readable audit trail; append-only in code.
    audit             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(audit) = 'array'),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (business_id, idempotency_key)
);

CREATE INDEX idx_playbook_instances_business ON playbook_instances (business_id, status, created_at DESC);
CREATE INDEX idx_playbook_instances_template ON playbook_instances (business_id, template_key);

CREATE TABLE playbook_preferences (
    business_id          uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    density              text CHECK (density IN ('simple', 'advanced')),
    tools_view           text NOT NULL DEFAULT 'my_tools' CHECK (tools_view IN ('my_tools', 'all_tools')),
    pinned_tools         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pinned_tools) = 'array'),
    favorite_playbooks   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(favorite_playbooks) = 'array'),
    size_override        text CHECK (size_override IN ('solo', 'small', 'growing', 'organization')),
    goals_override       jsonb CHECK (goals_override IS NULL OR jsonb_typeof(goals_override) = 'array'),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, user_id)
);

ALTER TABLE playbook_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE playbook_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON playbook_instances FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE playbook_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE playbook_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON playbook_preferences FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
