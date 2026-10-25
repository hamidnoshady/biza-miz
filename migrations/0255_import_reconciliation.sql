-- ============================================================================
-- 0255_import_reconciliation.sql — issue #1118: universal safe import &
-- first-sync reconciliation.
--
-- ## What this is
--
-- The shared, provider-agnostic persistence for "match / link / review BEFORE
-- mutation". Any source — a CSV/XLSX file, Holoo, WooCommerce, a WordPress
-- plugin handshake, a future ERP — stages what it brings into a RUN, the engine
-- (src/lib/import-reconciliation) gives every record a verdict, an owner
-- decides the ambiguous ones, and only then are canonical rows written. It
-- extends the Data Transfer engine (#845) and `integration_mappings`; it does
-- not replace either, and it is not a Holoo or WooCommerce merge engine.
--
-- ## The four tables
--
--   1. `import_reconciliation_runs`      — one staged import/connection setup:
--                                          source, scope, mode, fingerprints,
--                                          immutable source evidence, status.
--   2. `import_reconciliation_items`     — one staged record: the incoming
--                                          snapshot, the engine's verdict, the
--                                          evidence, the field-level diff and
--                                          where it stands (proposed → approved
--                                          → applied).
--   3. `import_reconciliation_decisions` — append-only: who decided what, why,
--                                          on what evidence. UPDATE is refused.
--   4. `source_identities`               — verified "source X's record Y is
--                                          canonical row Z" links for sources
--                                          that have no `integration_mappings`
--                                          connection (a file, an API feed).
--                                          Many sources may link to one canonical
--                                          row; an identity is never silently
--                                          re-pointed and is retired by tombstone,
--                                          never deleted.
--
-- ## Rules the schema carries
--
--   * Every table is business-scoped with FORCE RLS and the standard
--     `tenant_isolation` policy in this same file.
--   * One ACTIVE run per (business, domain, source, branch): the partial unique
--     index is what stops a manual sync, a webhook backfill and a re-upload
--     racing each other on the same scope.
--   * A run's source evidence and fingerprint are immutable once written.
--   * A staged record is unique per (run, entity type, external key), so
--     re-sending a batch (a retry, a reconnect) converges instead of doubling.
--   * Nothing here touches a canonical table: staging a preview writes only
--     these four.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Runs
-- ---------------------------------------------------------------------------
CREATE TABLE import_reconciliation_runs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The branch a branch-scoped domain (products) writes into; NULL for a
    -- business-scoped one (parties).
    location_id        uuid REFERENCES locations(id) ON DELETE SET NULL,
    domain             text NOT NULL
        CHECK (domain IN ('product', 'party', 'financial_document', 'inventory')),
    source_kind        text NOT NULL
        CHECK (source_kind IN ('file', 'provider', 'plugin', 'api', 'database', 'scheduled')),
    -- 'holoo', 'woocommerce', 'csv', … — a label for people and reports.
    provider           text NOT NULL DEFAULT '',
    -- The identity scope of the source: a connection id, or the operator's
    -- name for a file source. Source identities are keyed by it.
    source_key         text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 200),
    -- Present when the source is a configured integration connection.
    connection_id      uuid,
    import_mode        text NOT NULL
        CHECK (import_mode IN ('preview_only', 'one_time', 'backfill', 'live_link')),
    status             text NOT NULL DEFAULT 'discovering'
        CHECK (status IN ('discovering', 'staged', 'in_review', 'applying', 'applied',
                          'partially_applied', 'failed', 'cancelled', 'stale')),
    -- File hash / schema+profile version / cursor high-water mark: what the
    -- preview was built from. A different value later means the preview is stale.
    source_fingerprint text NOT NULL,
    profile_key        text,
    profile_version    integer,
    -- Version of the field-authority policy the verdicts were computed under.
    policy_version     integer NOT NULL DEFAULT 1,
    -- Digest of the canonical state the matches were computed against.
    canonical_token    text,
    scope              jsonb NOT NULL DEFAULT '{}'::jsonb,
    cursor             jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- File name/size/hash, provider build, … — immutable once written.
    evidence           jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- True once the post-apply cross-check of counts/identities/totals passed.
    cross_checked      boolean NOT NULL DEFAULT false,
    created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by_name    text NOT NULL DEFAULT '',
    created_at         timestamptz NOT NULL DEFAULT now(),
    staged_at          timestamptz,
    applied_at         timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, business_id),
    CONSTRAINT import_reconciliation_runs_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE SET NULL (connection_id)
);

