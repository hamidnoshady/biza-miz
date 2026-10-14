-- ============================================================================
-- 0203_ai_control_plane.sql — issue #812, Phases 2–5.
--
-- The Superadmin AI control plane and the tenant-isolated knowledge/memory/
-- research model that replace the application-owned semantic cache and the
-- application-owned pgvector RAG stack.
--
-- What this migration creates
--   1. `platform_ai_modes`        — Auto / Instant / Deep Research each resolve
--                                   their own configurable LiteLLM model alias.
--                                   Routing/fallback/cost stay in LiteLLM; the
--                                   app only chooses WHICH alias to ask for.
--   2. `ai_prompt_versions`       — the ONE live prompt store: base, mode,
--                                   agent, business-type and app scopes, each
--                                   draft → published → retired. A draft never
--                                   affects a live turn.
--   3. `ai_system_agents`         — Superadmin-built, versioned system agents.
--                                   Tenants cannot create or edit these.
--   4. `ai_agent_assignments`     — Superadmin assigns agents to tenants
--                                   (and business types) as suggestion cards.
--   5. `ai_memory`                — layered durable memory:
--                                   platform → tenant → app → project.
--   6. `ai_research_runs`         — Deep Research run/environment records.
--   7. `ai_research_sources`      — grounded evidence behind a research result.
--   8. managed-knowledge columns on `platform_ai_gateway` — the configured
--      LiteLLM/AI-infrastructure knowledge integration the app routes retrieval
--      through, carrying the tenant identity on every request.
--
-- What it deliberately does NOT do
--   - It does not recreate LiteLLM provider/model/budget/TPS/RPS management.
--   - It does not carry plans, credit packages or token tariffs: product
--     billing stays in Plans/Billing and joins the runtime through usage
--     settlement, not through this table.
--   - It does not drop `ai_answer_cache` / `ai_embeddings` here. Those are
--     dropped in migration 0204, after the code that read them is gone.
--
-- Every tenant-scoped table below gets RLS in the same migration, per the
-- repo's tenancy rule.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Runtime modes → LiteLLM model aliases
-- ----------------------------------------------------------------------------
-- Exactly three user-facing runtime modes. The retired "thinking/analytical"
-- product mode has no row here: it was a prompt directive, not a runtime, and
-- it is gone rather than migrated (issue #812 §7).
CREATE TABLE platform_ai_modes (
    mode_key            text PRIMARY KEY
                        CHECK (mode_key IN ('auto', 'instant', 'deep_research')),
    -- The LiteLLM model alias this mode asks for. Blank means "use the
    -- gateway's default chat model", which is what a deployment that has not
    -- configured aliases yet keeps doing.
    model_alias         text NOT NULL DEFAULT '',
    is_active           boolean NOT NULL DEFAULT true,
    -- Per-mode sampling/output caps. NULL inherits the gateway default.
    temperature         numeric(3, 2),
    max_output_tokens   integer,
    -- The `ai_prompt_versions.scope_key` whose PUBLISHED row shapes this mode.
    prompt_scope_key    text NOT NULL DEFAULT '',
    updated_by          text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_ai_modes IS
    'Issue #812 §7 — the three user-facing AI runtime modes and the LiteLLM alias each resolves. '
    'Alias is a routing hint only: model/provider deployment, fallbacks, retries and cost stay in LiteLLM.';

INSERT INTO platform_ai_modes (mode_key, model_alias, is_active, prompt_scope_key)
VALUES
    ('auto',          '', true, 'mode:auto'),
    ('instant',       '', true, 'mode:instant'),
    ('deep_research', '', false, 'mode:deep_research')
ON CONFLICT (mode_key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. One live prompt store
-- ----------------------------------------------------------------------------
-- Replaces the split architecture: the monolithic `buildSystemPrompt` and the
-- fragment engine are both retired in favour of ONE resolver whose overrides
-- live here. `state` is the safety property — a draft row is invisible to the
-- runtime until it is published, and an unknown/missing scope falls back to the
-- code default, never to an empty prompt.
CREATE TABLE ai_prompt_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 'base' | 'mode:<auto|instant|deep_research>' | 'agent:<agent_key>' |
    -- 'business_type:<key>' | 'app:<app_key>'
    scope_key       text NOT NULL,
    version         integer NOT NULL DEFAULT 1,
    text            text NOT NULL CHECK (btrim(text) <> ''),
    state           text NOT NULL DEFAULT 'draft'
                    CHECK (state IN ('draft', 'published', 'retired')),
    notes           text NOT NULL DEFAULT '',
    created_by      text NOT NULL DEFAULT '',
    published_by    text,
    published_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One published version per scope. This is what makes "a draft must not affect
-- production" a database invariant rather than a convention.
CREATE UNIQUE INDEX ai_prompt_versions_published
    ON ai_prompt_versions (scope_key)
    WHERE state = 'published';

CREATE INDEX ai_prompt_versions_scope_version
    ON ai_prompt_versions (scope_key, version DESC);

-- ----------------------------------------------------------------------------
-- 3. System agents (Superadmin-built and versioned)
-- ----------------------------------------------------------------------------
-- The word "Agent" now means exactly one thing: a system-wide specialist built
-- and versioned by a platform admin. There is no tenant-side agent builder.
--
-- The security invariant (issue #812 §5) is structural: every allowlist here
-- can only NARROW. The runtime intersects
--     platform tool catalogue
--   ∩ agent allowlist
--   ∩ current tenant/app availability
--   ∩ current user's effective permissions
--   ∩ current location/project scope
-- and an unknown tool/action id fails closed. Nothing in this table can widen
-- a member's reach, because the member's own permission set is the last term.
CREATE TABLE ai_system_agents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Stable, human-writable key. URLs, assignments and research runs name
    -- this rather than the uuid, so a re-created agent cannot inherit history.
    agent_key           text NOT NULL UNIQUE,
    name                text NOT NULL CHECK (btrim(name) <> ''),
    description         text NOT NULL DEFAULT '',
    -- Visual metadata only; never interpreted.
    icon                text NOT NULL DEFAULT '',
    instructions        text NOT NULL DEFAULT '',
    state               text NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft', 'published', 'retired')),
    version             integer NOT NULL DEFAULT 1,

    -- Targeting
    relevant_apps       text[] NOT NULL DEFAULT '{}',
    business_types      text[] NOT NULL DEFAULT '{}',
    required_features   text[] NOT NULL DEFAULT '{}',
    -- Permission keys the invoking member must already hold. An empty array
    -- means "no additional requirement", never "no requirement at all": the
    -- member's own effective set still gates every tool.
    required_permissions text[] NOT NULL DEFAULT '{}',

    -- Capability allowlists (narrowing only)
    allowed_tools       text[] NOT NULL DEFAULT '{}',
    allowed_actions     text[] NOT NULL DEFAULT '{}',
    allowed_modes       text[] NOT NULL DEFAULT ARRAY['auto']::text[],
    default_mode        text,

    -- Suggestion cards: [{ id, prompt, appFocus?, requiredPermissions?,
    --                      requiredApps?, requiredFeatures?, preferredMode? }]
    suggestion_cards    jsonb NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(suggestion_cards) = 'array'),

    -- Memory scopes this agent may read: platform | tenant | app | project.
    memory_scopes       text[] NOT NULL DEFAULT ARRAY['tenant']::text[],

    -- Free-form policy metadata the resolver renders, e.g.
    -- { "requireConfirmationForWrites": true, "maxToolRounds": 6 }
    confirmation_policy jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(confirmation_policy) = 'object'),

    created_by          text NOT NULL DEFAULT '',
    updated_by          text NOT NULL DEFAULT '',
    published_by        text,
    published_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_system_agents_state ON ai_system_agents (state, updated_at DESC);

-- ----------------------------------------------------------------------------
-- 4. Agent → tenant assignments through suggestion cards
-- ----------------------------------------------------------------------------
-- A tenant never picks an agent. A platform admin decides which businesses see
-- which suggestion card, and the card carries the starter prompt, the app
-- focus it opens in, and the permissions/apps/features it requires.
--
-- `business_id IS NULL` + a `business_type` means "every business of this type".
-- `business_id` set means that one business. Both null is refused by the CHECK.
CREATE TABLE ai_agent_assignments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id            uuid NOT NULL REFERENCES ai_system_agents(id) ON DELETE CASCADE,
    business_id         uuid REFERENCES businesses(id) ON DELETE CASCADE,
    business_type       text,
    -- The starter prompt the tenant actually sees.
    prompt              text NOT NULL CHECK (btrim(prompt) <> ''),
    app_focus           text NOT NULL DEFAULT 'all',
    required_permissions text[] NOT NULL DEFAULT '{}',
    required_apps       text[] NOT NULL DEFAULT '{}',
    required_features   text[] NOT NULL DEFAULT '{}',
    preferred_mode      text,
    enabled             boolean NOT NULL DEFAULT true,
    created_by          text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ai_agent_assignments_target_check
        CHECK (business_id IS NOT NULL OR business_type IS NOT NULL)
);

CREATE INDEX ai_agent_assignments_agent ON ai_agent_assignments (agent_id);
CREATE INDEX ai_agent_assignments_business ON ai_agent_assignments (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX ai_agent_assignments_type ON ai_agent_assignments (business_type) WHERE business_type IS NOT NULL;

ALTER TABLE ai_agent_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_agent_assignments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ----------------------------------------------------------------------------
-- 5. Layered durable memory
-- ----------------------------------------------------------------------------
-- Platform → tenant → app → project. Memory is a PRODUCT feature, not RAG
-- infrastructure: it is managed, audited, scoped and deletable, and it can
-- inform an answer but can never override platform security/tool policy.
--
-- Platform rows have `business_id IS NULL` (no tenant data at all). Every other
-- scope is tenant-scoped, and a project row additionally names its project, so
-- the project's own access rules decide who may see it.
CREATE TABLE ai_memory (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid REFERENCES businesses(id) ON DELETE CASCADE,
    scope           text NOT NULL CHECK (scope IN ('platform', 'tenant', 'app', 'project')),
    -- Set for scope = 'app'; one of the four registry keys.
    app_key         text,
    -- Set for scope = 'project'; the project this memory belongs to.
    project_id      uuid,
    content         text NOT NULL CHECK (btrim(content) <> ''),
    -- Where the entry came from: 'user', 'ai', 'platform_admin', 'backfill'.
    source          text NOT NULL DEFAULT 'user',
    created_by      text,
    -- Soft delete. A deleted memory must stop influencing future turns, and a
    -- hard delete would erase the audit trail that says it once existed.
    deleted_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ai_memory_scope_shape CHECK (
        (scope = 'platform' AND business_id IS NULL AND app_key IS NULL AND project_id IS NULL)
        OR (scope = 'tenant'   AND business_id IS NOT NULL AND app_key IS NULL AND project_id IS NULL)
        OR (scope = 'app'      AND business_id IS NOT NULL AND app_key IS NOT NULL AND project_id IS NULL)
        OR (scope = 'project'  AND business_id IS NOT NULL AND project_id IS NOT NULL)
    )
);

CREATE INDEX ai_memory_tenant_scope ON ai_memory (business_id, scope, updated_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX ai_memory_app ON ai_memory (business_id, app_key) WHERE deleted_at IS NULL;
CREATE INDEX ai_memory_project ON ai_memory (project_id) WHERE deleted_at IS NULL;
CREATE INDEX ai_memory_platform ON ai_memory (scope) WHERE scope = 'platform' AND deleted_at IS NULL;

ALTER TABLE ai_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_memory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_memory FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ----------------------------------------------------------------------------
-- 6. Deep Research runs
-- ----------------------------------------------------------------------------
-- Deep Research is a separate, cost-approved, isolated workflow — never a
-- normal chat turn with a stronger prompt. The run record IS the environment:
-- it carries the question, the tenant/branch/app/project scope, the knowledge
-- namespace, the prompt version, the agent, the model alias, the estimated
-- maximum cost and the actual cost, and it expires.
CREATE TABLE ai_research_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id             text,
    location_id         uuid,
    app_key             text,
    project_id          uuid,
    question            text NOT NULL CHECK (btrim(question) <> ''),
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'running', 'completed',
                                          'failed', 'cancelled', 'expired')),
    -- The knowledge namespace retrieval is confined to. Always derived from
    -- this run's business id; never supplied by the caller or the model.
    knowledge_namespace text NOT NULL,
    prompt_version      integer,
    agent_id            uuid REFERENCES ai_system_agents(id) ON DELETE SET NULL,
    model_alias         text NOT NULL DEFAULT '',
    -- The maximum the member explicitly approved before the environment opened.
    estimated_max_cost_rial integer NOT NULL DEFAULT 0,
    -- What it actually cost. Settled once, idempotently, by request id.
    actual_cost_rial    integer NOT NULL DEFAULT 0,
    request_id          text,
    result              text,
    error               text,
    expires_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz
);

