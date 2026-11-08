-- ============================================================================
-- 0289_tour_action_evidence.sql — issue #972 (verified business actions).
--
-- The proof that a member really did the thing a tour step asked for. A tour
-- step of kind `action` names a verifier key (src/lib/tour-verifiers.ts, a
-- reviewed whitelist) and is completed ONLY when this table has a row for that
-- (business, member, verifier): the domain endpoint that performed the write
-- records it in the same request, so a failed save leaves no evidence and a
-- browser cannot claim success. The progress API has no field in which a
-- client can assert that an action happened.
--
-- One row per (business, member, verifier) — an upsert, not a log. What the
-- verifier asks is "has this person ever done this, and when last", which is
-- all a step needs to be honest: a member who registered a product last week
-- is not asked to create a duplicate just to finish a tour (the epic's rule
-- against forcing repeats to prove learning). The counters are bounded by the
-- verifier whitelist, so the table cannot grow with usage.
--
-- No payload is stored: `last_entity_id` is an opaque row id for support, never
-- a customer's name, an order's contents or anything else the member typed.
-- The table is tenant data (RLS forced on business_id) and is deliberately NOT
-- in the platform catalogue exemption list.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tour_action_evidence (
  business_id    uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verifier       text        NOT NULL,
  first_at       timestamptz NOT NULL DEFAULT now(),
  last_at        timestamptz NOT NULL DEFAULT now(),
  count          integer     NOT NULL DEFAULT 1,
  last_entity_id text,
  PRIMARY KEY (business_id, user_id, verifier),
  CONSTRAINT tour_action_evidence_verifier_shape
    CHECK (verifier ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT tour_action_evidence_count_positive CHECK (count > 0),
  CONSTRAINT tour_action_evidence_entity_shape
    CHECK (last_entity_id IS NULL OR (length(last_entity_id) BETWEEN 1 AND 64))
);

CREATE INDEX IF NOT EXISTS tour_action_evidence_verifier
  ON tour_action_evidence (business_id, verifier, last_at DESC);

ALTER TABLE tour_action_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE tour_action_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tour_action_evidence;
CREATE POLICY tenant_isolation ON tour_action_evidence FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
