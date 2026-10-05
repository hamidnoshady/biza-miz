-- CRM automations — «وقتی → اگر → آنگاه».
--
-- ## What this migration adds, and what it deliberately does not
--
-- Two tables:
--
--   crm_automations      the rules a business writes: a trigger, the conditions
--                        that narrow it, and one action.
--   crm_automation_runs  an append-only record of every time a rule was
--                        considered — applied, skipped, failed, or used to
--                        signal Growth.
--
-- The vocabularies that keep this honest (which triggers exist, which conditions
-- may narrow each one, which actions exist) are **code**, in
-- `src/lib/crm-automation-rules.ts`, not rows: the same rule the smart queues
-- follow. A business composes the rules the product has; it cannot invent a new
-- trigger, and nothing a member types ever reaches SQL.
--
-- ## Why the runs table is separate, and why it keeps the name
--
-- A run is evidence of what the CRM did on its own. It is written by the engine
-- and never edited: `automation_name` is denormalised so that deleting a rule
-- does not rewrite its own history, and the foreign key is `ON DELETE SET NULL`
-- for the same reason. A log that disappears with the thing it describes is not
-- a log.
--
-- ## The boundary this migration is not crossing
--
-- Nothing here sends anything. There is no channel, no template and no
-- recipient: an automation may create a CRM task, assign a CRM row, or *signal*
-- Growth (`notify_growth`) that a customer's state changed. Growth owns
-- campaigns, consent-checked sends and the outbox, and the CRM has no code path
-- that writes those tables — `crm-app-boundaries.test.ts` enforces that.
--
-- Tenant data, so RLS'd like every other per-business table.

CREATE TABLE IF NOT EXISTS crm_automations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name         text NOT NULL,
    -- A key from `CRM_AUTOMATION_TRIGGERS`; validated in the service too, so a
    -- direct insert is the only way past this comment.
    trigger_key  text NOT NULL,
    -- A list of `{key, value}` narrowed by `CRM_AUTOMATION_CONDITIONS`, stored
    -- as a document because the shape depends on the condition's own type.
    conditions   jsonb NOT NULL DEFAULT '[]'::jsonb,
    action_key   text NOT NULL,
    -- `{memberId}`, `{offsetDays}`, `{reason}` — again depending on the action.
    action_config jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active    boolean NOT NULL DEFAULT true,
    created_by   text NOT NULL DEFAULT '',
    run_count    integer NOT NULL DEFAULT 0,
    last_run_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The engine's read is always "the active rules for this trigger, in this
-- business" — on the write path of a deal, a ticket or a lead, so it has to be
-- an index lookup and nothing more.
CREATE INDEX IF NOT EXISTS crm_automations_trigger_idx
    ON crm_automations (business_id, trigger_key)
    WHERE is_active;

CREATE TABLE IF NOT EXISTS crm_automation_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    automation_id   uuid REFERENCES crm_automations(id) ON DELETE SET NULL,
    -- The rule's name at the time it ran. Denormalised on purpose: the history
    -- has to survive a rename and a delete.
    automation_name text NOT NULL,
    trigger_key     text NOT NULL,
    entity_type     text NOT NULL,
    entity_id       uuid,
    -- applied | skipped | failed | triggered_growth
    outcome         text NOT NULL,
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
    at              timestamptz NOT NULL DEFAULT now()
);

-- The settings screen reads the newest runs per business; the audit screen
-- filters by entity.
CREATE INDEX IF NOT EXISTS crm_automation_runs_business_idx
    ON crm_automation_runs (business_id, at DESC);
CREATE INDEX IF NOT EXISTS crm_automation_runs_entity_idx
    ON crm_automation_runs (business_id, entity_type, entity_id);

ALTER TABLE crm_automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_automations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON crm_automations;
CREATE POLICY tenant_isolation ON crm_automations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_automation_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON crm_automation_runs;
CREATE POLICY tenant_isolation ON crm_automation_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- A run is evidence: the app never updates or deletes one, and
-- `crm-automation-service.ts` has no code path that does. Like the CRM's audit
-- log — and unlike the consent register, which is a legal record — that is kept
-- by the write path rather than by a database trigger, so a business deletion
-- still cascades instead of being blocked by its own history.
