# Issue #938 — finishing `/knowledge` hardening (P1–P3)

**Branch** `arena/b3d247b9-biza-miz` · **baseline** `f172f87` (`main`, includes
#936) · **product area** the shared, platform-wide «مرکز آموزش» Knowledge
Center (`migrations/0131`, hardening in `migrations/0233`), not tenant AI/RAG
(#812) and not a re-do of #874.

Scope delivered: the P1 correctness defects, the P2 API/search/content defects
and the P3 editor/accessibility defects listed in the issue, with regression
tests for each. #938's acceptance criteria are listed in §5; the PR description
links back to this report so the issue can be closed with evidence.

---

## 1. P1 — data correctness

### 1.1 An article and its tags are written as one unit

*Before:* `adminCreateKbArticle`/`adminUpdateKbArticle` inserted/updated the
article with the plain `query()` helper, then `replaceArticleTags` deleted the
old links and inserted the new ones one row at a time. A bad tag id (or a
constraint failure on the third of five tags) left the article change committed
and the tag set half-written.

*After:* all article/category writes run inside
`kbWrite → withoutTenantScopeTransaction("platform", …)`, which pins one pool
client, `BEGIN`s, and rolls back on any error. `assertArticleInput` validates
the slug, title, order bounds, tag count, tag UUIDs/existence and category
existence **before** the article row is touched; the tag set is replaced with
one `INSERT … SELECT $1, unnest($2::uuid[])` statement.

Evidence:

- `src/lib/knowledge-service.ts` — `kbWrite`, `assertArticleInput`,
  `replaceArticleTags`.
- `src/lib/knowledge-service.test.ts` — “creates … inside one transaction”,
  “does not write the article when a tag id is unknown”, “propagates a
  tag-insert failure instead of reporting success” (single `tx` wrapper; no
  article write on validation failure), “returns 409 version_conflict and
  changes no tags when the version is stale”.
- `integration/knowledge-hardening.integration.test.ts` — “rolls the article
  insert back when the tag link insert fails” (temporary trigger raises on
  `knowledge_article_tags`; the article row is absent afterwards).

### 1.2 Category cycles are rejected without losing the category

*Before:* `assertKbParent` only compared `parentId === id`, so moving A under
its descendant C succeeded; the recursive tree builder then produced a
rootless loop and the whole branch silently disappeared from the member menu.

*After:*

- the move locks the row and the candidate parent (`ORDER BY id FOR UPDATE`),
  then a recursive CTE walks the parent chain to the root (with a 200-level
  guard) and rejects `category_cycle` when the moving category is an ancestor;
- migration `0233` adds `knowledge_categories_reject_cycle()` + trigger as the
  database boundary (23514), so a raw SQL writer or a concurrent move cannot
  create a loop;
- `buildKbCategoryTree` cuts a pre-existing loop edge and surfaces the orphan
  at the root instead of dropping it; `kbCategoryAncestors` has a visited set.

Evidence:

- `src/lib/knowledge-service.ts` — `assertKbParent`, `adminUpdateKbCategory`.
- `migrations/0233_knowledge_hardening.sql` — trigger.
- `src/lib/knowledge.test.ts` — cycle-safe tree/ancestor tests.
- `src/lib/knowledge-service.test.ts` — “refuses moving A below its descendant
  C” (no `UPDATE` issued), malformed parent id.
- `integration/…` — service move below a descendant and a raw `UPDATE … SET
  parent_id` both rejected; the three categories still exist with
  `A.parent_id = null`.

### 1.3 One documented inactive/draft visibility policy

Policy (now in `docs/knowledge-base.md`, §Who sees what):

> A category is visible when it is active **and** every ancestor is active. An
> article is visible when it is published **and** (uncategorised **or** in a
> visible category). Drafts are never visible to members.

*Before:* the catalogue filtered inactive categories in its own SQL, but the
article query, the direct slug lookup, search, «latest», related reads and the
per-page guide link did not — deactivating a branch left its articles reachable
by bookmark and search.

*After:* every member read starts with the same recursive
`visible_categories` CTE and `ARTICLE_IN_VISIBLE_CATEGORY` predicate.
Deactivating a category hides the branch everywhere; re-activating restores the
same rows. The console still shows the real category and its guides (nothing is
silently moved to «بدون دسته»).

Evidence:

- `src/lib/knowledge-service.ts` — `VISIBLE_CATEGORIES_CTE`,
  `listKbCatalogue`, `getKbArticleBySlug`, `searchKbArticles`, `listKbLatest`,
  `kbGuideForSection`.
- `src/lib/knowledge-service.test.ts` — selection/catalogue/slug/search use the
  CTE and the `a.category_id IS NULL OR …` predicate.
- `integration/…` — an article under a grandchild of an inactive leaf is
  absent from catalogue/search/latest/slug, then visible again after
  re-activation; uncategorised published articles stay visible while a draft
  stays hidden.

---

## 2. P2 — search, navigation and lifecycle

| Item | Fix | Evidence |
| --- | --- | --- |
| Search results race | `useKbSearch` keeps a monotonic request id, aborts the previous request on every change/unmount/clear, and only writes state for the current id while mounted. | `kb-nav.test.tsx` “ignores a stale response that resolves after a newer query”, “clears the timer and request on unmount”. |
| Endless search skeleton | failures render an explicit message + «تلاش دوباره»; `clear()` resets error/results/loading. | `kb-nav.test.tsx` failure/retry/clear tests. |
| Console list double fetch | one debounced `query` value drives a single effect; each request has its own `AbortController`; stale responses are ignored by id. | `src/app/platform/knowledge/kb-articles-panel.tsx` “filters.q is the draft … only `query` is in the fetch effect”. |
| Tag filter vs URL | `?tag=` is the source of truth (`useSearchParams` → `activeTag`); chips/clear call `router.push`; an unknown tag gets its own state card. | `kb-browser.tsx`; `kb-nav.test.tsx` clear/unknown/Back-Forward/catalogue-retry tests. |
| Heading deep links after async load | article view resolves `location.hash` against `kbHeadings` after the body renders (two rAFs), honours reduced motion and the sticky-header offset, re-scrolls on `hashchange`; `kbHeadingTargetForHash` now folds a fragment written from heading *text* (including combining hamza) to the rendered slug. | `kb-article.test.tsx`; `knowledge.test.ts` deep-link tests. |
| Active article hidden in a collapsed folder | the side menu opens the whole ancestor chain (`kbCategoryAncestors`) whenever the route/article changes. | `kb-nav.tsx` effect; `knowledge.test.ts` ancestor tests. |
| Silent `LIMIT 200` | `adminListKbArticles` returns `{articles,total,page,pageSize,totalPages}`; page/limit bounded (50 default, 100 max, offset ≤ 1e6); deterministic `(updated_at DESC, id DESC)`; console footer «صفحهٔ X از Y» + before/after. | `knowledge-service.test.ts` pagination tests; `integration/…` pages through three articles. |
| Persian normalization / body search | `normalizeKbSearchText` and SQL `kb_normalize_search` fold Arabic Yeh/Kaf, ة/ۀ/ۀ (U+06C0), Persian/Arabic-Indic digits, diacritics and ZWNJ; `search_text`/`search_tsv` are generated from the folded document; matching includes the body; route rejects `q > 200` and clamps `limit` 1–50. | `knowledge.test.ts`; `knowledge-service.test.ts` normalized-query test; `integration/…` “matches Arabic Yeh/Kaf, digits and ZWNJ variants”, “finds a phrase that only exists in the body”. |
| Media embeds | `kbVideoSource` accepts a direct `mp4/webm/ogg/mov/m4v` file or YouTube/Aparat/Vimeo only and converts to a known embed URL; `KbVideo` frames with `sandbox`, `referrerPolicy`, `loading=lazy`, always shows a new-tab link, and renders an external-link card for legacy arbitrary http(s) URLs (no iframe); non-http renders nothing. `parseArticleInput` stores any http(s) video URL (so a pre-hardening article stays editable) but rejects a non-http one, and rejects a non-http cover. The legacy help iframe is sandboxed too. | `knowledge.test.ts` `kbVideoKind`; `kb-markdown.test.tsx` native/YouTube/Aparat/Vimeo/random/javascript cases; `knowledge-service.test.ts` legacy-http video kept / `javascript:` rejected. |
| Seed overwrites editorial work | `planSeedArticle/Category/Tag` insert missing rows, update only untouched seed rows that are still published/active, skip hand-owned/edited/unpublished/inactive rows, and `--overwrite` restores the registry. `--dry-run` validates every file/slug/heading/reference and rolls back. Categories/tags carry real provenance (`updated_by`, migration 0233 §5) written by the console, the MCP tools and the seed, so an edit is detected from the last writer, never by comparing stored text with new registry values. | `knowledge-seed-plan.test.ts`; `scripts/seed-knowledge.ts`; docs table. |
| ACL / tenant boundary | member routes are `requireMember` only and read the platform catalogue; every console GET is `requirePlatformAdmin`, every POST/PUT/DELETE names `requirePlatformCapability("knowledge.manage")`; the four knowledge tables have no `business_id`/tenant column and no RLS policy. | `src/app/api/api-guards.test.ts` new knowledge guard test; `integration/…` tenant-boundary test. |
| Stale section identities | new read-only audit (`npm run db:audit-knowledge-sections [-- --database]`) classifies keys `page`/`section`/`stale`, suggests `overview → page:/accounting/overview` and `stock → inventory`, reports `ai` as unmapped (no learning page on «میز کار من») and lists unassigned articles. It never mutates rows. | `src/lib/knowledge-sections-audit.ts` + tests; script output in §4. |
| Console error text | `platform-errors.ts` now maps every console knowledge code (including `version_conflict`, `category_cycle`, `invalid_*`, `unknown_*`, `too_many_*`, `query_too_long`) to actionable Persian text instead of «خطای غیرمنتظره». | `platform-errors.test.ts` knowledge block. |

---

## 3. P3 — editor, drawer, retries, canonical URL

- **Unsaved changes / concurrent saves** (`kb-articles-panel.tsx`): the editor
  keeps a dirty baseline; Escape, the close button, backdrop click and
  `beforeunload` all confirm; saves send `expectedVersion`, a 409 shows
  «نسخهٔ تازه» with «بستن و بارگذاری نسخهٔ تازه»; the list's quick
  publish/unpublish sends the row version too. Backend increments `version`
  and returns it.
- **Phone drawer** (`kb-nav.tsx`): a real modal — focus moves to the close
  button, Tab/Shift+Tab wrap, Escape closes, body scroll is locked and focus
  returns to the opener (or the persistent toggle if the opener is gone).
- **Retry instead of endless skeletons**: member home catalogue, article
  catalogue, article body, sidebar search and both console panels now render a
  failure state with «تلاش دوباره»; category/tag toggles surface their own
  errors instead of reloading silently.
- **Canonical URL**: `LEGACY_PREFIX_MAP` in `src/lib/app-routes.ts` is the
  single owner of the `/dashboard/knowledge|guides|help → /knowledge` 308
  redirect (the duplicate block in `next.config.ts` was removed — two owners
  meant two places to drift, only one of them covered by the unit tests).
  `app-routes.test.ts` proves the tag query survives the redirect;
  `route-tree.test.ts` pins the real `/knowledge` and `/knowledge/a/[slug]`
  routes. All 45 seed articles, docs, README and page comments use
  `/knowledge`.
- **A11y**: headings keep their `h2–h4` level (the article title is the page
  `h1`, a `#` line in the body is not an `h1`), anchors/TOC share the same ids,
  images have explicit alt (decorative → empty), code/table scroll regions are
  keyboard focusable, and the drawer is `role="dialog" aria-modal`.

#936 is left intact: page assignments are still stored as
`page:/canonical/route` keys inside `knowledge_articles.section_keys`, the
multi-page picker and precise page-help resolution are unchanged, legacy
section keys still fall back, and there is still no standalone «پیوند بخش‌ها»
tab. The audit tooling only *reports* legacy keys.

---

## 4. Reproduction notes and evidence

Each row was reproduced against `f172f87` before the change (source-level
inspection of the paths named in the issue) and re-verified after:

- **Invalid tag partially persists** — create an article with one valid and
  one unknown tag: before, the article row existed (the insert was already
  committed); after, `adminCreateKbArticle` throws `unknown_tag` and no row with
  that slug exists (`knowledge-service.test.ts`, integration rollback test).
- **Cycle loses categories** — move a root under its grandchild: before, the
  update succeeded and `buildKbCategoryTree` returned an empty array; after,
  the service and the trigger both answer `category_cycle`, all three rows are
  intact and the tree still renders A → B → C.
- **Inactive branch leaks** — deactivate a leaf category, then open its
  article's slug/search/latest/help link: before, each still returned content;
  after, all return nothing until the category is active again.
- **Stale search** — type `ف` then `فروش` with the first response delayed:
  before, the late response could replace the newer hits; after, the first
  request is aborted and its response is ignored.
- **Double fetch** — typing in the console search issued one request per
  keystroke plus a debounced one; after, one debounced request per settled
  value.
- **Tag/URL drift** — navigating Back from `?tag=printing` left the chip
  applied; after, `useSearchParams` re-syncs `activeTag` and clearing pushes
  `/knowledge`.
- **Deep link after load** — `/knowledge/a/pos-basics#تسویهٔ-چندگانه` scrolled
  nowhere when the fragment was written from the heading text; after, it
  resolves to `تسویه-چندگانه` and scrolls once the body mounts.
- **201st article** — seeding 231 rows then opening the console: before, only
  200 rows and no count; after, `total = 231`, five pages, every row reachable.
- **Seed reversion** — unpublish a seeded article / edit a category from the
  console, then rerun the seed: before, both were overwritten; after, both are
  skipped and listed, and `--overwrite` is required to restore them.
- **Video host** — a random `https://example.com/clip` was framed; after, it is
  a new-tab card and only a known host/file renders a player.

### Gates actually run on this branch

| Gate | Command | Result |
| --- | --- | --- |
| Unit/component suite | `npx vitest run` | **964 files passed, 1 skipped; 12667 tests passed, 7 skipped** (506 s) |
| Focused #938 suite | `npx vitest run` on the knowledge tests + console route test + guards + route tree | **1288 passed** (13 files) |
| Typecheck | `NODE_OPTIONS=--max-old-space-size=4096 ./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **clean** (102 s) |
| Lint | `npm run lint` (`eslint . --max-warnings=0`) | **clean** |
| Section audit | `npm run db:audit-knowledge-sections` | 45 seed articles; 24 current section keys, 3 stale keys (`overview`, `stock`, `ai`); 6 articles without an assignment; no rows modified |
| DB integration | `DATABASE_URL=… npx vitest run --config vitest.db.config.ts integration/knowledge-hardening.integration.test.ts` | **15 passed** against a real local PostgreSQL 16 (embedded binaries). The suite grew the two review-driven cases (provenance of a console edit, U+06C0 query) and the 205-article pagination case; the rest of the ~250-file DB suite still runs only in the CI shards. |
| Production build | `npm run build` | **not verified locally** — the 3.9 GB sandbox was OOM-killed during Next's compile phase (heap 1.8 GB, then >2.5 GB, then kernel kill). This is an environment limit, not a TypeScript error; typecheck and lint are clean and CI has the release-build memory budget. |

---

## 4b. Review follow-ups (PR #1042, Codex P2 findings)

Each finding is fixed in the branch that the review covers, with the reason
recorded next to the code so a later reader does not undo it.

| # | Finding | Fix | Evidence |
| --- | --- | --- | --- |
| 1 | `parseArticleInput` refused every http(s) video that `kbVideoSource` does not recognise, so a pre-hardening article carrying such a link could not be saved — not even its title or body. | The editor now accepts any http(s) video URL and rejects only non-http values (`javascript:`, `file:` …). Framing is still allowlisted: `KbVideo` renders an unknown host as an explicit new-tab card, never an iframe. | `knowledge-service.test.ts` “keeps a legacy http(s) page as an external link …” + “rejects a non-http video URL”; `kb-markdown.test.tsx` random-host card. |
| 2 | The seed detected a hand-edited category/tag by comparing stored text with the *new* registry values, so a legitimate registry change looked like an editorial edit and was never applied — and an edit that restored the old wording looked untouched. | Real provenance: migration 0233 §5 adds `updated_by` to `knowledge_categories`/`knowledge_tags`, backfilled from `created_by`; the console routes, the MCP tools and the seed record the writer, and `planSeedCategory`/`planSeedTag` update only rows whose last writer is still `seed:knowledge`. | `knowledge-seed-plan.test.ts`; `integration/…` “records the console admin as the last writer …”; `scripts/seed-knowledge.ts`. |
| 3 | `kb_normalize_search` did not fold U+06C0 (ۀ, heh with yeh above), while the TypeScript twin did — the SQL search document and the query disagreed. | U+06C0 added to the `translate` source with a matching `ه` in the target. | `integration/…` “matches the precomposed heh with yeh above (U+06C0), like the TypeScript twin”; `knowledge.test.ts` normalization cases. |
| 4 | `/dashboard/knowledge` was redirected by two owners (the Next config *and* `LEGACY_PREFIX_MAP`), and `route-tree.test.ts` pinned the duplicate — two rules that can drift, one of them outside the unit tests. | The duplicate `next.config.ts` block is gone; `LEGACY_PREFIX_MAP` is the only owner, as AGENTS.md requires, so the redirect keeps the query string and is covered by the app-level test. | `app-routes.test.ts` `legacyRedirectTarget("/dashboard/knowledge", "?tag=printing")`; `route-tree.test.ts` now only pins the real routes. |

---

## 5. Acceptance criteria

1. **P1 scenarios reproduce/pass** — §1.1–1.3 and §4.
2. **#936 intact** — §3 closing paragraph; page-picker code untouched in the
   console panel, fallback resolution preserved, no standalone tab.
3. **No stale search/filter/skeleton/wrong tag; retries; deep links** — §2
   search/browser rows, §3 retries, `kb-nav.test.tsx`, `kb-article.test.tsx`.
4. **Every article reachable; edits/unpublished survive seeds** — pagination
   (§2) and seed plan (§2), integration pagination test.
5. **Media validates and fails safe; ACL/draft/tenant tests** — video row in
   §2, visibility/draft + tenant-boundary integration tests, guard test.
6. **Tests/typecheck/lint/build + reproduction notes** — §4 (build limitation
   stated explicitly). RTL/mobile checks are covered by the drawer/modal tests
   and the existing RTL class lint; no real-browser run is possible here.
