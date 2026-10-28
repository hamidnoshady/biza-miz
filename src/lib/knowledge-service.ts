/**
 * The in-product knowledge base — the database half.
 *
 * The four tables of migration 0131 (knowledge_categories, knowledge_tags,
 * knowledge_articles, knowledge_article_tags) are platform catalogues: no
 * business_id, one body of content that teaches every business. That makes
 * this service usable from both realms exactly the way knowledge-base.ts and
 * its 0117 store are:
 *
 *  - the tenant realm (`/api/knowledge/*`, already tenant-scoped by
 *    `withTenantScope`) reads **published** rows only through the `listKb*`
 *    functions — members learn; they never see drafts;
 *  - the platform realm (`/api/platform/knowledge/*`, guarded by
 *    `knowledge.manage`) writes through the `admin*` functions.
 *
 * Search runs on the stored `search_tsv` tsvector ('simple' config — Persian
 * wants tokenization, not stemming) with exact-match boosts on slug/title so
 * typing an article's exact words beats a incidental full-text hit.
 */
import { query, withoutTenantScopeTransaction } from "./db";
import {
  buildKbCategoryTree,
  isKbSlug,
  kbSnippet,
  kbVideoSource,
  KB_SEARCH_MAX_LENGTH,
  normalizeKbSearchText,
  normalizeSectionKeys,
  parseHttpUrl,
  stripMarkdown,
  type KbArticleDetail,
  type KbArticleListItem,
  type KbCategoryFlat,
  type KbSearchHit,
  type KbTagRef,
} from "./knowledge";
import type { KbVideoKind } from "./knowledge";

// ---------------------------------------------------------------------------
// Shared row shapes and mappers
// ---------------------------------------------------------------------------

type CategoryRow = {
  id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  description: string;
  icon: string;
  tone: string;
  sort_order: number;
  is_active?: boolean;
  article_count?: string | number | null;
};

type ArticleRow = {
  id: string;
  slug: string;
  category_id: string | null;
  section_keys: string[];
  title: string;
  summary: string;
  status?: string;
  body_md?: string;
  video_url?: string;
  cover_image_url?: string;
  sort_order: number;
  version?: number;
  published_at?: string | null;
  created_at?: string;
  updated_at: string;
};

type TagRow = {
  id: string;
  slug: string;
  label: string;
  description?: string;
  article_count?: string | number | null;
};

export interface KbCategoryRecord extends KbCategoryFlat {
  isActive: boolean;
  articleCount: number;
}

export interface KbTagRecord extends KbTagRef {
  id: string;
  description: string;
  articleCount: number;
}

export interface KbArticleRecord {
  id: string;
  slug: string;
  categoryId: string | null;
  sectionKeys: string[];
  title: string;
  summary: string;
  bodyMd: string;
  videoUrl: string;
  coverImageUrl: string;
  status: "draft" | "published";
  sortOrder: number;
  /** Optimistic concurrency token; increments on every save. */
  version: number;
  tagIds: string[];
  tagRefs: KbTagRef[];
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapCategory(row: CategoryRow): KbCategoryRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    icon: row.icon,
    tone: row.tone,
    sortOrder: row.sort_order,
    isActive: row.is_active ?? true,
    articleCount: Number(row.article_count ?? 0),
  };
}

function mapTag(row: TagRow): KbTagRecord {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    description: row.description ?? "",
    articleCount: Number(row.article_count ?? 0),
  };
}