CREATE UNIQUE INDEX uq_import_reconciliation_runs_active
    ON import_reconciliation_runs (
        business_id, domain, source_key,
        COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE status IN ('discovering', 'staged', 'in_review', 'applying', 'stale');
CREATE INDEX idx_import_reconciliation_runs_business_time
    ON import_reconciliation_runs (business_id, created_at DESC);

CREATE FUNCTION import_reconciliation_run_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.domain IS DISTINCT FROM OLD.domain
       OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
       OR NEW.source_key IS DISTINCT FROM OLD.source_key
       OR NEW.import_mode IS DISTINCT FROM OLD.import_mode
       OR NEW.evidence IS DISTINCT FROM OLD.evidence
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'import_reconciliation_run_immutable'
            USING ERRCODE = '23514';
    END IF;
    -- A finished run is history: only the bookkeeping flag may still change.
    IF OLD.status IN ('applied', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'import_reconciliation_run_closed'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_import_reconciliation_run_guard
    BEFORE UPDATE ON import_reconciliation_runs
    FOR EACH ROW EXECUTE FUNCTION import_reconciliation_run_guard();

ALTER TABLE import_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_reconciliation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_reconciliation_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. Items — one staged record
-- ---------------------------------------------------------------------------
CREATE TABLE import_reconciliation_items (
    id               bigserial PRIMARY KEY,
    business_id      uuid NOT NULL,
    run_id           uuid NOT NULL,
    -- Entity type within the domain: 'product', 'invoice', 'snapshot', …
    external_type    text NOT NULL,
    -- The source's id, or 'row:<n>' for a file row without an id column.
    external_key     text NOT NULL,
    row_number       integer,
    -- Hash of the incoming record. Re-sending an identical record is a no-op;
    -- a changed one re-resolves and returns the item to review.
    fingerprint      text NOT NULL,
    -- The incoming record exactly as received.
    snapshot         jsonb NOT NULL,
    outcome          text NOT NULL
        CHECK (outcome IN ('already_linked', 'safe_match', 'create_new', 'field_conflict',
                           'ambiguous', 'invalid', 'historical_match', 'skipped', 'failed')),
    reasons          text[] NOT NULL DEFAULT '{}',
    -- The canonical row the record is linked or matched to (one candidate).
    canonical_id     text,
    -- [{ id, label }] — everything a person may choose between.
    candidates       jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- [{ kind, value, weak }]
    evidence         jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- [{ field, fieldClass, canonical, incoming, action, needsReview }]
    conflicts        jsonb NOT NULL DEFAULT '[]'::jsonb,
    notes            text[] NOT NULL DEFAULT '{}',
    -- A past transaction: matched/reconciled, never auto-posted.
    historical       boolean NOT NULL DEFAULT false,
    -- Normalised keys the record could collide on, for cross-batch duplicate sweeps.
    identity_keys    text[] NOT NULL DEFAULT '{}',
    status           text NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'approved', 'held', 'skipped', 'applied', 'failed')),
    -- What applying does, once decided: none | link | create | skip.
    effect           text CHECK (effect IN ('none', 'link', 'create', 'skip')),
    -- The canonical row this item ended up linked to or created.
    resolved_canonical_id text,
    last_decision_id uuid,
    error            text,
    attempts         integer NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    applied_at       timestamptz,
    CONSTRAINT import_reconciliation_items_run_fk
        FOREIGN KEY (run_id, business_id)
        REFERENCES import_reconciliation_runs (id, business_id)
        ON DELETE CASCADE,
    UNIQUE (run_id, external_type, external_key)
);
CREATE INDEX idx_import_reconciliation_items_run_status
    ON import_reconciliation_items (run_id, status, outcome);
