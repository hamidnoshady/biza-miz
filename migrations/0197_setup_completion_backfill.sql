-- ============================================================================
-- 0197_setup_completion_backfill.sql — issue #808: one completion definition
--
-- Before this change `isSetupComplete()` answered true when EITHER
-- `setup.progress.completedAt` was set OR every required step's marker was
-- present ("the old required-step fallback"). Setup routing now reads the
-- formal marker alone, so every business that was only ever considered
-- complete by the fallback must be stamped once, here — otherwise established,
-- operating tenants would be sent back into first-run onboarding.
--
-- Three cases are stamped, all of them unambiguously *not* a fresh install:
--
--   1. The old fallback itself: all required markers for the business's
--      industry are present (business, accounts, tax, plus costing/menu for
--      F&B). This is exactly the set the old `missingForCompletion` checked.
--   2. A business with no `setup.progress` row at all that already has a chart
--      of accounts: only explicit provisioning (the super-admin console, the
--      platform company, or a seeded demo) creates accounts outside the
--      wizard, and those paths promise a business that is usable immediately
--      (issue #808 §4).
--   3. A business that is demonstrably operational — it has recorded an order,
--      a journal entry, or an inventory event — whatever its markers say.
--      Real trading is stronger evidence than a progress map that may have
--      been lost by the very write race this issue fixes.
--
-- Deliberately NOT stamped: a business with markers missing and no trading
-- history (a genuine first run, resume where you left off), and a signup whose
-- wizard was never started (no accounts, no progress) — those keep the wizard.
--
-- The audit event is not backfilled: `setup.completed` records an *actor*
-- completing a flow, and this is a system normalisation with no actor. The
-- stampedAt value is the time of normalisation, not a fictional completion
-- moment from the past.
--
-- `set_config(..., true)` is transaction-local and needed because `settings`
-- and `businesses` are FORCE ROW LEVEL SECURITY — a migration running as the
-- table owner is still subject to the policy, and the same bypass the seed
-- scripts use is the documented escape hatch here.
SELECT set_config('app.rls_bypass', 'on', true);

-- Case 1 — the old required-step fallback.
UPDATE settings s
   SET value = jsonb_set(s.value, '{completedAt}', to_jsonb(now()::text), true),
       updated_at = now()
  FROM businesses b
 WHERE s.business_id = b.id
   AND s.location_id IS NULL
   AND s.key = 'setup.progress'
   AND s.value ->> 'completedAt' IS NULL
   AND s.value -> 'steps' ->> 'business' IS NOT NULL
   AND s.value -> 'steps' ->> 'accounts' IS NOT NULL
   AND s.value -> 'steps' ->> 'tax' IS NOT NULL
   AND (b.industry <> 'food_service' OR s.value -> 'steps' ->> 'costing' IS NOT NULL)
   AND (b.industry <> 'food_service' OR s.value -> 'steps' ->> 'menu' IS NOT NULL);

-- Case 2 — provisioned (or seeded) without any progress row, but with a chart
-- of accounts. `ON CONFLICT DO NOTHING` keeps this from overwriting the row a
-- concurrent first-run wizard may have just written.
INSERT INTO settings (business_id, location_id, key, value)
SELECT b.id, NULL, 'setup.progress', jsonb_build_object(
         'steps', jsonb_build_object('provisioned', to_jsonb(now()::text)),
         'completedAt', to_jsonb(now()::text))
  FROM businesses b
 WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.business_id = b.id)
   AND NOT EXISTS (
     SELECT 1 FROM settings s
      WHERE s.business_id = b.id AND s.location_id IS NULL AND s.key = 'setup.progress'
   )
ON CONFLICT (business_id, location_id, key) DO NOTHING;

-- Case 3 — operational tenants whose markers are incomplete (or absent).
UPDATE settings s
   SET value = jsonb_set(s.value, '{completedAt}', to_jsonb(now()::text), true),
       updated_at = now()
  FROM businesses b
 WHERE s.business_id = b.id
   AND s.location_id IS NULL
   AND s.key = 'setup.progress'
   AND s.value ->> 'completedAt' IS NULL
   AND (
     EXISTS (SELECT 1 FROM orders o JOIN locations l ON l.id = o.location_id
              WHERE l.business_id = b.id)
     OR EXISTS (SELECT 1 FROM journal_entries je WHERE je.business_id = b.id)
     OR EXISTS (SELECT 1 FROM inventory_events ie WHERE ie.business_id = b.id)
   );

-- Case 3, the no-row variant: an operational tenant that never had a progress
-- row (e.g. a console-provisioned business that has since traded).
INSERT INTO settings (business_id, location_id, key, value)
SELECT b.id, NULL, 'setup.progress', jsonb_build_object(
         'steps', jsonb_build_object('operational', to_jsonb(now()::text)),
         'completedAt', to_jsonb(now()::text))
  FROM businesses b
 WHERE NOT EXISTS (
     SELECT 1 FROM settings s
      WHERE s.business_id = b.id AND s.location_id IS NULL AND s.key = 'setup.progress'
   )
   AND (
     EXISTS (SELECT 1 FROM orders o JOIN locations l ON l.id = o.location_id
              WHERE l.business_id = b.id)
     OR EXISTS (SELECT 1 FROM journal_entries je WHERE je.business_id = b.id)
     OR EXISTS (SELECT 1 FROM inventory_events ie WHERE ie.business_id = b.id)
   )
ON CONFLICT (business_id, location_id, key) DO NOTHING;
