-- Issue #988 — the durable record of an IAM-sync failure *blocking* operational sync.
--
-- `runServerSyncTick()` gates master-data sync, the site profile, push and pull
-- on `runIamSync()` returning true, and that gating is deliberate: a suspension
-- or a permission revocation must land on the till before the orders queued
-- behind it. What was missing was the evidence. The blocked tick logged one
-- `console.error` line and moved on, so an install could sit with every sale it
-- took staying on the local disk for nine days (the observed case: 1 092 log
-- lines) while every health surface — the connection badge,
-- Settings → اتصال و همگام‌سازی, the device fleet — kept saying healthy.
--
-- This is the same shape `iam_login_credential_sync_state` (migration 0203) was
-- created for on the credential plane: a failure that is real, visible only in
-- a log line, and invisible to the person who can act on it. The row here
-- answers three questions the log never could:
--
--   is this install's operational traffic being gated *right now* (`status`),
--   for how long and how many ticks in a row (`first_blocked_at`,
--   `last_blocked_at`, `consecutive_blocked_ticks`), and what is queued behind
--   the gate (`pending_outbox`, the local events still waiting to be pushed)?
--
-- The blocking behaviour is unchanged — that is the point of the gate. Only the
-- silence is removed: the tick records the block, a run past
-- `OPERATIONAL_SYNC_ALERT_AFTER_TICKS` raises one notification per episode
-- (`alerted_at`), and a converged tick clears the row (`last_recovered_at`).
CREATE TABLE iam_operational_sync_block_state (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  site_device_id uuid NOT NULL,
  -- 'clear' is written by a converged tick so the episode keeps its audit
  -- trail; a row that never existed means this install has never gated
  -- anything, which is not the same claim as "it was checked and passed".
  status text NOT NULL DEFAULT 'blocked' CHECK (status IN ('clear','blocked')),
  -- Episode bounds. `first_blocked_at` is stamped on the first blocked tick of
  -- an episode and kept through the rest of it, so "blocked since" is a duration
  -- an operator can read, not just the last time it happened.
  first_blocked_at timestamptz,
  last_blocked_at timestamptz,
  last_recovered_at timestamptz,
  last_attempt_at timestamptz,
  -- 'failed' is the IAM reconciliation itself; 'not_configured' is recorded as
  -- an absent row instead, so a local-only install is never reported as blocked.
  last_error text,
  -- Short machine code from `classifyIamFailure()` (transport | unauthorized |
  -- forbidden | unsupported_cloud | cloud_error | timeout | sequence_gap |
  -- contract_mismatch | credential_rotation_pending | pairing_pending |
  -- not_configured | sync_error). Safe to display; a raw message is not. The
  -- vocabulary is owned by IAM_FAILURE_CODES in
  -- src/lib/iam/operational-sync-health.ts, not by a constraint here: a new
  -- reason must never be able to lose a tick's evidence over a check failure.
  last_code text,
  consecutive_blocked_ticks integer NOT NULL DEFAULT 0 CHECK (consecutive_blocked_ticks >= 0),
  total_blocked_ticks integer NOT NULL DEFAULT 0 CHECK (total_blocked_ticks >= 0),
  episodes_blocked integer NOT NULL DEFAULT 0 CHECK (episodes_blocked >= 0),
  -- Local events waiting to go up, measured when the block was recorded: the
  -- money-path backlog the gate is holding back.
  pending_outbox integer NOT NULL DEFAULT 0 CHECK (pending_outbox >= 0),
  -- One alert per blocked episode. Cleared when the episode ends, so a block
  -- that returns after a recovery can raise a fresh one.
  alerted_at timestamptz,
  PRIMARY KEY (business_id, site_device_id),
  FOREIGN KEY (site_device_id, business_id) REFERENCES site_devices(id, business_id) ON DELETE CASCADE,
  CHECK (status = 'blocked' OR consecutive_blocked_ticks = 0)
);

CREATE INDEX iam_operational_sync_block_state_blocked_idx
  ON iam_operational_sync_block_state (business_id, last_blocked_at DESC)
  WHERE status = 'blocked';

ALTER TABLE iam_operational_sync_block_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam_operational_sync_block_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON iam_operational_sync_block_state
  FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE iam_operational_sync_block_state IS
  'Issue #988: per paired site, the durable record of an IAM-sync failure gating operational sync (first/last blocked tick, consecutive count, queued local events, alert state) — the evidence the console line was the only trace of.';
COMMENT ON COLUMN iam_operational_sync_block_state.consecutive_blocked_ticks IS
  'Blocked ticks in a row; the alert fires once the episode reaches OPERATIONAL_SYNC_ALERT_AFTER_TICKS (src/lib/iam/operational-sync-health.ts).';
COMMENT ON COLUMN iam_operational_sync_block_state.pending_outbox IS
  'Local sync_events still waiting to be pushed when the block was recorded — how much unsynced sales the gate is holding back.';