function mapArticleListItem(
  row: ArticleRow,
  tagRefs: KbTagRef[],
): KbArticleListItem {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    categoryId: row.category_id,
    sectionKeys: row.section_keys ?? [],
    tags: tagRefs,
    hasVideo: Boolean(row.video_url),
    hasCover: Boolean(row.cover_image_url),
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Errors the routes translate into response codes
// ---------------------------------------------------------------------------

export class KnowledgeServiceError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** Every id the console sends is a uuid; validating up front yields a 400. */
const KB_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isKbUuid(value: string): boolean {
  return KB_UUID.test(value);
}

/** Escape LIKE wildcards so a query of "100%" searches for the literal text. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Bounds applied to console input, mirrored by `parseArticleInput`. */
export const KB_ARTICLE_LIMITS = {
  maxTags: 20,
  maxSectionKeys: 50,
  minSortOrder: -100_000,
  maxSortOrder: 100_000,
  maxBodyLength: 200_000,
  defaultPageSize: 50,
  maxPageSize: 100,
  maxOffset: 1_000_000,
} as const;

// ---------------------------------------------------------------------------
// Visibility policy (member reads)
// ---------------------------------------------------------------------------

/**
 * **Inactive categories hide their whole branch.**
 *
 * A category is visible to members when it is active *and* every ancestor is
 * active; an article is visible when it is published and either uncategorised
 * or in a visible category. That single recursive definition is used by the
 * catalogue, search, «latest», related reads, per-page help and the direct
 * article lookup, so hiding a category never leaves its articles reachable by
 * slug or by search. Articles are not silently moved to «بدون دسته»: their
 * category is editorial state the super-admin chose, and the console still
 * shows it (with `isActive: false`) so the branch can be re-enabled intact.
 *
 * Draft articles are never visible anywhere in the member realm, regardless
 * of category state.
 */
const VISIBLE_CATEGORIES_CTE = `
  WITH RECURSIVE visible_categories AS (
    SELECT id FROM knowledge_categories
     WHERE parent_id IS NULL AND is_active = true
    UNION ALL
    SELECT c.id
      FROM knowledge_categories c
      JOIN visible_categories v ON c.parent_id = v.id
     WHERE c.is_active = true
  )`;

/** SQL predicate for a member-visible article, given alias `a`. */
const ARTICLE_IN_VISIBLE_CATEGORY = `(a.category_id IS NULL OR a.category_id IN (SELECT id FROM visible_categories))`;

// ---------------------------------------------------------------------------
// Member reads (published only)
// ---------------------------------------------------------------------------

/** Everything «مرکز آموزش» needs for its side menu, cards and tag filter. */
export async function listKbCatalogue(): Promise<{
  categories: KbCategoryFlat[];
  articles: KbArticleListItem[];
  tags: KbTagRef[];
}> {
  const [{ rows: categories }, { rows: articles }, { rows: tags }, { rows: tagLinks }] =
    await Promise.all([
      query<CategoryRow & { is_active: boolean }>(
        `${VISIBLE_CATEGORIES_CTE}
         SELECT c.id, c.parent_id, c.slug, c.title, c.description, c.icon, c.tone,
                c.sort_order,
                (SELECT count(*) FROM knowledge_articles a
                  WHERE a.category_id = c.id AND a.status = 'published') AS article_count
           FROM knowledge_categories c
           JOIN visible_categories v ON v.id = c.id`,
      ),
      query<ArticleRow>(
        `${VISIBLE_CATEGORIES_CTE}
         SELECT a.id, a.slug, a.category_id, a.section_keys, a.title, a.summary,
                a.video_url, a.cover_image_url, a.sort_order, a.updated_at
           FROM knowledge_articles a
          WHERE a.status = 'published'
            AND ${ARTICLE_IN_VISIBLE_CATEGORY}`,
      ),
      query<TagRow>(
        `${VISIBLE_CATEGORIES_CTE}
         SELECT DISTINCT t.slug, t.label
           FROM knowledge_tags t
           JOIN knowledge_article_tags at ON at.tag_id = t.id
           JOIN knowledge_articles a ON a.id = at.article_id AND a.status = 'published'
          WHERE ${ARTICLE_IN_VISIBLE_CATEGORY}`,
      ),
      query<{ article_id: string; slug: string; label: string }>(
        `${VISIBLE_CATEGORIES_CTE}
         SELECT at.article_id, t.slug, t.label
           FROM knowledge_article_tags at
           JOIN knowledge_tags t ON t.id = at.tag_id
           JOIN knowledge_articles a ON a.id = at.article_id AND a.status = 'published'
          WHERE ${ARTICLE_IN_VISIBLE_CATEGORY}`,
      ),
    ]);

  const tagsByArticle = new Map<string, KbTagRef[]>();
  for (const link of tagLinks) {
    const list = tagsByArticle.get(link.article_id) ?? [];
    list.push({ slug: link.slug, label: link.label });
    tagsByArticle.set(link.article_id, list);
  }

  return {
    categories: categories.map((row) => mapCategory({ ...row, is_active: true })),
    articles: articles
      .map((row) => mapArticleListItem(row, tagsByArticle.get(row.id) ?? []))
      .sort(
        (a, b) =>
          (a.categoryId ?? "").localeCompare(b.categoryId ?? "") ||
          a.sortOrder - b.sortOrder ||
          b.updatedAt.localeCompare(a.updatedAt),
      ),
    tags: tags.map((t) => ({ slug: t.slug, label: t.label })),
  };
}

/** One published article plus its related reads (same category or a shared section). */
export async function getKbArticleBySlug(slug: string): Promise<KbArticleDetail | null> {
  const isUuid = KB_UUID.test(slug);
  const { rows } = await query<ArticleRow>(
    `${VISIBLE_CATEGORIES_CTE}
     SELECT a.id, a.slug, a.category_id, a.section_keys, a.title, a.summary, a.body_md,
            a.video_url, a.cover_image_url, a.sort_order, a.published_at, a.updated_at
       FROM knowledge_articles a
      WHERE a.status = 'published'
        AND (a.slug = $1 ${isUuid ? "OR a.id = $1::uuid" : ""})
        AND ${ARTICLE_IN_VISIBLE_CATEGORY}
      LIMIT 1`,
    [slug],
  );
  const row = rows[0];
  if (!row) return null;

  const [{ rows: tagRows }, { rows: relatedRows }] = await Promise.all([
    query<TagRow>(
      `SELECT t.slug, t.label
         FROM knowledge_article_tags at
         JOIN knowledge_tags t ON t.id = at.tag_id
        WHERE at.article_id = $1
        ORDER BY t.slug`,
      [row.id],
    ),
    query<ArticleRow>(
      `${VISIBLE_CATEGORIES_CTE}
       SELECT a.id, a.slug, a.category_id, a.section_keys, a.title, a.summary,
              a.video_url, a.cover_image_url, a.sort_order, a.updated_at
         FROM knowledge_articles a
        WHERE a.status = 'published'
          AND a.id <> $1
          AND (a.category_id = $2 OR a.section_keys && $3::text[])
          AND ${ARTICLE_IN_VISIBLE_CATEGORY}
        ORDER BY a.sort_order, a.updated_at DESC
        LIMIT 6`,
      [row.id, row.category_id, row.section_keys ?? []],
    ),
  ]);

  const tagRefs = tagRows.map((t) => ({ slug: t.slug, label: t.label }));
  const relatedTagIds = relatedRows.map((r) => r.id);
  const { rows: relatedTagRows } = relatedTagIds.length
    ? await query<{ article_id: string; slug: string; label: string }>(
        `SELECT at.article_id, t.slug, t.label
           FROM knowledge_article_tags at
           JOIN knowledge_tags t ON t.id = at.tag_id
          WHERE at.article_id = ANY($1::uuid[])`,
        [relatedTagIds],
      )
    : { rows: [] as { article_id: string; slug: string; label: string }[] };
  const relatedTagsByArticle = new Map<string, KbTagRef[]>();
  for (const link of relatedTagRows) {
    const list = relatedTagsByArticle.get(link.article_id) ?? [];
    list.push({ slug: link.slug, label: link.label });
    relatedTagsByArticle.set(link.article_id, list);
  }

  const videoKind: KbVideoKind | null = row.video_url ? (kbVideoSource(row.video_url)?.kind ?? null) : null;
  return {
    ...mapArticleListItem(row, tagRefs),
    bodyMd: row.body_md ?? "",
    videoUrl: row.video_url ?? "",
    videoKind,
    coverImageUrl: row.cover_image_url ?? "",
    publishedAt: row.published_at ?? null,
    related: relatedRows.map((r) =>
      mapArticleListItem(r, relatedTagsByArticle.get(r.id) ?? []),
    ),
  };
}

/**
 * Ranked full-text search over published, member-visible articles.
 *
 * The query and the stored document are folded by `normalizeKbSearchText` /
 * `kb_normalize_search` (Yeh/Kaf, digits, ZWNJ, diacritics), and the candidate
 * set matches title, summary, slug **and the normalized body** — so an article
 * whose summary exists still matches a phrase that appears only in its body.
 * Ranking boosts exact title/slug/summary hits above incidental body matches.
 *
 * `rawQuery` is clamped to `KB_SEARCH_MAX_LENGTH`; the route rejects longer
 * input with a 400, and this clamp keeps direct service callers safe too.
 */
export async function searchKbArticles(rawQuery: string, limit = 20): Promise<KbSearchHit[]> {
  const q = normalizeKbSearchText(rawQuery).slice(0, KB_SEARCH_MAX_LENGTH);
  if (!q) return [];
  const like = `%${escapeLike(q)}%`;
  const cappedLimit = Math.min(Math.max(Math.trunc(limit) || 1, 1), 50);
  const { rows } = await query<
    ArticleRow & { category_title: string | null; tag_slugs: string[] | null; rank: number }
  >(
    `${VISIBLE_CATEGORIES_CTE},
     terms AS (
       SELECT websearch_to_tsquery('simple', $1) AS tq
     )
     SELECT a.id, a.slug, a.category_id, a.section_keys, a.title, a.summary,
            a.video_url, a.cover_image_url, a.sort_order, a.updated_at,
            a.body_md,
            c.title AS category_title,
            (SELECT coalesce(array_agg(jsonb_build_object('slug', t.slug, 'label', t.label)), '{}')
               FROM knowledge_article_tags at JOIN knowledge_tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id) AS tag_slugs,
            (ts_rank(a.search_tsv, terms.tq)
             + (kb_normalize_search(a.title) LIKE $3 ESCAPE '\\')::int * 3
             + (a.slug ILIKE $3 ESCAPE '\\')::int * 2
             + (kb_normalize_search(a.summary) LIKE $3 ESCAPE '\\')::int
             + (a.search_text LIKE $3 ESCAPE '\\')::int * 0.5) AS rank
       FROM knowledge_articles a
       LEFT JOIN knowledge_categories c ON c.id = a.category_id
       CROSS JOIN terms
      WHERE a.status = 'published'
        AND ${ARTICLE_IN_VISIBLE_CATEGORY}
        AND (a.search_tsv @@ terms.tq
             OR kb_normalize_search(a.title) LIKE $3 ESCAPE '\\'
             OR kb_normalize_search(a.summary) LIKE $3 ESCAPE '\\'
             OR a.search_text LIKE $3 ESCAPE '\\'
             OR a.slug ILIKE $3 ESCAPE '\\')
      ORDER BY rank DESC, a.updated_at DESC
      LIMIT $2`,
    [q, cappedLimit, like],
  );

  return rows.map((row) => {
    const bodyText = stripMarkdown(row.body_md ?? "");
    const snippetSource = row.summary || bodyText;
    const tags = Array.isArray(row.tag_slugs)
      ? (row.tag_slugs as unknown as KbTagRef[])
      : [];
    return {
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      snippet: kbSnippet(snippetSource, q),
      categoryTitle: row.category_title,
      tags,
      updatedAt: row.updated_at,
    };
  });
}

/** The newest published, member-visible articles — the home page's «به‌روزترین‌ها». */
export async function listKbLatest(limit = 6): Promise<KbArticleListItem[]> {
  const { rows } = await query<ArticleRow>(
    `${VISIBLE_CATEGORIES_CTE}
     SELECT a.id, a.slug, a.category_id, a.section_keys, a.title, a.summary,
            a.video_url, a.cover_image_url, a.sort_order, a.updated_at
       FROM knowledge_articles a
      WHERE a.status = 'published'
        AND ${ARTICLE_IN_VISIBLE_CATEGORY}
      ORDER BY a.published_at DESC NULLS LAST, a.updated_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Math.trunc(limit) || 1, 1), 24)],
  );
  return rows.map((row) => mapArticleListItem(row, []));
}

/**
 * One learning guide per dashboard section — the «آموزش» icon's deep link.
 * Picks the article that claims the section, preferring its own ordering.
 * Hidden categories hide their guides here too, so the modal's in-app link
 * can never land on a 404.
 */
export async function kbGuideForSection(
  sectionKey: string,
): Promise<{ slug: string; title: string } | null> {
  const { rows } = await query<{ slug: string; title: string }>(
    `${VISIBLE_CATEGORIES_CTE}
     SELECT a.slug, a.title
       FROM knowledge_articles a
      WHERE a.status = 'published'
        AND $1 = ANY(a.section_keys)
        AND ${ARTICLE_IN_VISIBLE_CATEGORY}
      ORDER BY a.sort_order, a.updated_at DESC
      LIMIT 1`,
    [sectionKey],
  );
  return rows[0] ?? null;
}

/**
 * Other published guides in the same *exact* Knowledge category as the current guide.
 * This keeps a Products help modal within Products (not its parent Inventory
 * category), and works equally for POS, Inventory, and future sections.
 * A missing or inactive category returns nothing; draft articles never leak.
 */
export async function kbRelatedGuidesForArticle(
  slug: string,
): Promise<{ slug: string; title: string; summary: string; sectionKeys: string[] }[]> {
  const { rows } = await query<{ slug: string; title: string; summary: string; section_keys: string[] }>(
    `${VISIBLE_CATEGORIES_CTE}
     SELECT a.slug, a.title, a.summary, a.section_keys
       FROM knowledge_articles a
       JOIN knowledge_articles current ON current.slug = $1
      WHERE current.status = 'published'
        AND current.category_id IS NOT NULL
        AND current.category_id IN (SELECT id FROM visible_categories)
        AND a.category_id = current.category_id
        AND a.id <> current.id
        AND a.status = 'published'
        AND ${ARTICLE_IN_VISIBLE_CATEGORY}
      ORDER BY a.sort_order, a.title, a.id
      LIMIT 24`,
    [slug],
  );
  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    sectionKeys: row.section_keys ?? [],
  }));
}
// ---------------------------------------------------------------------------
// Platform writes (categories — the console's «دسته‌ساز»)
// ---------------------------------------------------------------------------

export interface KbCategoryInput {
  slug: string;
  title: string;
  description: string;
  icon: string;
  tone: string;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
}

/** Every category with its published-or-draft article count, for the builder. */
export async function adminListKbCategories(): Promise<KbCategoryRecord[]> {
  const { rows } = await query<CategoryRow>(
    `SELECT c.id, c.parent_id, c.slug, c.title, c.description, c.icon, c.tone,
            c.sort_order, c.is_active,
            (SELECT count(*) FROM knowledge_articles a WHERE a.category_id = c.id) AS article_count
       FROM knowledge_categories c`,
  );
  return rows.map(mapCategory);
}

/**
 * Platform-catalogue writes run in one transaction with the ambient `query()`
 * pinned to a single client, so a failed second statement rolls the first one
 * back. The four knowledge tables are platform catalogues (no tenant RLS);
 * `withoutTenantScopeTransaction` is the established console-write path.
 */
function kbWrite<T>(fn: () => Promise<T>): Promise<T> {
  return withoutTenantScopeTransaction("platform", fn);
}

export async function adminCreateKbCategory(input: KbCategoryInput, actor: string): Promise<string> {
  return kbWrite(async () => {
    await assertKbParent(input.parentId, null);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO knowledge_categories
         (parent_id, slug, title, description, icon, tone, sort_order, is_active,
          created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id`,
      [
        input.parentId,
        input.slug,
        input.title,
        input.description,
        input.icon,
        input.tone,
        input.sortOrder,
        input.isActive,
        actor,
      ],
    );
    return rows[0].id;
  });
}

