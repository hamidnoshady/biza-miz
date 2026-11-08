-- ============================================================================
-- 0288_knowledge_tours.sql — the authored guided-tour catalogue (issue #972).
--
-- Until now a guided tour was a code definition in `src/lib/tours.ts`: adding
-- or rewording one meant a pull request. This migration gives the super-admin
-- console («پایگاه دانش» → «تورهای تعاملی») a place to author tours, publish
-- them and roll back, without a deployment. It is a platform catalogue in the
-- exact shape of migration 0131's articles: no business_id, the same published
-- content teaches every business, so there is no tenant RLS policy and the
-- tables are listed as exempt in src/lib/tenant-tables.ts. Reads by members go
-- through `publishedToursForPage` / `publishedTourById` on the tenant routes;
-- every write happens under /api/platform/knowledge/tours with
-- `knowledge.manage` and a platform_audit_log entry.
--
--   knowledge_tours            one row per authored tour: its stable key, the
--                              page it belongs to, its working copy and which
--                              revision is live.
--   knowledge_tour_revisions   immutable content snapshots. Saving a draft
--                              appends one; publishing only points at it, so
--                              rollback never has to reconstruct content and a
--                              member's progress (tour_member_progress, keyed
--                              on the tour key) survives every edit.
--
-- Precedence, decided in src/lib/tour-baseline.ts: a published tour replaces a
-- code tour with the same key and is listed beside the page's other tours; a
-- page with no authored tour at all still falls back to its automatic baseline,
-- and an archived/draft tour is invisible to members.
-- ============================================================================

CREATE TABLE knowledge_tours (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The tour id progress is stored under (`tour_member_progress.tour_id`) and
    -- the id the member API is called with. Lowercase and dotted, like the code
    -- catalogue ids; `baseline.` is reserved for the automatic tours.
    tour_key          text NOT NULL UNIQUE
                      CHECK (tour_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
                      CHECK (tour_key NOT LIKE 'baseline.%'),
    -- The canonical KNOWLEDGE_PAGES key and route the tour runs on; the check
    -- keeps the two from ever disagreeing (a tour must run where it is listed).
    page_key          text NOT NULL CHECK (page_key LIKE 'page:/%'),
    route             text NOT NULL CHECK (route LIKE '/%'),
    CONSTRAINT knowledge_tours_page_route CHECK (page_key = 'page:' || route),
    title             text NOT NULL CHECK (btrim(title) <> ''),
    description       text NOT NULL DEFAULT '',
    -- Structural eligibility (permissions, industries, features, anyOf) — an
    -- object validated by src/lib/tour-studio.ts before it is stored, and
    -- evaluated per member by the same `tourForViewer` the code catalogue uses.
    eligibility       jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(eligibility) = 'object'),
    steps             jsonb NOT NULL DEFAULT '[]'::jsonb
                      CHECK (jsonb_typeof(steps) = 'array'),
    status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'published', 'archived')),
    -- The working copy's revision. Every save appends a revision with this
    -- number, so two authors saving at once are separated by this column (the
    -- console sends the version it read; a mismatch is a 409, never a silent
    -- overwrite).
    version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    -- The revision members actually play. NULL until the first publish; kept
    -- when a tour is archived, so "what was live" stays answerable.
    published_version integer CHECK (published_version >= 1),
    CONSTRAINT knowledge_tours_live_version
        CHECK (status <> 'published' OR published_version IS NOT NULL),
    created_by        text NOT NULL DEFAULT '',
    updated_by        text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    published_at      timestamptz
);

-- The member lookup asks "the published tours of this page"; the console's
-- coverage list asks the same question per page, so one index serves both.
CREATE INDEX knowledge_tours_page_idx
    ON knowledge_tours (page_key, status);

CREATE TABLE knowledge_tour_revisions (
    tour_id      uuid NOT NULL REFERENCES knowledge_tours(id) ON DELETE CASCADE,
    version      integer NOT NULL CHECK (version >= 1),
    -- Content columns are immutable: nothing edits a revision in place. Going
    -- back to an older one copies it into a new version (see
    -- `rollbackStudioTour`), which keeps the history append-only and leaves
    -- each member's progress keyed on step ids that a rollback restores.
    title        text NOT NULL CHECK (btrim(title) <> ''),
    description  text NOT NULL DEFAULT '',
    eligibility  jsonb NOT NULL DEFAULT '{}'::jsonb,
    steps        jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- Set when this revision became the live one; the only column that can
    -- change after insert.
    published_at timestamptz,
    PRIMARY KEY (tour_id, version)
);

CREATE INDEX knowledge_tour_revisions_recent_idx
    ON knowledge_tour_revisions (tour_id, version DESC);
