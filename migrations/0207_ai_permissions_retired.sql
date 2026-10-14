-- Issue #812 §4 — retire the two AI permissions that no longer gate anything.
--
-- `ai.agents.manage` guarded the tenant Agent Builder (routes, `ai_custom_agents`,
-- `<AiAgentSelector>`, the `agents` panel section), and `ai.knowledge.manage`
-- guarded the tenant knowledge/reindex manager. Both surfaces were deleted by
-- this issue: a system agent is built and versioned only by Superadmin, and
-- knowledge is infrastructure owned by the configured LiteLLM layer.
--
-- `ai.widgets.manage` is retired for a different reason and is worth separating:
-- its surface still exists. A workspace widget is a saved prompt that runs with
-- its creator's OWN permissions, and `ai-widgets.ts` refuses any widget whose
-- `requiredPermissions` the caller does not already hold. That intersection is a
-- stronger boundary than a dedicated key would be — it holds per widget rather
-- than per member, and it fails closed on an unknown permission — so the key was
-- guarding nothing while the registry advertised it as a delegation.
--
-- The keys are removed from `PERMISSIONS`, which is what `isPermission()` reads,
-- so a stored grant of either one already degrades to "no override" at parse
-- time (`parseOverrides` filters through `isPermission`). This migration does the
-- same to the stored data, for two reasons that outlive the code:
--
--   1. The Superadmin permission catalogue is rendered from `permission-registry.ts`
--      and the stored custom roles; a dangling key would still be listed as
--      delegatable on a role an owner saved before the removal.
--   2. An audit row is only meaningful if the permission it names still exists.
--
-- Nothing is widened and nothing is revoked from a capability a member still
-- needs: both keys were `implies: [ai.use]` leaves, and `ai.use` stays.

-- Tenant custom roles (0171): `permissions jsonb` holding a text array.
UPDATE tenant_roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(key), '[]'::jsonb)
       FROM jsonb_array_elements_text(tenant_roles.permissions) AS key
      WHERE key NOT IN ('ai.agents.manage', 'ai.knowledge.manage', 'ai.widgets.manage')
   )
 WHERE permissions ?| array['ai.agents.manage', 'ai.knowledge.manage', 'ai.widgets.manage'];

-- Per-member overrides (0020/0022): `permissions jsonb` holding
-- { granted: [...], revoked: [...] }. A revoked entry for a permission that no
-- longer exists is meaningless, and dropping it is not a grant — the base role
-- no longer carries the key either.
UPDATE users
   SET permissions = jsonb_build_object(
         'granted', (
           SELECT COALESCE(jsonb_agg(key), '[]'::jsonb)
             FROM jsonb_array_elements_text(users.permissions->'granted') AS key
            WHERE key NOT IN ('ai.agents.manage', 'ai.knowledge.manage', 'ai.widgets.manage')
         ),
         'revoked', (
           SELECT COALESCE(jsonb_agg(key), '[]'::jsonb)
             FROM jsonb_array_elements_text(users.permissions->'revoked') AS key
            WHERE key NOT IN ('ai.agents.manage', 'ai.knowledge.manage', 'ai.widgets.manage')
         )
       )
 WHERE users.permissions->'granted' ?| array['ai.agents.manage', 'ai.knowledge.manage', 'ai.widgets.manage']
    OR users.permissions->'revoked' ?| array['ai.agents.manage', 'ai.knowledge.manage', 'ai.widgets.manage'];

UPDATE invitations
   SET permissions = jsonb_build_object(
         'granted', (
           SELECT COALESCE(jsonb_agg(key), '[]'::jsonb)
             FROM jsonb_array_elements_text(invitations.permissions->'granted') AS key
            WHERE key NOT IN ('ai.agents.manage', 'ai.knowledge.manage', 'ai.widgets.manage')
         ),
         'revoked', (
           SELECT COALESCE(jsonb_agg(key), '[]'::jsonb)
             FROM jsonb_array_elements_text(invitations.permissions->'revoked') AS key
            WHERE key NOT IN ('ai.agents.manage', 'ai.knowledge.manage', 'ai.widgets.manage')
         )
       )
 WHERE invitations.permissions->'granted' ?| array['ai.agents.manage', 'ai.knowledge.manage', 'ai.widgets.manage']
    OR invitations.permissions->'revoked' ?| array['ai.agents.manage', 'ai.knowledge.manage', 'ai.widgets.manage'];
