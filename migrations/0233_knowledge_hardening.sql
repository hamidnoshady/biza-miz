-- ============================================================================
-- 0233_knowledge_hardening.sql — issue #938 (finish /knowledge hardening).
--
-- Four database-level guarantees the service layer relies on:
--
--   1. `knowledge_articles.version` — optimistic concurrency. An editor that
--      saves with the version it loaded wins; a second editor holding the old
--      version gets a 409 instead of silently overwriting the first save.
--
--   2. Normalized search. Persian text mixes Arabic Yeh/Kaf (ي/ك) with the
--      Persian forms (ی/ک), Persian (۰…) and Arabic-Indic (٠…) digits, and
--      ZWNJ. `kb_normalize_search` folds all of those, and both the stored
--      search document and the tsvector are generated from the folded text,
--      so `جستجوي` and `جستجوی` reach the same article. The application-side
--      twin is `normalizeKbSearchText` in src/lib/knowledge.ts.
--
--   3. A parent-chain cycle guard on `knowledge_categories`. The service
--      checks descendants before every move; this trigger is the last line of
--      defence for hand-edited rows and concurrent moves, because a cycle
--      makes the whole branch invisible to the member tree.
--
--   4. A deterministic admin ordering index, so the console's page+limit
--      pagination does not walk a growing sort each request.
--
--   5. `updated_by` on categories and tags. Articles already carry it; without
--      the same marker for the two smaller catalogues the seed could only
--      guess "has an editor touched this?" by comparing stored text with the
--      *new* registry values, which makes every legitimate registry change
--      look like an editorial edit. With the column, "untouched" means the
--      last writer is still `seed:knowledge` — exactly the article rule.
--
-- The four knowledge tables remain platform catalogues (no business_id);
-- nothing here adds tenant data or an AI/RAG store.
-- ============================================================================

-- 1) Optimistic concurrency --------------------------------------------------

ALTER TABLE knowledge_articles
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'knowledge_articles_version_positive'
       AND conrelid = 'knowledge_articles'::regclass
  ) THEN
    ALTER TABLE knowledge_articles
      ADD CONSTRAINT knowledge_articles_version_positive CHECK (version > 0);
  END IF;
END $$;

-- 2) Search normalization ----------------------------------------------------

CREATE OR REPLACE FUNCTION kb_normalize_search(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT btrim(
           regexp_replace(
             translate(
               regexp_replace(
                 translate(
                   lower(replace(coalesce(input, ''), U&'\200C', ' ')),
                   U&'\0640', ''
                 ),
                 U&'[\064B-\0655\0670]',
                 '',
                 'g'
               ),
               -- Arabic Yeh / Alef Maksura → Persian Yeh, Arabic Kaf → Persian
               -- Kaf, Teh Marbuta → Heh, Persian and Arabic-Indic digits → ASCII.
               U&'\064A\0649\0643\0629\06C0\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669',
               U&'\06CC\06CC\06A9\0647\0647\0030\0031\0032\0033\0034\0035\0036\0037\0038\0039\0030\0031\0032\0033\0034\0035\0036\0037\0038\0039'
             ),
             '\s+',
             ' ',
             'g'
           )
         );
$fn$;

-- The old tsvector was generated from the raw title/summary/body. A generated
-- column's expression cannot be altered, so both columns are dropped and
-- rebuilt from the folded document. Dropping search_tsv also drops its GIN
-- index; the index is recreated below.
ALTER TABLE knowledge_articles
  DROP COLUMN IF EXISTS search_tsv,
  DROP COLUMN IF EXISTS search_text;

ALTER TABLE knowledge_articles
  ADD COLUMN search_text text
    GENERATED ALWAYS AS (
      kb_normalize_search(
        coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body_md, '')
      )
    ) STORED;

ALTER TABLE knowledge_articles
  ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector(
        'simple',
        kb_normalize_search(
          coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body_md, '')
        )
      )
    ) STORED;

CREATE INDEX IF NOT EXISTS knowledge_articles_search_idx
  ON knowledge_articles USING GIN (search_tsv);

-- 3) Category ancestry cycle guard ------------------------------------------

CREATE OR REPLACE FUNCTION knowledge_categories_reject_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  cursor_id uuid;
  steps integer := 0;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'knowledge_category_cycle'
      USING ERRCODE = '23514',
            HINT = 'A category cannot be its own parent.';
  END IF;
  cursor_id := NEW.parent_id;
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'knowledge_category_cycle'
        USING ERRCODE = '23514',
              HINT = 'A category cannot be moved below one of its descendants.';
    END IF;
    steps := steps + 1;
    -- Defensive: existing hand-edited data could already hold a loop. Stop
    -- after a sane depth instead of spinning forever inside the trigger.
    IF steps > 200 THEN
      RAISE EXCEPTION 'knowledge_category_cycle'
        USING ERRCODE = '23514',
              HINT = 'Category parent chain is deeper than 200 levels or already loops.';
    END IF;
    SELECT parent_id INTO cursor_id FROM knowledge_categories WHERE id = cursor_id;
  END LOOP;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS knowledge_categories_cycle_guard ON knowledge_categories;
CREATE TRIGGER knowledge_categories_cycle_guard
  BEFORE INSERT OR UPDATE OF parent_id ON knowledge_categories
  FOR EACH ROW
  EXECUTE FUNCTION knowledge_categories_reject_cycle();

-- 4) Deterministic admin ordering -------------------------------------------

CREATE INDEX IF NOT EXISTS knowledge_articles_admin_order_idx
  ON knowledge_articles (updated_at DESC, id DESC);

-- 5) Editorial provenance for categories and tags ----------------------------

ALTER TABLE knowledge_categories
  ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT '';
ALTER TABLE knowledge_tags
  ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT '';

-- Rows written before this column existed were created by their `created_by`
-- (the seed, an importer, or the console). Treating that as the last writer is
-- the truthful reading: no one has edited them since, because there was no
-- column to record it.
UPDATE knowledge_categories SET updated_by = created_by WHERE updated_by = '';
UPDATE knowledge_tags SET updated_by = created_by WHERE updated_by = '';
