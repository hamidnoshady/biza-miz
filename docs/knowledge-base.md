# مرکز آموزش (in-product knowledge base)

The learning centre inside the member dashboard (`/dashboard/knowledge`) plus
its editorial console in the super-admin area (`/platform/knowledge`). One
shared body of Persian content — 45 seeded guides covering every
member-facing corner of the platform — written so end users (صندوق‌دار،
گارسون، مدیر) can self-serve instead of calling support.

The super-admin console itself is deliberately *not* documented in the
member knowledge base; platform operators use this repo's `docs/` instead.

## Data model (migration `0131_knowledge_base_content.sql`)

Four platform-catalogue tables — **no `business_id`**, the same content for
every business, exempt from tenant RLS exactly like `knowledge_base_entries`
(0117) and documented in both `src/lib/tenant-tables.ts` and the
`tenant-isolation` integration test:

- `knowledge_categories` — the navigational tree (self-referencing
  `parent_id`, slug, title, icon, tone, sort order, `is_active`).
- `knowledge_tags` — cross-category labels (`slug`, `label`).
- `knowledge_articles` — the guides. `body_md` holds the markdown body;
  `section_keys text[]` maps an article to dashboard sections (the «آموزش»
  icon's deep link); `status` is `draft` | `published`; `search_tsv` is a
  generated `tsvector` ('simple' config — Persian needs tokenization, not
  stemming) weighted title/summary/body for full-text search.
- `knowledge_article_tags` — the article↔tag join.

Drafts are invisible to the member realm; authored rows keep
`created_by` / `updated_by` (seeded rows carry `seed:knowledge`).

## API surface

Member realm (tenant-scoped by login, read-only, published only):

- `GET /api/knowledge/catalogue` — categories, articles, tags for the hub.
- `GET /api/knowledge/search?q=…` — ranked full-text hits + snippets.
- `GET /api/knowledge/articles/[slug]` — one article with related reads.

Platform realm (guarded by `knowledge.manage`, full CRUD):

- `/api/platform/knowledge/categories`, `/tags`, `/articles` (+ `[id]`).

The older per-section learning link store (`/api/knowledge-base`, migration
0117) still feeds the per-page «آموزش» icon; the richer `section_keys`
mapping layered on top means the icon lands inside the new centre.

## Editing content day-to-day

`/platform/knowledge` has three tabs: **مقاله‌ها** (markdown editor with
live preview, searchable multi-select of all page-level KnowledgeHelpButton
destinations, tags, publish/draft), **دسته‌ها** (tree builder; deleting is refused
while children/articles exist), and **برچسب‌ها**.

A new article can link to any number of pages. The page registry is
`KNOWLEDGE_PAGES` in `src/lib/knowledge-base.ts`. Its stable
`page:/canonical/route` keys are stored in the existing
`knowledge_articles.section_keys` field. At runtime a help button resolves
its most specific page key and then falls back to the old section key, so
legacy articles and previously configured external learning URLs remain
readable. The old standalone **پیوند بخش‌ها** tab was removed from the
Superadmin UI; the legacy endpoint remains read-compatible. When adding a
new screen that mounts the help button, register its canonical route in
`KNOWLEDGE_PAGES` so operators can assign a guide to it.

## Seeding the starter content

```bash
npm run db:migrate        # applies 0131_*
npm run db:seed-knowledge # inserts categories/tags/45 articles (idempotent)
```

Source of truth for seeded content lives in the repo so it is reviewable:

- `scripts/knowledge-seed/content.ts` — the registry: categories, tags and
  per-article metadata (title, summary, category, section mapping, tags).
- `scripts/knowledge-seed/articles/*.md` — the bodies, one file per article.

`scripts/seed-knowledge.ts` validates the registry against the filesystem
(missing/extra files, duplicate slugs, articles without any `##` heading —
the reader's on-page anchors depend on those) and upserts everything by
slug inside one transaction, so re-running refreshes content in place.

To change seeded wording, edit the `.md`/registry and re-run the seed — or
edit in the console, which the seed then overwrites on its next run (the
registry is authoritative). Hand-written articles with slugs outside the
registry are never touched.
