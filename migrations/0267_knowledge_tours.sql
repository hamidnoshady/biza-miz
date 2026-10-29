-- Issue #972 — global editable guided-tour catalogue.
-- As with knowledge_articles, tours are platform-authored and readable by all
-- tenants ONLY when published. The member-facing API applies role/industry
-- eligibility before returning any metadata. Drafts stay platform-only.
CREATE TABLE IF NOT EXISTS knowledge_tours (
  id text PRIMARY KEY
    CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  page_key text NOT NULL CHECK (left(page_key, 6) = 'page:/'),
  route text NOT NULL CHECK (route = substr(page_key, 6)),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  eligibility jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(eligibility) = 'object'),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) <= 60),
  created_by text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS knowledge_tours_page_status ON knowledge_tours (page_key, status, updated_at DESC);
-- Historic versions are immutable audit snapshots for rollback and review.
CREATE TABLE IF NOT EXISTS knowledge_tour_revisions (
  tour_id text NOT NULL REFERENCES knowledge_tours(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tour_id, version)
);
-- These are platform-wide shared content, not tenant records: follow the same
-- exemption policy as knowledge_articles in src/lib/tenant-tables.ts.
