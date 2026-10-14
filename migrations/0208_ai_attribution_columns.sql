-- Issue #812 §12 — per-turn and per-run attribution, as columns.
--
-- The settlement row already carried `request_type`, `model`, `conversation_id`,
-- `project_id`, `agent_id`, `location_id` and a `metadata` jsonb. That was
-- enough to answer "how much did chat cost". It cannot answer the questions
-- issue #812 asks the usage record to answer:
--
--   * which RUNTIME MODODE spent it — `auto`, `instant` or `deep_research`,
--     which resolve different LiteLLM aliases and therefore different prices;
--   * which SYSTEM AGENT was invoked, and through which assigned suggestion
--     card, so a Superadmin can see what the agents they built actually cost;
--   * which DEEP RESEARCH run it was, so a run's total is one query rather
--     than a scan of metadata.
--
-- These become columns rather than staying inside `metadata` because the usage
-- report groups and filters on them. A jsonb key can be read with `->>`, but it
-- cannot be indexed usefully, cannot be constrained, and — the part that
-- matters — a typo in a key is silently a NULL group forever.
--
-- The CHECK on `request_type` is also widened: `deep_research` was already
-- being written by the Deep Research approve route and would have been rejected
-- by the constraint the first time a real run settled. That is the kind of bug
-- only a live run finds, which is why the run path now has a test.

ALTER TABLE ai_wallet_settlements
  DROP CONSTRAINT IF EXISTS ai_wallet_settlements_request_type_check;

ALTER TABLE ai_wallet_settlements
  ADD CONSTRAINT ai_wallet_settlements_request_type_check
  CHECK (request_type IN (
    'chat', 'vision', 'ocr', 'media_detect',
    'proactive', 'autopilot', 'coworker', 'agent',
    'automation', 'embedding', 'deep_research', 'other'
  ));

-- The runtime mode in force for this turn: `auto`, `instant` or `deep_research`.
-- Nullable, and deliberately so — the issue asks for *relevant* attribution, and
-- a mode is relevant to a chat turn and to nothing else. An OCR call, a vision
-- count and a media detection have no mode, and writing `auto` on them would
-- invent one: the report would then claim those turns ran on the `auto` alias,
-- which they never touched. A NULL mode in the report means "this surface has
-- no mode", which is the truth, and the chat path always writes one explicitly.
ALTER TABLE ai_wallet_settlements
  ADD COLUMN IF NOT EXISTS runtime_mode text
    CHECK (runtime_mode IS NULL OR runtime_mode IN ('auto', 'instant', 'deep_research'));

-- The Superadmin system agent invoked for this turn, and the assignment
-- (suggestion card) that surfaced it. Both are loose uuids, by the same rule as
-- the existing correlation ids: a settlement must survive the deletion of the
-- thing it billed, so an agent that is retired does not take its cost history
-- with it.
ALTER TABLE ai_wallet_settlements
  ADD COLUMN IF NOT EXISTS system_agent_id uuid;

ALTER TABLE ai_wallet_settlements
  ADD COLUMN IF NOT EXISTS suggestion_id uuid;

ALTER TABLE ai_wallet_settlements
  ADD COLUMN IF NOT EXISTS research_run_id uuid;

-- The prompt layers the resolver composed, in composition order. A record of
-- what the model was actually told, kept with the cost, so "why did it answer
-- like that" is answerable after the fact rather than only while the code is
-- the version that produced it.
ALTER TABLE ai_wallet_settlements
  ADD COLUMN IF NOT EXISTS prompt_layers jsonb NOT NULL DEFAULT '[]'::jsonb;

-- §20 — the app the turn was focused on. Recorded rather than inferred because
-- the issue is explicit that app focus can change BETWEEN TURNS of the same
-- conversation: a member asks about CRM, then focuses Accounting, then asks
-- again. A conversation-level app would be wrong for two of those three turns,
-- and the whole point of §20 is that mode/agent/app are per-turn facts.
ALTER TABLE ai_wallet_settlements
  ADD COLUMN IF NOT EXISTS app_focus text;

-- §20 — the prompt versions that were actually live. `prompt_layers` records
-- the composition order; this records what each layer's text was, so "why did it
-- answer like that" is answerable after the fact rather than only while the code
-- is the version that produced it. An array of `{ scope, version }` in the same
-- order, so a rollback is visible in the history.
ALTER TABLE ai_wallet_settlements
  ADD COLUMN IF NOT EXISTS prompt_versions jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_ai_wallet_settlements_app_focus
  ON ai_wallet_settlements (business_id, app_focus, created_at DESC)
  WHERE app_focus IS NOT NULL;

-- The research run's own row already links back here; this closes the loop
-- from the settlement side and lets the usage report slice a run's total.
CREATE INDEX IF NOT EXISTS idx_ai_wallet_settlements_research_run
  ON ai_wallet_settlements (business_id, research_run_id)
  WHERE research_run_id IS NOT NULL;

-- Slicing by mode and by agent is the whole point of the columns, and both are
-- highly selective (a business has one mode in play at a time, and a handful of
-- assigned agents), so partial indexes keep them cheap.
CREATE INDEX IF NOT EXISTS idx_ai_wallet_settlements_mode
  ON ai_wallet_settlements (business_id, runtime_mode, created_at DESC)
  WHERE runtime_mode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_wallet_settlements_system_agent
  ON ai_wallet_settlements (business_id, system_agent_id, created_at DESC)
  WHERE system_agent_id IS NOT NULL;
