-- Issue #883 (wave 2) — granular grants, branch scope, and the payload hash
-- that lets an idempotency replay say "same key, different request".
--
-- Three additive pieces:
--
--   1. `grants jsonb` on mcp_connections and mcp_oauth_codes. The issue's own
--      words: "View by Accounting, CRM, Growth & Marketing, Website Management,
--      My Workspace/POS … Read/write boundaries for every supported operation,
--      per app, per operation category and per tool. Introduce least-privilege
--      app/tool grants". `scopes` stays the read/write axis (its CHECK is not
--      touched); `grants` names WHICH application domains and WHICH branches a
--      connection reaches. Shape (parsed defensively, fail-closed, by
--      `src/lib/mcp/grants.ts`):
--
--        {
--          "apps":     { "pos": {"read": true, "write": false}, "accounting": …,
--                        "crm": …, "growth": …, "website": …, "workspace": … },
--          "branches": "all" | ["<location uuid>", …]
--        }
--
--      The legacy default '{}' is CONSERVATIVE, not permissive: both halves of
--      the spec demand "conservative legacy migration" and forbid "silent
--      privilege widening", so an existing connection must keep meaning exactly
--      what it meant when its owner granted it — every app its authorizer
--      could reach, the branches it was granted for (implicitly "all" before
--      branch scope existed, which is what the tools actually reached).
--      New connections are minted with explicit grants; the UI defaults to
--      least privilege.
--
--   2. `branch_scope` is not a separate column: `grants.branches` IS the branch
--      consent. "all" = multi-branch consent; an array = named branches only,
--      and `src/lib/mcp/grants.ts` derives the single/multi classification
--      from it. Keeping it inside `grants` means consent is one document, not
--      two columns that could disagree, and the code has one parser.
--
--   3. `mcp_idempotency_payload_hash` on ai_action_audit. Issue #883 A5: a
--      replayed key with a DIFFERENT action/payload must fail visibly
--      (`idempotency_conflict`) instead of returning the original outcome as
--      if the client asked for the same thing. The hash is sha-256 (64 hex) of
--      the canonical action+payload JSON, stored at write time and compared at
--      replay time. No index needed: rows are reached through the existing
--      unique idempotency index.

ALTER TABLE mcp_connections
    ADD COLUMN IF NOT EXISTS grants jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(grants) = 'object');

ALTER TABLE mcp_oauth_codes
    ADD COLUMN IF NOT EXISTS grants jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(grants) = 'object');

-- The token table authenticates by joining mcp_connections; grants need no
-- column there because the connection row is the source of truth at auth time.

ALTER TABLE ai_action_audit
    ADD COLUMN IF NOT EXISTS mcp_idempotency_payload_hash text
        CHECK (mcp_idempotency_payload_hash IS NULL OR char_length(mcp_idempotency_payload_hash) = 64);

COMMENT ON COLUMN mcp_connections.grants IS
    'Issue #883: per-app read/write grants and branch consent. {} = legacy connection (all reachable apps, all branches) for conservative migration.';
COMMENT ON COLUMN ai_action_audit.mcp_idempotency_payload_hash IS
    'Issue #883: sha-256 of the canonical action+payload for idempotency-conflict detection on replay.';
