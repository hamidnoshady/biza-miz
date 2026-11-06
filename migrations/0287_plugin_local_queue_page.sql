-- ============================================================================
-- 0287_plugin_local_queue_page.sql — issue #1076: page through the PLUGIN'S
-- own queue (its `{prefix}pos_connector_queue`) from the queue screen.
--
-- Until now the only view of the plugin-local layer was the aggregate in
-- `plugin_health` (pending/deferred/failed counts plus the ten newest problem
-- rows the plugin sends in every handshake, issue #942/F12). That is a strip,
-- not a diagnosis: a site with two hundred stuck events showed ten.
--
-- This is the smallest honest protocol the existing pull channel allows. The
-- app cannot dial the store in plugin mode, so:
--   1. an operator asks for one page:  request = { after, limit, requestedAt };
--   2. the next handshake response carries that request;
--   3. the plugin answers it in its following handshake telemetry, and
--   4. the app stores the answer here for the screen to read.
-- One round trip of the same 5-minute lane; no new endpoint on the site, no
-- credentials in either direction, and the answer is bounded (≤ 25 rows of
-- metadata only) before it is stored.
--
-- Columns live on the existing connection row on purpose: a two-slot
-- mailbox, not a second copy of the plugin's queue. `integration_connections`
-- already carries its tenant policy, so no new RLS policy is needed.
-- ============================================================================

ALTER TABLE integration_connections
    ADD COLUMN IF NOT EXISTS plugin_local_queue_request jsonb,
    ADD COLUMN IF NOT EXISTS plugin_local_queue_answer jsonb;

COMMENT ON COLUMN integration_connections.plugin_local_queue_request IS
    'Issue #1076 — one pending {after, limit, requestedAt} page request for the plugin-local queue, answered on a later handshake.';
COMMENT ON COLUMN integration_connections.plugin_local_queue_answer IS
    'Issue #1076 — the plugin''s bounded answer: {after, limit, rows, next, answeredAt}. Metadata only.';
