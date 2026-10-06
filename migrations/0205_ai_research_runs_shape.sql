-- ============================================================================
-- Issue #812 §5 — Deep Research run/environment shape, reconciled.
--
-- Migration 0203 created `ai_research_runs` / `ai_research_sources` while the
-- workflow's exact vocabulary was still settling. 0203 is already applied on
-- existing deployments, so this migration REPLACES those two tables with the
-- shape the workflow in `src/lib/ai-research.ts` actually uses.
--
-- A drop-and-recreate is safe here and is the honest choice: both tables were
-- introduced in the same issue, nothing writes them outside that module, and
-- editing 0203 in place would leave every already-migrated deployment with the
-- old columns forever. `ai_research_sources` goes first because it references
-- `ai_research_runs`.
--
-- The differences from 0203's draft, and why:
--   - `status` gains `spend_cap_reached` and `awaiting_approval`, and loses
--     `approved`/`completed`: a run moves `awaiting_approval → running →`
--     one of {succeeded, failed, cancelled, expired, spend_cap_reached}. The
--     cap outcome is a first-class state, not a note on a "completed" run,
--     because §5 requires the spend cap to be visible and enforceable.
--   - `environment_id` — every run gets its own isolated environment (§5).
--   - `max_rounds` / `rounds_used` / `max_context_chars` / `spend_cap_usd` —
--     the Superadmin-controlled caps (§6) and the loop's own bookkeeping.
--   - `knowledge_enabled` / `web_enabled` — the run's own evidence policy,
--     separate from the platform-wide gateway setting.
--   - `findings` / `sources` / `answer` — the grounded result. `findings` is
--     persisted as JSONB so a result stays checkable after the environment has
--     expired; `sources` also lands in `ai_research_sources` for querying.
--   - `prompt_tokens` / `completion_tokens` / `started_at` — settlement and
--     attribution (§21).
--   - `user_id` is `text` (not `uuid`) because the assistant's own identity in
--     this schema is the platform user's text id, which is not always a UUID.
--   - Costs are USD, matching what the gateway reports and what
--     `settleAiTurn` consumes; the Rial charge is settled separately in the
--     wallet, never stored twice here.
-- ============================================================================

DROP TABLE IF EXISTS ai_research_sources;
DROP TABLE IF EXISTS ai_research_runs;

CREATE TABLE ai_research_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id             text,
    location_id         uuid,
    app_key             text,
    project_id          uuid,
    question            text NOT NULL CHECK (btrim(question) <> ''),
    status              text NOT NULL DEFAULT 'awaiting_approval'
                        CHECK (status IN ('awaiting_approval', 'running', 'succeeded', 'failed',
                                          'cancelled', 'expired', 'spend_cap_reached')),
    -- §5 — the run's own isolated environment. Never reused, never shared
    -- with a chat turn, and it expires.
    environment_id      text NOT NULL,
    -- The prompt version this run was created under (§8). Recorded so a result
    -- stays attributable after the platform republishes the prompt.
    prompt_version      text,
    system_agent_id     uuid REFERENCES ai_system_agents(id) ON DELETE SET NULL,
    model_alias         text NOT NULL DEFAULT '',
    max_rounds          integer NOT NULL DEFAULT 4,
    rounds_used         integer NOT NULL DEFAULT 0,
    max_context_chars   integer NOT NULL DEFAULT 60000,
    -- The maximum the member explicitly approved before the environment
    -- opened. Server-computed from the caps above, never client-supplied.
    estimated_max_cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
    -- The cap the loop enforces after every round.
    spend_cap_usd       numeric(12, 6) NOT NULL DEFAULT 1,
    -- What it actually cost. Settled once, idempotently, by request id.
    actual_cost_usd     numeric(12, 6) NOT NULL DEFAULT 0,
    request_id          text,
    knowledge_enabled   boolean NOT NULL DEFAULT true,
    web_enabled         boolean NOT NULL DEFAULT false,
    findings            jsonb NOT NULL DEFAULT '[]'::jsonb,
    sources             jsonb NOT NULL DEFAULT '[]'::jsonb,
    answer              text,
    error               text,
    prompt_tokens       integer NOT NULL DEFAULT 0,
    completion_tokens   integer NOT NULL DEFAULT 0,
    started_at          timestamptz,
    finished_at         timestamptz,
    expires_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_research_runs_business ON ai_research_runs (business_id, created_at DESC);
CREATE INDEX ai_research_runs_status ON ai_research_runs (status, expires_at);
CREATE INDEX ai_research_runs_env ON ai_research_runs (environment_id);

ALTER TABLE ai_research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_research_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_research_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Grounded evidence. Persisted with the run so a result stays checkable after
-- the temporary environment has expired. `(run_id, ref)` is unique so a
-- repeated round updates the same row instead of duplicating it.
CREATE TABLE ai_research_sources (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          uuid NOT NULL REFERENCES ai_research_runs(id) ON DELETE CASCADE,
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind            text NOT NULL DEFAULT '',
    ref             text NOT NULL DEFAULT '',
    title           text NOT NULL DEFAULT '',
    record_count    integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ai_research_sources_unique_ref UNIQUE (run_id, ref)
);

CREATE INDEX ai_research_sources_run ON ai_research_sources (run_id);

ALTER TABLE ai_research_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_research_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_research_sources FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
