-- Printing unification (issue #815): one source of truth per question.
--
-- Before this migration the printing stack answered the same questions in
-- several places at once:
--
--   * `printers.connection` (jsonb) carried behaviour — `paper`,
--     `paperWidthMm`, `openDrawer`, `isDefault`, `templateKey` — while the
--     columns migration 0173 added carried the same fields. New code wrote
--     both and read whichever it happened to remember;
--   * template selection lived on the printer row (jsonb `templateKey`)
--     *and* in `print_rules.template_key` / `template_id`;
--   * `printers.fallback_printer_id` duplicated `print_rules.fallback_printer_id`.
--
-- This migration makes the relational columns the only behavioural truth:
-- 0173's backfill is repeated for rows written since (and for the behavioural
-- keys 0173 did not copy), printer-held template selection is promoted into
-- the branch's print rule exactly once, and the redundant printer column is
-- dropped. After this file has run in every environment, the compatibility
-- read in `src/lib/printing/types.ts` (`legacyBehaviorOf`) can go too.

-- ── 1. printer_class / paper / drawer / defaults, again for newer rows ──
UPDATE printers
   SET supports_drawer = COALESCE(supports_drawer, false) OR COALESCE(connection->>'openDrawer' = 'true', false),
       supports_cut = COALESCE(supports_cut, true),
       is_default = COALESCE(is_default, false) OR COALESCE(connection->>'isDefault' = 'true', false),
       paper = COALESCE(paper, NULLIF(connection->>'paper', '')),
       paper_width_mm = COALESCE(
         paper_width_mm,
         CASE WHEN connection->>'paperWidthMm' ~ '^[0-9]+$' THEN (connection->>'paperWidthMm')::int ELSE NULL END
       )
 WHERE jsonb_typeof(connection) = 'object';

-- A value the app's paper list does not know (a hand-edited key, a paper the
-- product retired) is cleared rather than trusted: the column is authoritative
-- now, so an unknown value would silently become the printer's paper.
UPDATE printers
   SET paper = NULL
 WHERE paper IS NOT NULL
   AND paper <> ''
   AND paper NOT IN ('thermal58', 'thermal80', 'a4', 'a5', 'label57x40');

-- The paper a row ends up with decides its class; purpose decides the rest.
UPDATE printers
   SET paper = CASE
         WHEN paper IS NOT NULL THEN paper
         WHEN kind::text = 'document' THEN 'a4'
         WHEN kind::text = 'label' THEN 'label57x40'
         WHEN paper_width_mm = 58 THEN 'thermal58'
         ELSE 'thermal80'
       END
 WHERE paper IS NULL OR paper = '';

UPDATE printers
   SET paper_width_mm = CASE
         WHEN paper IN ('thermal58') THEN 58
         WHEN paper IN ('thermal80') THEN 80
         ELSE NULL
       END
 WHERE paper IN ('thermal58', 'thermal80');

UPDATE printers
   SET printer_class = CASE
         WHEN paper = 'label57x40' OR kind::text = 'label' THEN 'label'
         WHEN paper IN ('a4', 'a5') OR kind::text = 'document' THEN 'page'
         ELSE 'thermal'
       END
 WHERE printer_class IS NULL OR printer_class = 'thermal' OR printer_class NOT IN ('thermal', 'page', 'label');

-- A drawer hangs off a thermal roll printer; a page/label printer has none.
UPDATE printers
   SET supports_drawer = false
 WHERE printer_class <> 'thermal';

-- ── 2. the printer's template choice becomes the branch's print rule ──────
-- Exactly the drift the issue describes: a template chosen and saved on the
-- printer row was never the template the runtime rendered. Promote it once
-- into the rule that owns routing, only where the rule has no template yet,
-- and only when the key still names something real.
INSERT INTO print_rules (location_id, document_type, template_key, printer_id)
SELECT p.location_id,
       CASE p.kind::text WHEN 'kitchen' THEN 'kitchen' WHEN 'document' THEN 'invoice' WHEN 'label' THEN 'label' ELSE 'receipt' END,
       NULLIF(p.connection->>'templateKey', ''),
       NULL
  FROM printers p
 WHERE jsonb_typeof(p.connection) = 'object'
   AND COALESCE(p.connection->>'templateKey', '') <> ''
   AND (
     p.connection->>'templateKey' IN (SELECT key FROM (VALUES
        ('thermal80-receipt'), ('thermal58-receipt'), ('a4-invoice'), ('a5-invoice'),
        ('label57x40-label'), ('thermal80-kitchen')) AS builtin(key))
     OR EXISTS (SELECT 1 FROM print_templates t WHERE t.id::text = p.connection->>'templateKey' AND t.location_id = p.location_id)
   )
ON CONFLICT (location_id, document_type) DO NOTHING;

-- A promoted key that is a saved template's id belongs in `template_id`, not
-- in `template_key` — the resolver accepts both, but only one is the column's
-- documented meaning.
UPDATE print_rules r
   SET template_id = t.id,
       template_key = NULL
  FROM print_templates t
 WHERE r.template_key = t.id::text
   AND r.location_id = t.location_id;

-- ── 3. the printer's jsonb keeps the hardware target and nothing else ─────
UPDATE printers
   SET connection = connection - 'paper' - 'paperWidthMm' - 'openDrawer' - 'isDefault' - 'templateKey' - 'supportsCut'
 WHERE jsonb_typeof(connection) = 'object'
   AND connection ?| ARRAY['paper', 'paperWidthMm', 'openDrawer', 'isDefault', 'templateKey', 'supportsCut'];

-- ── 4. drop the duplicate fallback column ─────────────────────────────────
-- `print_rules` owns fallback routing; nothing reads the printer-level copy.
ALTER TABLE printers DROP COLUMN IF EXISTS fallback_printer_id;

-- ── 5. print jobs record exactly which revision printed them ──────────────
ALTER TABLE print_jobs
    ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES print_templates(id) ON DELETE SET NULL;

-- ── 6. one default printer per (branch, purpose) ──────────────────────────
-- The application enforces this transactionally; the index keeps a
-- hand-edited row from creating a second default the resolver would refuse
-- to choose between (resolvePrinter falls through to "choose" when a
-- document type has two defaults).
-- Collapse any pre-existing duplicates first, keeping the first printer by
-- name, so the index below can be created on a live database.
UPDATE printers
   SET is_default = false
 WHERE is_default
   AND id NOT IN (
     SELECT DISTINCT ON (location_id, kind) id
       FROM printers
      WHERE is_default
      ORDER BY location_id, kind, name
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_one_default_per_purpose
    ON printers (location_id, kind)
 WHERE is_default;