export async function adminUpdateKbCategory(
  id: string,
  input: KbCategoryInput,
  actor: string,
): Promise<void> {
  // Reject malformed ids before the uuid[] lock query can raise 22P02.
  if (!KB_UUID.test(id)) throw new KnowledgeServiceError("not_found");
  if (input.parentId && !KB_UUID.test(input.parentId)) {
    throw new KnowledgeServiceError("parent_not_found");
  }
  await kbWrite(async () => {
    // Lock the category and its candidate parent in a deterministic order, so
    // two concurrent moves cannot deadlock and each sees the other's committed
    // parent chain. The precedence check below then rejects A→…→A.
    const lockIds = [...new Set([id, ...(input.parentId ? [input.parentId] : [])])].sort();
    await query(
      "SELECT id FROM knowledge_categories WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [lockIds],
    );
    await assertKbParent(input.parentId, id);
    const { rowCount } = await query(
      `UPDATE knowledge_categories
          SET parent_id = $2, slug = $3, title = $4, description = $5, icon = $6,
              tone = $7, sort_order = $8, is_active = $9, updated_by = $10,
              updated_at = now()
        WHERE id = $1`,
      [
        id,
        input.parentId,
        input.slug,
        input.title,
        input.description,
        input.icon,
        input.tone,
        input.sortOrder,
        input.isActive,
        actor,
      ],
    );
    if (!rowCount) throw new KnowledgeServiceError("not_found");
  });
}

