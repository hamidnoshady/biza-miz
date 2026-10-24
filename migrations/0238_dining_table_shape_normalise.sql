-- Issue #916 follow-up: normalise dining_tables.shape BEFORE 0238_floor_table_
-- management_audit.sql narrows dining_tables_shape_check.
--
-- Migration 0004 created the column with CHECK (shape IN ('rect', 'circle')), and
-- every writer up to now (POST/PATCH /api/tables, the assistant and autopilot
-- executors, the MCP tool) stored 'circle' for a round table. 0238's floor audit
-- renamed that value to 'round' and added 'square' and 'booth', but re-added the
-- constraint without first converting existing rows, so any database holding a
-- circular table failed with
--   check constraint "dining_tables_shape_check" ... is violated by some row
-- and the deploy migration step could not complete.
--
-- This file sorts immediately before that migration (the runner applies
-- unapplied files in filename order and never re-reads applied ones), so a
-- database that has not run 0238 yet converts its rows first, and 0238 itself
-- stays byte-identical for databases that already applied it. On those it is a
-- harmless re-run: it ends by re-adding exactly the constraint 0238 left.
--
-- Idempotent: the UPDATEs match nothing once rows are normalised.

ALTER TABLE dining_tables
  DROP CONSTRAINT IF EXISTS dining_tables_shape_check;

-- dining_tables carries the master-sync capture trigger (0190), and RLS would
-- hide rows from the migration role without the bypass 0238 uses as well.
SELECT set_config('app.rls_bypass', 'on', true);

UPDATE dining_tables
   SET shape = 'round'
 WHERE shape = 'circle';

-- Anything else outside the vocabulary (hand-edited data, a constraint that was
-- dropped at some point) becomes the default rectangle rather than blocking the
-- deploy.
UPDATE dining_tables
   SET shape = 'rect'
 WHERE shape IS NULL
    OR shape NOT IN ('rect', 'round', 'square', 'booth');

SELECT set_config('app.rls_bypass', '', true);

ALTER TABLE dining_tables
  ADD CONSTRAINT dining_tables_shape_check
  CHECK (shape IN ('rect', 'round', 'square', 'booth'));
