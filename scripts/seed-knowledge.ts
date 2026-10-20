/**
 * Seeds the in-product knowledge base (migration 0131): the category tree,
 * the tag set and ~45 Persian guides covering every member-facing corner of
 * the platform (the super-admin console is deliberately not documented here).
 *
 * **Editorial safety (issue #938).** Re-running this script is idempotent, but
 * it is no longer authoritative over rows an operator has changed. A row is
 * updated only when it is still seed-owned (created *and* last written by
 * `seed:knowledge`) and still published/active; hand-edited, unpublished or
 * deactivated rows are skipped and listed in the report. `--overwrite`
 * deliberately restores the registry content for every seeded row.
 *
 * Usage:
 *   npm run db:seed-knowledge                 # safe upsert
 *   npm run db:seed-knowledge -- --dry-run    # report only, writes nothing
 *   npm run db:seed-knowledge -- --overwrite  # force registry content back
 *
 * Article bodies live in ./knowledge-seed/articles/*.md; metadata in
 * ./knowledge-seed/content.ts. Rows created here carry created_by =
 * 'seed:knowledge', which is also how the console tells seeded content from
 * hand-written guides.
 */
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { kbHeadings } from "../src/lib/knowledge";
import {
  SEED_ACTOR,
  planSeedArticle,
  planSeedCategory,
  planSeedTag,
  seedDecisionLabel,
  type SeedDecision,
} from "../src/lib/knowledge-seed-plan";
import {
  SEED_ARTICLES,
  SEED_CATEGORIES,
  SEED_TAGS,
  type SeedArticle,
} from "./knowledge-seed/content";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTICLES_DIR = join(HERE, "knowledge-seed", "articles");
const ACTOR = SEED_ACTOR;

type ReportKind = "category" | "tag" | "article";
interface ReportRow {
  kind: ReportKind;
  slug: string;
  decision: SeedDecision;
}

function readBody(article: SeedArticle): string {
  const path = join(ARTICLES_DIR, article.file);
  return readFileSync(path, "utf8").trim();
}