CREATE INDEX idx_import_reconciliation_items_identity_keys
    ON import_reconciliation_items USING gin (identity_keys);

ALTER TABLE import_reconciliation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_reconciliation_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_reconciliation_items FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. Decisions — append-only
-- ---------------------------------------------------------------------------
CREATE TABLE import_reconciliation_decisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL,
    run_id              uuid NOT NULL,
    item_id             bigint NOT NULL REFERENCES import_reconciliation_items(id) ON DELETE CASCADE,
    decision            text NOT NULL
        CHECK (decision IN ('link', 'create_separate', 'skip', 'choose_authority', 'keep_for_review')),
    -- The canonical row chosen for a link.
    canonical_id        text,
    -- { field: 'canonical' | 'source' } for a choose_authority decision.
    authority_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
    reason              text NOT NULL DEFAULT '',
    -- The evidence the approver saw when deciding.
    evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- True for a "approve all safe" batch decision.
    batch               boolean NOT NULL DEFAULT false,
    decided_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_by_name     text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT import_reconciliation_decisions_run_fk
        FOREIGN KEY (run_id, business_id)
        REFERENCES import_reconciliation_runs (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_import_reconciliation_decisions_item
    ON import_reconciliation_decisions (item_id, created_at);

CREATE FUNCTION import_reconciliation_decision_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'import_reconciliation_decision_append_only'
        USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER trg_import_reconciliation_decision_guard
    BEFORE UPDATE ON import_reconciliation_decisions
    FOR EACH ROW EXECUTE FUNCTION import_reconciliation_decision_guard();

ALTER TABLE import_reconciliation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_reconciliation_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_reconciliation_decisions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. Source identities
-- ---------------------------------------------------------------------------
--
-- "Source X's record Y is canonical row Z." Connection-backed sources keep
-- using `integration_mappings` (the services that read it are unchanged); this
-- table is the same idea for every other source — a file, an API feed — and
-- records the provenance integration_mappings never had.
CREATE TABLE source_identities (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    domain             text NOT NULL
        CHECK (domain IN ('product', 'party', 'financial_document', 'inventory')),
    source_key         text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 200),
    provider           text NOT NULL DEFAULT '',
    external_type      text NOT NULL,
    external_id        text NOT NULL,
    -- Which canonical table the row lives in ('items', 'menu_items', 'parties', …).
    canonical_type     text NOT NULL,
    canonical_id       text NOT NULL,
    verified           boolean NOT NULL DEFAULT true,
    created_by_run_id  uuid REFERENCES import_reconciliation_runs(id) ON DELETE SET NULL,
    linked_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    -- A tombstone: the identity is retired, never deleted, so history stays
    -- explainable and an out-of-order event cannot resurrect it.
    retired_at         timestamptz,
    retired_reason     text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
-- One live identity per source record; any number of sources per canonical row.
CREATE UNIQUE INDEX uq_source_identities_live
    ON source_identities (business_id, source_key, domain, external_type, external_id)
    WHERE retired_at IS NULL;
CREATE INDEX idx_source_identities_canonical
    ON source_identities (business_id, canonical_type, canonical_id);

-- Re-pointing a verified identity needs an explicit, audited decision: the
-- service sets the transaction-local marker only for that path.
CREATE FUNCTION source_identity_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.canonical_id IS DISTINCT FROM OLD.canonical_id
        OR NEW.canonical_type IS DISTINCT FROM OLD.canonical_type)
       AND COALESCE(current_setting('app.source_identity_repoint', true), '') <> 'on' THEN
        RAISE EXCEPTION 'source_identity_repoint_requires_approval'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.source_key IS DISTINCT FROM OLD.source_key
       OR NEW.domain IS DISTINCT FROM OLD.domain
       OR NEW.external_type IS DISTINCT FROM OLD.external_type
       OR NEW.external_id IS DISTINCT FROM OLD.external_id THEN
        RAISE EXCEPTION 'source_identity_key_immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_source_identity_guard
    BEFORE UPDATE ON source_identities
    FOR EACH ROW EXECUTE FUNCTION source_identity_guard();

ALTER TABLE source_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON source_identities FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
