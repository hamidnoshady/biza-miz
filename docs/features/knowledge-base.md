# مرکز آموزش (in-product knowledge base)

The learning centre inside the member dashboard (`/knowledge`, with `/dashboard/knowledge` kept as a redirect) plus
its editorial console in the super-admin area (`/platform/knowledge`). One
shared body of Persian content — 45 seeded guides covering every
member-facing corner of the platform — written so end users (صندوق‌دار،
گارسون، مدیر) can self-serve instead of calling support.

The super-admin console itself is deliberately *not* documented in the
member knowledge base; platform operators use this repo's `docs/` instead.

## Data model (migrations `0131_knowledge_base_content.sql` and `0233_knowledge_hardening.sql`)

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

Authored rows keep `created_by` / `updated_by` (seeded rows carry
`seed:knowledge`), and migration `0233_knowledge_hardening.sql` adds:

- `version` — the optimistic-concurrency token every console save sends back;
- `search_text` / rebuilt `search_tsv` — generated from `kb_normalize_search`
  (Arabic Yeh/Kaf, Persian and Arabic-Indic digits, diacritics, ZWNJ), so the
  same word typed either way finds the same article;
- a trigger that refuses a parent cycle at the database boundary;
- `(updated_at DESC, id DESC)` — the deterministic order the console pages in.

## Who sees what (member visibility policy)

The member realm only ever reads **published** articles. An article is visible
when it is published *and* either uncategorised or inside a category branch
whose every category is active; a category is visible when it is active and all
of its ancestors are active. That one definition is applied in SQL to the
catalogue, «latest», search, related reads, the per-page «آموزش» link and the
direct `GET /api/knowledge/articles/[slug]` lookup — so deactivating a branch in
the console hides its guides everywhere at once instead of leaving them
reachable by bookmark or search. Articles are *not* moved to «بدون دسته»: the
console keeps showing the real category (flagged «غیرفعال») and re-activating
the branch restores exactly the same rows. Drafts are never visible in the
member realm regardless of category state.

Category moves are checked by a recursive ancestor walk under a row lock and by
the `0233` trigger; a refused move (`category_cycle`, 409) changes nothing, and
deleting a category is refused while children (`category_has_children`) or
articles (`category_has_articles`) still point at it.

## API surface

Member realm (tenant-scoped by login, read-only, published + visible only):

- `GET /api/knowledge/catalogue` — categories, articles, tags for the hub.
- `GET /api/knowledge/search?q=…` — ranked full-text hits + snippets. `q` is
  capped at `KB_SEARCH_MAX_LENGTH` (200 → `400 query_too_long`) and `limit` is
  clamped to 1…50; the query is normalized before matching.
- `GET /api/knowledge/articles/[slug]` — one article with related reads.

Platform realm (guarded by `knowledge.manage`, full CRUD):

- `/api/platform/knowledge/categories`, `/tags`, `/articles` (+ `[id]`).

`GET /api/platform/knowledge/articles` accepts `q`, `status`, `category`, `tag`,
`section`, `page` and `limit` and returns
`{ articles, total, page, pageSize, totalPages }`. Page size defaults to 50
(max 100); the old hard-coded `LIMIT 200` is gone, so the 201st article is
reachable with the footer's «صفحهٔ قبل/بعد». `PUT …/articles/[id]` requires the
`version` the editor loaded (`expectedVersion`); a mismatch is
`409 version_conflict` and changes neither the row nor its tag links.

The older per-section learning link store (`/api/knowledge-base`, migration
0117) still feeds the per-page «آموزش» icon; the richer `section_keys`
mapping layered on top means the icon lands inside the new centre.

## Editing content day-to-day

`/platform/knowledge` has three tabs: **مقاله‌ها** (markdown editor with
live preview, searchable multi-select of all page-level KnowledgeHelpButton
destinations, tags, publish/draft), **دسته‌ها** (tree builder; deleting is refused
while children/articles exist), and **برچسب‌ها**.

A new article can link to any number of pages. Article + tag writes run in one
transaction with the referenced category/tag ids validated first, so an invalid
tag is `400 unknown_tag` and never leaves half-saved content. The editor keeps a
dirty baseline (close/Escape/refresh all confirm), shows «نسخهٔ تازه» on a 409
instead of silently overwriting, and exposes the same version to the list's
quick publish/unpublish action.

Media is validated on the way in and on the way out: a direct
`mp4`/`webm`/`ogg` file plays natively; YouTube (`watch?v=`/`youtu.be`),
Aparat (`videohash`) and Vimeo pages are converted to their embed URLs and
rendered in a sandboxed iframe with `referrerPolicy="strict-origin-when-cross-origin"`;
any other http(s) URL is not framed — it gets an explicit «باز کردن ویدیو در تب
جدید» card, so old content still works without creating a clickjacking surface.

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
npm run db:seed-knowledge                  # safe upsert
npm run db:seed-knowledge -- --dry-run     # report only; writes nothing
npm run db:seed-knowledge -- --overwrite   # restore the registry over edits
```

Source of truth for seeded content lives in the repo so it is reviewable:

- `scripts/knowledge-seed/content.ts` — the registry: categories, tags and
  per-article metadata (title, summary, category, section mapping, tags).
- `scripts/knowledge-seed/articles/*.md` — the bodies, one file per article.

`scripts/seed-knowledge.ts` validates the registry against the filesystem
(missing files, duplicate slugs, articles without any `##` heading — the
reader's on-page anchors depend on those) before touching the database. It then
plans each row (`src/lib/knowledge-seed-plan.ts`):

| row state | default rerun |
| --- | --- |
| missing | **insert** |
| created *and* last written by `seed:knowledge`, still published/active | **update** |
| created by someone else, or edited by hand | **skip** (`not-seed-owned` / `edited-by-hand`) |
| unpublished article or inactive category | **skip** (`unpublished` / `inactive`) |
| any seeded row, with `--overwrite` | **update** |

Every run prints a per-row report plus `kind:action` counts, and `--dry-run`
prints the same report and rolls back its own transaction. A console edit or an
unpublish therefore survives ordinary seed runs; only an explicit
`--overwrite` restores the registry. Hand-written articles with slugs outside
the registry are never touched.

## Auditing old section identities

`section_keys` predates the #936 page registry. To see which keys are current,
which are old and where they should point:

```bash
npm run db:audit-knowledge-sections              # from the seed registry
npm run db:audit-knowledge-sections -- --database # from a live database
```

The report classifies every key as `page` / `section` / `stale`, suggests the
canonical page for known aliases (`overview → page:/accounting/overview`,
`stock → inventory`), lists keys with no confident target (`ai` — the workspace
home has no learning page yet) and articles with no assignment at all. It is
read-only and never renames a key; the operator decides, either in the console
or by re-running the seed with `--overwrite` after fixing the registry.