function parseArgs(argv: string[]): { dryRun: boolean; overwrite: boolean } {
  const known = new Set(["--dry-run", "--overwrite", "--force", "--help"]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(", ")}`);
    console.error("Usage: seed-knowledge [--dry-run] [--overwrite|--force]");
    process.exit(2);
  }
  if (argv.includes("--help")) {
    console.log("Usage: seed-knowledge [--dry-run] [--overwrite|--force]");
    console.log("  --dry-run   report what would change and write nothing");
    console.log("  --overwrite restore registry content even over hand edits/drafts");
    process.exit(0);
  }
  return {
    dryRun: argv.includes("--dry-run"),
    overwrite: argv.includes("--overwrite") || argv.includes("--force"),
  };
}

function printReport(rows: ReportRow[]): void {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const row of rows) {
    bump(`${row.kind}:${row.decision.action}`);
    if (row.decision.action === "skip") {
      console.log(`  - ${row.kind} «${row.slug}»: ${seedDecisionLabel(row.decision)}`);
    }
  }
  const summary = [...counts.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  console.log(summary || "nothing to do");
}

async function main() {
  const { dryRun, overwrite } = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  // Fail fast on registry/filesystem drift before touching the database.
  const files = new Set(readdirSync(ARTICLES_DIR));
  const slugs = new Set<string>();
  for (const article of SEED_ARTICLES) {
    if (!files.has(article.file)) {
      console.error(`Missing article file: knowledge-seed/articles/${article.file}`);
      process.exit(1);
    }
    if (slugs.has(article.slug)) {
      console.error(`Duplicate article slug in registry: ${article.slug}`);
      process.exit(1);
    }
    slugs.add(article.slug);
    const headings = kbHeadings(readBody(article));
    if (headings.length === 0) {
      console.error(`Article ${article.slug} has no ## headings — anchors need them.`);
      process.exit(1);
    }
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const report: ReportRow[] = [];

  try {
    await client.query("BEGIN");
    // Platform catalogue tables (no RLS), but connecting as the app role is
    // still a superuser-safety concern — grant bypass harmlessly.
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    console.log(
      `Knowledge seed${dryRun ? " (dry run)" : ""}${overwrite ? " (--overwrite)" : ""}`,
    );

    // Existing rows carry the editorial state the plan needs. -----------------
    const { rows: existingCategories } = await client.query<{
      id: string;
      slug: string;
      created_by: string;
      is_active: boolean;
      title: string;
      description: string;
      icon: string;
      tone: string;
      sort_order: number;
    }>(
      `SELECT id, slug, created_by, is_active, title, description, icon, tone, sort_order
         FROM knowledge_categories`,
    );
    const { rows: existingTags } = await client.query<{
      id: string;
      slug: string;
      created_by: string;
      label: string;
      description: string;
    }>("SELECT id, slug, created_by, label, description FROM knowledge_tags");
    const { rows: existingArticles } = await client.query<{
      id: string;
      slug: string;
      created_by: string;
      updated_by: string;
      status: string;
    }>("SELECT id, slug, created_by, updated_by, status FROM knowledge_articles");

    const categoryBySlug = new Map(existingCategories.map((row) => [row.slug, row]));
    const tagBySlug = new Map(existingTags.map((row) => [row.slug, row]));
    const articleBySlug = new Map(existingArticles.map((row) => [row.slug, row]));

    // 1) Categories ----------------------------------------------------------
    const categoryIdBySlug = new Map<string, string>();
    for (const cat of SEED_CATEGORIES) {
      const existing = categoryBySlug.get(cat.slug) ?? null;
      const categoryEdited = Boolean(
        existing &&
          (existing.title !== cat.title ||
            existing.description !== cat.description ||
            existing.icon !== cat.icon ||
            existing.tone !== cat.tone ||
            existing.sort_order !== cat.sortOrder),
      );
      const decision = planSeedCategory(
        existing
          ? {
              createdBy: existing.created_by,
              isActive: existing.is_active,
              edited: categoryEdited,
            }
          : null,
        { overwrite },
      );
      report.push({ kind: "category", slug: cat.slug, decision });
      if (dryRun) {
        // Resolve *would-be* ids too: a dry run on a fresh database must still
        // be able to validate every article's category reference.
        categoryIdBySlug.set(cat.slug, existing?.id ?? `dry-run:${cat.slug}`);
        continue;
      }
      if (decision.action === "insert") {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO knowledge_categories
             (slug, title, description, icon, tone, sort_order, is_active, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id`,
          [cat.slug, cat.title, cat.description, cat.icon, cat.tone, cat.sortOrder, ACTOR],
        );
        if (rows[0]) categoryIdBySlug.set(cat.slug, rows[0].id);
        else {
          // A concurrent run inserted it between the read and the write.
          const { rows: found } = await client.query<{ id: string }>(
            "SELECT id FROM knowledge_categories WHERE slug = $1",
            [cat.slug],
          );
          if (found[0]) categoryIdBySlug.set(cat.slug, found[0].id);
        }
      } else if (decision.action === "update" && existing) {
        await client.query(
          `UPDATE knowledge_categories
              SET title = $2, description = $3, icon = $4, tone = $5,
                  sort_order = $6, is_active = true, updated_at = now()
            WHERE id = $1`,
          [existing.id, cat.title, cat.description, cat.icon, cat.tone, cat.sortOrder],
        );
        categoryIdBySlug.set(cat.slug, existing.id);
      } else if (existing) {
        // Preserve an editor's category; articles below still resolve to it.
        categoryIdBySlug.set(cat.slug, existing.id);
      }
    }

    // 2) Tags ----------------------------------------------------------------
    const tagIdBySlug = new Map<string, string>();
    for (const tag of SEED_TAGS) {
      const existing = tagBySlug.get(tag.slug) ?? null;
      const tagEdited = Boolean(
        existing &&
          (existing.label !== tag.label || existing.description !== tag.description),
      );
      const decision = planSeedTag(
        existing ? { createdBy: existing.created_by, edited: tagEdited } : null,
        { overwrite },
      );
      report.push({ kind: "tag", slug: tag.slug, decision });
      if (dryRun) {
        tagIdBySlug.set(tag.slug, existing?.id ?? `dry-run:${tag.slug}`);
        continue;
      }
      if (decision.action === "insert") {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO knowledge_tags (slug, label, description, created_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id`,
          [tag.slug, tag.label, tag.description, ACTOR],
        );
        if (rows[0]) tagIdBySlug.set(tag.slug, rows[0].id);
        else {
          const { rows: found } = await client.query<{ id: string }>(
            "SELECT id FROM knowledge_tags WHERE slug = $1",
            [tag.slug],
          );
          if (found[0]) tagIdBySlug.set(tag.slug, found[0].id);
        }
      } else if (decision.action === "update" && existing) {
        await client.query(
          "UPDATE knowledge_tags SET label = $2, description = $3 WHERE id = $1",
          [existing.id, tag.label, tag.description],
        );
        tagIdBySlug.set(tag.slug, existing.id);
      } else if (existing) {
        tagIdBySlug.set(tag.slug, existing.id);
      }
    }

    // 3) Articles ------------------------------------------------------------
    for (const article of SEED_ARTICLES) {
      const existing = articleBySlug.get(article.slug) ?? null;
      const decision = planSeedArticle(
        existing
          ? {
              createdBy: existing.created_by,
              updatedBy: existing.updated_by,
              status: existing.status,
            }
          : null,
        { overwrite },
      );
      report.push({ kind: "article", slug: article.slug, decision });

      // Validate references for every article, including a dry run and a row
      // the plan will skip: a registry typo should fail the run, not surface
      // later as a silent missing category/tag on one guide.
      const categoryId = categoryIdBySlug.get(article.category) ?? null;
      if (article.category && !categoryId) {
        throw new Error(`Unknown category slug '${article.category}' for article ${article.slug}`);
      }
      const tagIds: string[] = [];
      for (const tagSlug of article.tagSlugs) {
        const tagId = tagIdBySlug.get(tagSlug);
        if (!tagId) throw new Error(`Unknown tag slug '${tagSlug}' for article ${article.slug}`);
        tagIds.push(tagId);
      }
      if (dryRun || decision.action === "skip") continue;

      const body = readBody(article);

      let articleId: string;
      if (decision.action === "insert") {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO knowledge_articles
             (slug, category_id, section_keys, title, summary, body_md, status,
              sort_order, published_at, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   CASE WHEN $7 = 'published' THEN now() ELSE NULL END, $9, $9)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id`,
          [
            article.slug,
            categoryId,
            article.sectionKeys,
            article.title,
            article.summary,
            body,
            article.status,
            article.sortOrder,
            ACTOR,
          ],
        );
        if (!rows[0]) {
          // Concurrent insert: fall through to an update of that row only if
          // it is seed-owned by the time we see it.
          const { rows: found } = await client.query<{ id: string; created_by: string }>(
            "SELECT id, created_by FROM knowledge_articles WHERE slug = $1",
            [article.slug],
          );
          if (!found[0] || found[0].created_by !== ACTOR) continue;
          articleId = found[0].id;
        } else {
          articleId = rows[0].id;
        }
      } else {
        articleId = existing!.id;
        await client.query(
          `UPDATE knowledge_articles
              SET category_id = $2, section_keys = $3, title = $4, summary = $5,
                  body_md = $6, status = $7, sort_order = $8,
                  updated_by = $9, updated_at = now(), version = version + 1,
                  published_at = CASE
                    WHEN $7 = 'published' THEN coalesce(published_at, now())
                    ELSE published_at END
            WHERE id = $1`,
          [
            articleId,
            categoryId,
            article.sectionKeys,
            article.title,
            article.summary,
            body,
            article.status,
            article.sortOrder,
            ACTOR,
          ],
        );
      }

      await client.query("DELETE FROM knowledge_article_tags WHERE article_id = $1", [articleId]);
      if (tagIds.length) {
        await client.query(
          `INSERT INTO knowledge_article_tags (article_id, tag_id)
           SELECT $1, unnest($2::uuid[])
           ON CONFLICT DO NOTHING`,
          [articleId, tagIds],
        );
      }
    }

    if (dryRun) await client.query("ROLLBACK");
    else await client.query("COMMIT");

    printReport(report);
    if (dryRun) {
      console.log("Dry run: no changes were written.");
    } else {
      console.log("Knowledge base seeded. Open /knowledge to read it.");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("seed-knowledge failed:", err);
  process.exit(1);
});
