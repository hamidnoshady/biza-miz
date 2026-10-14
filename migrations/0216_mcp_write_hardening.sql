-- Issue #883 (P0-3) — durable idempotency for MCP writes.
--
-- An apply-mode MCP write happens inside a single JSON-RPC call, and callers
-- retry network timeouts. Without a durable dedupe key, a retried network call
-- is a second side effect (an expense booked twice, a price moved twice) that
-- only the client could tell apart from the first. `_meta.idempotencyKey` is
-- now persisted with the audit row, under a partial unique index scoped to the
-- connection: the second writer loses at the index and receives the ORIGINAL
-- row's durable outcome instead of a second effect.
--
-- Scoped to (business, connection): the same key under a different connection
-- is a different operation, and rows without a key (chat proposals, coworker
-- runs) are untouched by the constraint.

ALTER TABLE ai_action_audit
    ADD COLUMN IF NOT EXISTS mcp_idempotency_key text
        CHECK (mcp_idempotency_key IS NULL OR char_length(mcp_idempotency_key) BETWEEN 1 AND 128);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_action_audit_mcp_idempotency
    ON ai_action_audit (business_id, mcp_connection_id, mcp_idempotency_key)
    WHERE mcp_connection_id IS NOT NULL AND mcp_idempotency_key IS NOT NULL;
