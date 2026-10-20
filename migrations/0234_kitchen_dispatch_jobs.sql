-- Durable dispatch intents for operational kitchen tickets. The intent is
-- written in the same transaction as the order/item mutation; a local station
-- claims it and hands the stored document to the existing #815 print pipeline.
CREATE TABLE IF NOT EXISTS kitchen_dispatch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_ids uuid[] NOT NULL CHECK (cardinality(item_ids) > 0),
  idempotency_key text NOT NULL,
  owner_mode text NOT NULL CHECK (owner_mode IN ('local_runtime', 'hybrid_site', 'cloud_station')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'handed_off', 'failed', 'ambiguous')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_by uuid,
  claim_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  handed_off_at timestamptz,
  UNIQUE (location_id, idempotency_key),
  CHECK ((status = 'claimed') = (claim_token IS NOT NULL AND claim_until IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_kitchen_dispatch_claim
  ON kitchen_dispatch_jobs (location_id, owner_mode, available_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_kitchen_dispatch_lease
  ON kitchen_dispatch_jobs (location_id, claim_until)
  WHERE status = 'claimed';

ALTER TABLE kitchen_dispatch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_dispatch_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON kitchen_dispatch_jobs;
CREATE POLICY tenant_isolation ON kitchen_dispatch_jobs FOR ALL
  USING (app_rls_bypass() OR app_owns_location(location_id))
  WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));