/** Deleting is refused while children or articles still point at the category. */
export async function adminDeleteKbCategory(id: string): Promise<void> {
  await kbWrite(async () => {
    const { rowCount: exists } = await query(
      "SELECT 1 FROM knowledge_categories WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!exists) throw new KnowledgeServiceError("not_found");
    const { rowCount: children } = await query(
      "SELECT 1 FROM knowledge_categories WHERE parent_id = $1 LIMIT 1",
      [id],
    );
    if (children) throw new KnowledgeServiceError("category_has_children");
    const { rowCount: articles } = await query(
      "SELECT 1 FROM knowledge_articles WHERE category_id = $1 LIMIT 1",
      [id],
    );
    if (articles) throw new KnowledgeServiceError("category_has_articles");
    await query("DELETE FROM knowledge_categories WHERE id = $1", [id]);
  });
}

/**
 * A parent must exist and must not be the category itself or any descendant.
 *
 * The recursive walk carries its path so a pre-existing malformed loop in the
 * data cannot make the check itself spin forever, and stops at 200 levels.
 * Under `adminUpdateKbCategory` the two rows are already locked, so this is
 * race-free; migration 0233's trigger is the belt-and-braces database guard.
 */
async function assertKbParent(parentId: string | null, selfId: string | null): Promise<void> {
  if (!parentId) return;
  if (selfId && parentId === selfId) throw new KnowledgeServiceError("category_cycle");
  if (!KB_UUID.test(parentId)) throw new KnowledgeServiceError("parent_not_found");
  const { rows } = await query<{ existed: boolean; cycle: boolean }>(
    `WITH RECURSIVE chain AS (
       SELECT c.id, c.parent_id, ARRAY[c.id] AS path, 1 AS depth
         FROM knowledge_categories c
        WHERE c.id = $1
       UNION ALL
       SELECT c.id, c.parent_id, chain.path || c.id, chain.depth + 1
         FROM knowledge_categories c
         JOIN chain ON c.id = chain.parent_id
        WHERE NOT c.id = ANY(chain.path) AND chain.depth < 200
     )
     SELECT EXISTS (SELECT 1 FROM knowledge_categories WHERE id = $1) AS existed,
            EXISTS (SELECT 1 FROM chain WHERE id = $2) AS cycle`,
    [parentId, selfId],
  );
  if (!rows[0]?.existed) throw new KnowledgeServiceError("parent_not_found");
  if (selfId && rows[0]?.cycle) throw new KnowledgeServiceError("category_cycle");
}

// ---------------------------------------------------------------------------
// Platform writes (tags)
// ---------------------------------------------------------------------------

export async function adminListKbTags(): Promise<KbTagRecord[]> {
  const { rows } = await query<TagRow>(
    `SELECT t.id, t.slug, t.label, t.description,
            (SELECT count(*) FROM knowledge_article_tags at WHERE at.tag_id = t.id) AS article_count
       FROM knowledge_tags t
      ORDER BY t.slug`,
  );
  return rows.map(mapTag);
}

export interface KbTagInput {
  slug: string;
  label: string;
  description: string;
}

export async function adminCreateKbTag(input: KbTagInput, actor: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO knowledge_tags (slug, label, description, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $4) RETURNING id`,
    [input.slug, input.label, input.description, actor],
  );
  return rows[0].id;
}

export async function adminUpdateKbTag(
  id: string,
  input: KbTagInput,
  actor: string,
): Promise<void> {
  const { rowCount } = await query(
    `UPDATE knowledge_tags
        SET slug = $2, label = $3, description = $4, updated_by = $5
      WHERE id = $1`,
    [id, input.slug, input.label, input.description, actor],
  );
  if (!rowCount) throw new KnowledgeServiceError("not_found");
}

/** Deleting a tag only un-links it — articles themselves are untouched. */
export async function adminDeleteKbTag(id: string): Promise<void> {
  const { rowCount } = await query("DELETE FROM knowledge_tags WHERE id = $1", [id]);
  if (!rowCount) throw new KnowledgeServiceError("not_found");
}

// ---------------------------------------------------------------------------
// Platform writes (articles)
// ---------------------------------------------------------------------------

export interface KbArticleInput {
  slug: string;
  categoryId: string | null;
  sectionKeys: string[];
  title: string;
  summary: string;
  bodyMd: string;
  videoUrl: string;
  coverImageUrl: string;
  status: "draft" | "published";
  sortOrder: number;
  tagIds: string[];
}

export interface KbArticleFilters {
  q?: string;
  status?: "draft" | "published";
  categoryId?: string;
  section?: string;
  tagId?: string;
}

export interface KbArticlePage {
  articles: KbArticleRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface KbArticleListOptions {
  /** 1-based page number. */
  page?: number;
  /** Rows per page, clamped to 1…100. */
  limit?: number;
}

/**
 * The console's article list, paginated in SQL.
 *
 * The old `LIMIT 200` made the 201st (and every older) article unreachable
 * with no indication that more existed. Page + limit are bounded here, the
 * ordering is deterministic (`updated_at DESC, id DESC`), and the total count
 * travels with the page so the UI can render «صفحه ۲ از ۵».
 */
export async function adminListKbArticles(
  filters: KbArticleFilters,
  options: KbArticleListOptions = {},
): Promise<KbArticlePage> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };
  if (filters.q?.trim()) {
    // Same folding as member search, so a console search for «جستجوي» finds
    // the article written with «جستجوی». The body is included via search_text
    // (the editor's placeholder promises «عنوان و متن»).
    const p = params.length + 1;
    params.push(`%${escapeLike(normalizeKbSearchText(filters.q).slice(0, KB_SEARCH_MAX_LENGTH))}%`);
    where.push(
      `(a.search_text LIKE $${p} ESCAPE '\\' OR a.slug ILIKE $${p} ESCAPE '\\')`,
    );
  }
  if (filters.status === "draft" || filters.status === "published") {
    add("a.status = $?", filters.status);
  }
  if (filters.categoryId) {
    if (!KB_UUID.test(filters.categoryId)) throw new KnowledgeServiceError("invalid_category_id");
    add("a.category_id = $?::uuid", filters.categoryId);
  }
  if (filters.section) {
    // A section key is a registry key, never free text; bound its length so a
    // pathological query string cannot become a giant array comparison.
    add("$? = ANY(a.section_keys)", filters.section.slice(0, 160));
  }
  if (filters.tagId) {
    if (!KB_UUID.test(filters.tagId)) throw new KnowledgeServiceError("invalid_tag_id");
    add(
      "EXISTS (SELECT 1 FROM knowledge_article_tags at WHERE at.article_id = a.id AND at.tag_id = $?::uuid)",
      filters.tagId,
    );
  }

  const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit as number) : KB_ARTICLE_LIMITS.defaultPageSize;
  const pageSize = Math.min(Math.max(requestedLimit || KB_ARTICLE_LIMITS.defaultPageSize, 1), KB_ARTICLE_LIMITS.maxPageSize);
  const requestedPage = Number.isFinite(options.page) ? Math.trunc(options.page as number) : 1;
  const page = Math.max(requestedPage || 1, 1);
  const offset = Math.min((page - 1) * pageSize, KB_ARTICLE_LIMITS.maxOffset);

  const listParams = [...params, pageSize, offset];
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [{ rows }, { rows: countRows }] = await Promise.all([
    query<ArticleRow & { tag_ids: string[] | null }>(
      `SELECT a.id, a.slug, a.category_id, a.section_keys, a.title, a.summary,
              a.body_md, a.video_url, a.cover_image_url, a.status, a.sort_order,
              a.version, a.published_at, a.created_at, a.updated_at,
              (SELECT coalesce(array_agg(at.tag_id), '{}') FROM knowledge_article_tags at
                WHERE at.article_id = a.id) AS tag_ids
         FROM knowledge_articles a
         ${whereSql}
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      listParams,
    ),
    query<{ total: string | number }>(
      `SELECT count(*) AS total FROM knowledge_articles a ${whereSql}`,
      params,
    ),
  ]);

  const total = Number(countRows[0]?.total ?? 0);
  return {
    articles: rows.map(mapArticleRecord),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function adminGetKbArticle(id: string): Promise<KbArticleRecord | null> {
  const { rows } = await query<ArticleRow & { tag_ids: string[] | null }>(
    `SELECT a.id, a.slug, a.category_id, a.section_keys, a.title, a.summary,
            a.body_md, a.video_url, a.cover_image_url, a.status, a.sort_order,
            a.version, a.published_at, a.created_at, a.updated_at,
            (SELECT coalesce(array_agg(at.tag_id), '{}') FROM knowledge_article_tags at
              WHERE at.article_id = a.id) AS tag_ids
       FROM knowledge_articles a WHERE a.id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? mapArticleRecord(rows[0]) : null;
}

function mapArticleRecord(row: ArticleRow & { tag_ids: string[] | null }): KbArticleRecord {
  const rawIds = Array.isArray(row.tag_ids) ? row.tag_ids : [];
  return {
    id: row.id,
    slug: row.slug,
    categoryId: row.category_id,
    sectionKeys: row.section_keys ?? [],
    title: row.title,
    summary: row.summary,
    bodyMd: row.body_md ?? "",
    videoUrl: row.video_url ?? "",
    coverImageUrl: row.cover_image_url ?? "",
    status: row.status === "published" ? "published" : "draft",
    sortOrder: row.sort_order,
    version: Number(row.version ?? 1),
    tagIds: rawIds.map(String),
    tagRefs: [],
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at ?? row.updated_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Everything a write must know before touching an article: a slug/title that
 * can be stored, bounded ordering, UUID-shaped references that actually exist,
 * and a tag set within limits. Running this *before* the insert/update means a
 * bad tag id is a 400 (`unknown_tag`) instead of a foreign-key 500 after the
 * article row already changed.
 */
async function assertArticleInput(input: KbArticleInput): Promise<void> {
  if (!isKbSlug(input.slug)) throw new KnowledgeServiceError("invalid_slug");
  if (!input.title.trim()) throw new KnowledgeServiceError("missing_title");
  if (
    !Number.isFinite(input.sortOrder) ||
    input.sortOrder < KB_ARTICLE_LIMITS.minSortOrder ||
    input.sortOrder > KB_ARTICLE_LIMITS.maxSortOrder
  ) {
    throw new KnowledgeServiceError("invalid_sort_order");
  }
  if (input.tagIds.length > KB_ARTICLE_LIMITS.maxTags) {
    throw new KnowledgeServiceError("too_many_tags");
  }
  if (input.sectionKeys.length > KB_ARTICLE_LIMITS.maxSectionKeys) {
    throw new KnowledgeServiceError("too_many_section_keys");
  }
  if (input.categoryId) {
    if (!KB_UUID.test(input.categoryId)) throw new KnowledgeServiceError("invalid_category_id");
    const { rowCount } = await query("SELECT 1 FROM knowledge_categories WHERE id = $1", [
      input.categoryId,
    ]);
    if (!rowCount) throw new KnowledgeServiceError("unknown_category");
  }
  if (input.tagIds.length) {
    const unique = [...new Set(input.tagIds)];
    if (unique.some((tagId) => !KB_UUID.test(tagId))) {
      throw new KnowledgeServiceError("invalid_tag_id");
    }
    const { rows } = await query<{ id: string }>(
      "SELECT id FROM knowledge_tags WHERE id = ANY($1::uuid[])",
      [unique],
    );
    if (rows.length !== unique.length) throw new KnowledgeServiceError("unknown_tag");
  }
}

export async function adminCreateKbArticle(input: KbArticleInput, actor: string): Promise<string> {
  return kbWrite(async () => {
    await assertArticleInput(input);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO knowledge_articles
         (slug, category_id, section_keys, title, summary, body_md, video_url,
          cover_image_url, status, sort_order, published_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               CASE WHEN $9 = 'published' THEN now() ELSE NULL END, $11, $11)
       RETURNING id`,
      [
        input.slug,
        input.categoryId,
        input.sectionKeys,
        input.title,
        input.summary,
        input.bodyMd,
        input.videoUrl,
        input.coverImageUrl,
        input.status,
        input.sortOrder,
        actor,
      ],
    );
    await replaceArticleTags(rows[0].id, input.tagIds);
    return rows[0].id;
  });
}

