-- Issue #764 — Growth & Marketing permission split.
--
-- `loyalty.manage`, `growth.view` and `campaigns.manage` used to stand for
-- several different acts at once: configuring a loyalty program *and* issuing
-- store credit *and* paying it out *and* issuing/spending gift cards; reading
-- the management dashboard *and* the commission report; running a campaign
-- *and* writing commission rules. The code now names each act separately
-- (src/lib/permissions.ts, src/lib/growth-access.ts).
--
-- Role presets are computed in code, but per-member overrides
-- (`users.permissions`, `invitations.permissions`: {granted, revoked}) and
-- tenant custom roles (`tenant_roles.permissions`: a flat array) store these
-- strings. This migration rewrites them, asymmetrically and on purpose:
--
--   * A REVOCATION of an old key also revokes every key carved out of it.
--     Otherwise a manager whose owner had revoked `loyalty.manage` would
--     silently regain store-credit payout from the manager preset — the one
--     outcome a security split must never produce.
--
--   * A GRANT of an old key is carried over only to the keys that are the
--     same, non-financial act it always meant:
--       loyalty.manage → loyalty.redeem   (spending points)
--       loyalty.view   → gift_cards.view  (the balance lookup it gated)
--     The liability-creating and compensation keys (store_credit.issue,
--     store_credit.payout, gift_cards.issue, gift_cards.redeem,
--     commission.view, commission.manage) are deliberately NOT inherited from
--     a broad grant: those grants were made when the broad key could not say
--     anything narrower, and the issue's point is that cashier-shaped grants
--     reached them by accident. An owner grants them explicitly.
--
-- Unknown keys are passed through untouched, exactly as 0137 did. The helper
-- functions are dropped at the end.

-- Every tenant's rows are rewritten, so this runs with the RLS bypass for the
-- rest of this migration's transaction only (scripts/migrate.ts wraps each
-- file in BEGIN/COMMIT; `true` makes the setting transaction-local).
SELECT set_config('app.rls_bypass', 'on', true);

CREATE FUNCTION growth_split_revoked(item text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE item
           WHEN 'loyalty.manage' THEN ARRAY['loyalty.manage', 'loyalty.redeem',
                                            'store_credit.issue', 'store_credit.payout',
                                            'gift_cards.issue', 'gift_cards.redeem']
           WHEN 'loyalty.view'   THEN ARRAY['loyalty.view', 'gift_cards.view']
           WHEN 'growth.view'    THEN ARRAY['growth.view', 'commission.view']
           WHEN 'campaigns.manage' THEN ARRAY['campaigns.manage', 'commission.manage']
           ELSE ARRAY[item]
         END;
$$;

CREATE FUNCTION growth_split_granted(item text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE item
           WHEN 'loyalty.manage' THEN ARRAY['loyalty.manage', 'loyalty.redeem']
           WHEN 'loyalty.view'   THEN ARRAY['loyalty.view', 'gift_cards.view']
           ELSE ARRAY[item]
         END;
$$;

-- Expand one jsonb array of permission strings, de-duplicated, order kept.
CREATE FUNCTION growth_split_array(items jsonb, revoked boolean) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(key) ORDER BY first_seen), '[]'::jsonb)
    FROM (
      SELECT key, min(ord * 100 + sub) AS first_seen
        FROM jsonb_array_elements(items) WITH ORDINALITY AS e(elem, ord),
             LATERAL unnest(
               CASE WHEN jsonb_typeof(elem) <> 'string' THEN ARRAY[]::text[]
                    WHEN revoked THEN growth_split_revoked(elem #>> '{}')
                    ELSE growth_split_granted(elem #>> '{}') END
             ) WITH ORDINALITY AS u(key, sub)
       GROUP BY key
    ) expanded;
$$;

CREATE FUNCTION growth_split_overrides(overrides jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(key,
    CASE WHEN jsonb_typeof(value) = 'array' AND key = 'revoked' THEN growth_split_array(value, true)
         WHEN jsonb_typeof(value) = 'array' AND key = 'granted' THEN growth_split_array(value, false)
         ELSE value END), '{}'::jsonb)
    FROM jsonb_each(overrides);
$$;

UPDATE users
   SET permissions = growth_split_overrides(permissions)
 WHERE jsonb_typeof(permissions) = 'object' AND permissions <> '{}'::jsonb;

UPDATE invitations
   SET permissions = growth_split_overrides(permissions)
 WHERE jsonb_typeof(permissions) = 'object' AND permissions <> '{}'::jsonb;

-- A custom role is a flat list of grants: the grant mapping applies.
UPDATE tenant_roles
   SET permissions = growth_split_array(permissions, false)
 WHERE jsonb_array_length(permissions) > 0;

DROP FUNCTION growth_split_overrides(jsonb);
DROP FUNCTION growth_split_array(jsonb, boolean);
DROP FUNCTION growth_split_granted(text);
DROP FUNCTION growth_split_revoked(text);
