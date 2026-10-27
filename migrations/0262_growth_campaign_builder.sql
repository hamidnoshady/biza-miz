-- Issue #901, first slice — the campaign builder's data model.
--
-- A *campaign* is the stable identity a business sees in a list; a *version* is
-- the typed rule document that campaign runs under. Money-affecting rules are
-- never edited in place once they have been put in front of an approver: the
-- version is locked (`locked_at`) and a change is a new version, so what was
-- approved, what ran and what a later report attributes a reward to are the
-- same bytes. This slice only writes drafts — approval, launch and the reward
-- ledger arrive with the next slices — but the lock is a database guarantee
-- from the start, so no later code path can forget it.
--
-- This is deliberately NOT the `promotions` or `message_campaigns` tables: those
-- stay the execution primitives for price rules and outbound messages and are
-- not migrated or duplicated here. Nothing in this migration posts to the
-- ledger or creates a liability.
--
-- `definition` is validated by `src/lib/campaign-builder.ts` before it is
-- stored; the database holds only the shape guarantees it can state cheaply
-- (an object, a lowercase sha-256 hash, a positive version number).

CREATE TABLE growth_campaigns (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'pending_approval', 'approved', 'live', 'paused', 'completed', 'archived')),
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
    UNIQUE (business_id, id)
);

CREATE INDEX idx_growth_campaigns_business ON growth_campaigns (business_id, status, created_at DESC);

CREATE TABLE growth_campaign_versions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    campaign_id      uuid NOT NULL,
    version_number   integer NOT NULL CHECK (version_number > 0),
    schema_version   integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    definition       jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    definition_hash  text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    locked_at        timestamptz,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, version_number),
    -- Ties the version to the same business as its campaign, so a version can
    -- never be filed under another tenant's campaign id.
    FOREIGN KEY (business_id, campaign_id) REFERENCES growth_campaigns (business_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_growth_campaign_versions_campaign ON growth_campaign_versions (campaign_id, version_number DESC);

-- A locked version is immutable: its rules, its hash and its number cannot be
-- rewritten, and it cannot be deleted on its own (it goes only with its
-- campaign or business: both foreign keys cascade, and by then the parent row
-- is already gone, which is how the guard tells a cascade from a direct delete).
CREATE OR REPLACE FUNCTION growth_campaign_version_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.locked_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM growth_campaigns c WHERE c.id = OLD.campaign_id)
           AND EXISTS (SELECT 1 FROM businesses b WHERE b.id = OLD.business_id) THEN
            RAISE EXCEPTION 'growth_campaign_version_locked' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.locked_at IS NOT NULL THEN
        -- Once locked, nothing about the rules may change; the lock itself is
        -- one-way.
        IF NEW.definition IS DISTINCT FROM OLD.definition
           OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
           OR NEW.version_number IS DISTINCT FROM OLD.version_number
           OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
           OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
           OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
            RAISE EXCEPTION 'growth_campaign_version_locked' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_growth_campaign_version_guard
    BEFORE UPDATE OR DELETE ON growth_campaign_versions
    FOR EACH ROW EXECUTE FUNCTION growth_campaign_version_guard();

ALTER TABLE growth_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON growth_campaigns FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE growth_campaign_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_campaign_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON growth_campaign_versions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