/**
 * Save an article and its tag links as one unit.
 *
 * `expectedVersion` is the `version` the editor loaded. When supplied, the
 * update matches only that version; a concurrent save makes this one affect
 * no row and the caller gets `version_conflict` (409) instead of silently
 * overwriting the other editor's work. Omitting it keeps the previous
 * last-write-wins behaviour for internal callers (none today; the console
 * always sends it).
 *
 * Returns the new version so the editor can keep saving without a reload.
 */
export async function adminUpdateKbArticle(
  id: string,
  input: KbArticleInput,
  actor: string,
  expectedVersion?: number | null,
): Promise<number> {
  return kbWrite(async () => {
    await assertArticleInput(input);
    // published_at records the first publish only; later republishes leave it.
    const { rows } = await query<{ version: number }>(
      `UPDATE knowledge_articles
          SET slug = $2, category_id = $3, section_keys = $4, title = $5, summary = $6,
              body_md = $7, video_url = $8, cover_image_url = $9, status = $10,
              sort_order = $11, updated_by = $12, updated_at = now(),
              version = version + 1,
              published_at = CASE
                WHEN $10 = 'published' THEN coalesce(published_at, now())
                ELSE published_at END
        WHERE id = $1
          AND ($13::int IS NULL OR version = $13::int)
        RETURNING version`,
      [
        id,
        input.slug,
        input.categoryId,
        input.sectionKeys,
        input.title,
        input.summary,
        input.bodyMd,
        input.videoUrl,
        input.coverImageUrl,
        input.status,
        input.sortOrder,
        actor,
        expectedVersion ?? null,
      ],
    );
    if (!rows[0]) {
      const { rowCount } = await query("SELECT 1 FROM knowledge_articles WHERE id = $1", [id]);
      throw new KnowledgeServiceError(rowCount ? "version_conflict" : "not_found");
    }
    await replaceArticleTags(id, input.tagIds);
    return Number(rows[0].version);
  });
}