CREATE INDEX ai_research_runs_business ON ai_research_runs (business_id, created_at DESC);
CREATE INDEX ai_research_runs_status ON ai_research_runs (status, expires_at);

ALTER TABLE ai_research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_research_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_research_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Grounded evidence. Persisted with the run so a result stays checkable after
-- the temporary environment has expired.
CREATE TABLE ai_research_sources (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          uuid NOT NULL REFERENCES ai_research_runs(id) ON DELETE CASCADE,
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    source_type     text NOT NULL DEFAULT '',
    source_ref      text NOT NULL DEFAULT '',
    title           text NOT NULL DEFAULT '',
    excerpt         text NOT NULL DEFAULT '',
    similarity      numeric(6, 5),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_research_sources_run ON ai_research_sources (run_id);

ALTER TABLE ai_research_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_research_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_research_sources FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ----------------------------------------------------------------------------
-- 8. Managed knowledge + Deep Research settings on the gateway singleton
-- ----------------------------------------------------------------------------
-- The app no longer owns embeddings, a vector table or a similarity search. It
-- asks the configured AI infrastructure for knowledge, and it names the tenant
-- on every request so the gateway can only ever answer inside that namespace.
ALTER TABLE platform_ai_gateway
    ADD COLUMN IF NOT EXISTS knowledge_enabled      boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS knowledge_base_url     text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS knowledge_api_key      text,
    ADD COLUMN IF NOT EXISTS knowledge_api_key_ciphertext text,
    ADD COLUMN IF NOT EXISTS knowledge_model        text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS knowledge_max_results  integer NOT NULL DEFAULT 8,
    ADD COLUMN IF NOT EXISTS research_enabled       boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS research_model_alias   text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS research_max_rounds    integer NOT NULL DEFAULT 12,
    ADD COLUMN IF NOT EXISTS research_max_context_bytes integer NOT NULL DEFAULT 2000000,
    ADD COLUMN IF NOT EXISTS research_ttl_hours     integer NOT NULL DEFAULT 24,
    ADD COLUMN IF NOT EXISTS research_max_spend_rial integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS research_external_web  boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS research_min_data_readiness integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN platform_ai_gateway.knowledge_base_url IS
    'Issue #812 §2 — the configured LiteLLM/AI-infrastructure knowledge endpoint. '
    'The app holds no vector table of its own; it sends the tenant identity with every request.';
COMMENT ON COLUMN platform_ai_gateway.research_max_spend_rial IS
    'Issue #812 §9 — per-run spend cap in Rial. 0 means "no cap configured"; the '
    'estimate shown to the member is still required before a run may start.';
