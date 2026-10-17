-- Issue #984 — link a support installation to its MeshCentral agent node.
--
-- The remote-assistance broker (src/lib/support-companion/remote-broker.ts)
-- addresses the attended machine by the MeshCentral node id the companion
-- reports on contact (the agent's stable id, e.g. `node//abc...`). The
-- operator-join path refuses with `agent_not_linked` until the companion has
-- reported it — a session can never bind to a guessed node.
--
-- Tenant isolation is unchanged: the column lives on the already RLS-forced
-- support_installations table, so no new policy is needed.

ALTER TABLE support_installations
    ADD COLUMN mesh_node_id text;

COMMENT ON COLUMN support_installations.mesh_node_id IS
    'Issue #984: MeshCentral agent node id reported by the companion on contact; NULL until linked.';