export async function adminDeleteKbArticle(id: string): Promise<void> {
  const { rowCount } = await query("DELETE FROM knowledge_articles WHERE id = $1", [id]);
  if (!rowCount) throw new KnowledgeServiceError("not_found");
}

/**
 * Replace an article's tag set. Must run inside the article's transaction —
 * every caller does — so a failed insert rolls the article change back too.
 * Ids are pre-validated by `assertArticleInput`; the guard here keeps a future
 * caller from reaching Postgres with malformed input.
 */
async function replaceArticleTags(articleId: string, tagIds: string[]): Promise<void> {
  const unique = [...new Set(tagIds)];
  if (unique.length > KB_ARTICLE_LIMITS.maxTags) {
    throw new KnowledgeServiceError("too_many_tags");
  }
  if (unique.some((tagId) => !KB_UUID.test(tagId))) {
    throw new KnowledgeServiceError("invalid_tag_id");
  }
  await query("DELETE FROM knowledge_article_tags WHERE article_id = $1", [articleId]);
  if (unique.length) {
    await query(
      `INSERT INTO knowledge_article_tags (article_id, tag_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [articleId, unique],
    );
  }
}

/** Re-exported: the console and member tree UIs share the same nesting rules. */
export { buildKbCategoryTree };

// ---------------------------------------------------------------------------
// Request parsing + error mapping shared by the platform knowledge routes
// (kept out of route.ts files, which may only export HTTP method handlers)
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

export function parseCategoryInput(raw: unknown):
  | { ok: true; input: KbCategoryInput }
  | { ok: false; error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const str = (key: string, max: number) =>
    typeof body[key] === "string" ? (body[key] as string).trim().slice(0, max) : "";

  const slug = str("slug", 120).toLowerCase();
  if (!isKbSlug(slug)) return { ok: false, error: "invalid_slug" };
  const title = str("title", 200);
  if (!title) return { ok: false, error: "missing_title" };
  const parentRaw = typeof body.parentId === "string" ? body.parentId.trim() : "";
  if (parentRaw && !KB_UUID.test(parentRaw)) {
    return { ok: false, error: "invalid_parent_id" };
  }
  const sortOrder =
    typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)
      ? Math.trunc(body.sortOrder)
      : 0;
  if (
    sortOrder < KB_ARTICLE_LIMITS.minSortOrder ||
    sortOrder > KB_ARTICLE_LIMITS.maxSortOrder
  ) {
    return { ok: false, error: "invalid_sort_order" };
  }
  return {
    ok: true,
    input: {
      slug,
      title,
      description: str("description", 1000),
      icon: str("icon", 40),
      tone: str("tone", 20),
      parentId: parentRaw || null,
      sortOrder,
      isActive: body.isActive !== false,
    },
  };
}

export function parseTagInput(raw: unknown): { ok: true; input: KbTagInput } | { ok: false; error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const str = (key: string, max: number) =>
    typeof body[key] === "string" ? (body[key] as string).trim().slice(0, max) : "";
  const slug = str("slug", 120).toLowerCase();
  if (!isKbSlug(slug)) return { ok: false, error: "invalid_slug" };
  const label = str("label", 200);
  if (!label) return { ok: false, error: "missing_label" };
  return { ok: true, input: { slug, label, description: str("description", 500) } };
}

export function parseArticleInput(
  raw: unknown,
  knownSectionKeys: ReadonlySet<string>,
): { ok: true; input: KbArticleInput } | { ok: false; error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const str = (key: string, max: number) =>
    typeof body[key] === "string" ? (body[key] as string).trim().slice(0, max) : "";

  const slug = str("slug", 160).toLowerCase();
  if (!isKbSlug(slug)) return { ok: false, error: "invalid_slug" };
  const title = str("title", 300);
  if (!title) return { ok: false, error: "missing_title" };

  const videoUrl = str("videoUrl", 2000);
  const coverImageUrl = str("coverImageUrl", 2000);
  // A non-http value is never storable. Any http(s) URL is accepted: only a
  // direct file or a known host (see `kbVideoSource`) is *framed*; anything
  // else renders as an explicit external-link card in `KbVideo`. Refusing
  // arbitrary http(s) here would make every pre-hardening article that still
  // carries such a link uneditable — including edits to its title or body.
  if (videoUrl && !parseHttpUrl(videoUrl)) return { ok: false, error: "invalid_video_url" };
  if (coverImageUrl && !parseHttpUrl(coverImageUrl)) {
    return { ok: false, error: "invalid_cover_url" };
  }

  const categoryId = str("categoryId", 64) || null;
  if (categoryId && !KB_UUID.test(categoryId)) {
    return { ok: false, error: "invalid_category_id" };
  }
  const status = body.status === "published" ? ("published" as const) : ("draft" as const);

  if (body.tagIds !== undefined && !Array.isArray(body.tagIds)) {
    return { ok: false, error: "invalid_tag_id" };
  }
  const rawTags = Array.isArray(body.tagIds) ? body.tagIds : [];
  if (rawTags.some((tag) => typeof tag !== "string")) {
    return { ok: false, error: "invalid_tag_id" };
  }
  const tagIds = [...new Set((rawTags as string[]).map((tag) => tag.trim()).filter(Boolean))];
  if (tagIds.length > KB_ARTICLE_LIMITS.maxTags) {
    return { ok: false, error: "too_many_tags" };
  }
  if (tagIds.some((tagId) => !KB_UUID.test(tagId))) {
    return { ok: false, error: "invalid_tag_id" };
  }

  const sortOrder =
    typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)
      ? Math.trunc(body.sortOrder)
      : 0;
  if (
    sortOrder < KB_ARTICLE_LIMITS.minSortOrder ||
    sortOrder > KB_ARTICLE_LIMITS.maxSortOrder
  ) {
    return { ok: false, error: "invalid_sort_order" };
  }

  return {
    ok: true,
    input: {
      slug,
      categoryId,
      sectionKeys: normalizeSectionKeys(body.sectionKeys, knownSectionKeys),
      title,
      summary: str("summary", 1000),
      bodyMd:
        typeof body.bodyMd === "string"
          ? body.bodyMd.slice(0, KB_ARTICLE_LIMITS.maxBodyLength)
          : "",
      videoUrl,
      coverImageUrl,
      status,
      sortOrder,
      tagIds,
    },
  };
}

const KNOWLEDGE_BAD_REQUEST = new Set([
  "invalid_slug",
  "missing_title",
  "missing_label",
  "invalid_parent_id",
  "invalid_category_id",
  "invalid_tag_id",
  "invalid_sort_order",
  "invalid_video_url",
  "invalid_cover_url",
  "invalid_data",
  "too_many_tags",
  "too_many_section_keys",
  "unknown_category",
  "unknown_tag",
  "bad_request",
  "query_too_long",
]);

const KNOWLEDGE_NOT_FOUND = new Set(["not_found", "parent_not_found"]);

const KNOWLEDGE_CONFLICT = new Set([
  "category_cycle",
  "category_has_children",
  "category_has_articles",
  "version_conflict",
  "conflict",
  "unknown_reference",
]);

/** Map a service error (or a Postgres constraint violation) to an API response. */
export function knowledgeError(err: unknown): NextResponse {
  if (err instanceof KnowledgeServiceError) {
    const status = KNOWLEDGE_BAD_REQUEST.has(err.code)
      ? 400
      : KNOWLEDGE_NOT_FOUND.has(err.code)
        ? 404
        : KNOWLEDGE_CONFLICT.has(err.code)
          ? 409
          : 500;
    if (status === 500) console.error("knowledge route failed", err);
    return NextResponse.json({ error: err.code }, { status });
  }
  const code =
    typeof err === "object" && err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "";
  if (code === "23505") {
    return NextResponse.json({ error: "slug_taken" }, { status: 409 });
  }
  if (code === "23503") {
    // A referenced category/tag disappeared between validation and the write.
    return NextResponse.json({ error: "unknown_reference" }, { status: 409 });
  }
  if (code === "23514") {
    const message = String((err as { message?: unknown }).message ?? "");
    if (message.includes("knowledge_category_cycle")) {
      return NextResponse.json({ error: "category_cycle" }, { status: 409 });
    }
    return NextResponse.json({ error: "invalid_data" }, { status: 400 });
  }
  if (code === "22P02") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  console.error("knowledge route failed", err);
  return NextResponse.json({ error: "unexpected" }, { status: 500 });
}
