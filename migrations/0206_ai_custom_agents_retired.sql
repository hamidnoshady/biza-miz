-- Issue #812 §4 — the tenant agent builder's tables are gone.
--
-- Migration 0204 dropped the local answer cache and the local pgvector RAG
-- tables, and left `ai_custom_agents` behind on purpose: the column
-- `ai_projects.default_agent_id` (migration 0160) references it, so dropping it
-- first would have failed the migration and left the schema half-changed.
--
-- Both the code and the UI that wrote these rows were removed in the same issue:
-- `/api/ai/agents*` and `/api/ai/agents/[id]`, `src/lib/ai-custom-agents.ts`,
-- `ai-custom-agents-service.ts`, `<AiAgentSelector>`, the `agents`
-- `?aiPanel=` section and the project's `default_agent_id` pin. A system agent
-- is now built and versioned only by Superadmin (`ai_system_agents`, 0203) and
-- reaches a tenant through an assignment (`ai_agent_assignments`, 0203), so
-- nothing reads this table.
--
-- The reference goes first, then the table. The data is not carried over: a
-- tenant-built agent's prompt and allowlist were never a Superadmin-versioned
-- object, and silently promoting them to one would give a tenant-written prompt
-- platform authority it was never reviewed for.

ALTER TABLE ai_projects DROP CONSTRAINT IF EXISTS ai_projects_default_agent_id_fkey;
ALTER TABLE ai_projects DROP COLUMN IF EXISTS default_agent_id;

DROP TABLE IF EXISTS ai_custom_agents;
