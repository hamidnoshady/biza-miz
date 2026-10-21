/**
 * Reports stale section/page identities in the knowledge base (issue #938,
 * related #874 F26) without changing a single row.
 *
 * Usage:
 *   npm run db:audit-knowledge-sections            # seed registry only
 *   DATABASE_URL=… npm run db:audit-knowledge-sections -- --database
 *
 * The report lists every `section_keys` value an article carries, whether it
 * is a current page key, a legacy section key, or stale, and the canonical
 * page we suggest for it. `overview` and `stock` have confident aliases;
 * `ai` remains unmapped because «میز کار من» carries no learning button.
 * Deleting or rewriting those keys is a deliberate editorial step — this
 * script (and the console) never does it silently.
 */
import "dotenv/config";
import { Client } from "pg";
import { SEED_ARTICLES } from "./knowledge-seed/content";
import {
  auditKnowledgeSections,
  LEGACY_SECTION_ALIASES,
  suggestedPageKeyForLegacyKey,
} from "../src/lib/knowledge-sections-audit";

interface ArticleRow {
  slug: string;
  section_keys: string[];
}

async function loadDatabaseArticles(): Promise<ArticleRow[]> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<ArticleRow>(
      "SELECT slug, section_keys FROM knowledge_articles ORDER BY slug",
    );
    const { rows: entries } = await client.query<{ section: string; url: string; is_active: boolean }>(
      "SELECT section, url, is_active FROM knowledge_base_entries ORDER BY section",
    );
    if (entries.length) {
      console.log("Legacy external learning pages (kept read-only, not deleted):");
      for (const entry of entries) {
        const suggested = suggestedPageKeyForLegacyKey(entry.section);
        console.log(
          `  - section ${entry.section} → ${suggested ?? "unmapped"} (${entry.is_active ? "active" : "inactive"}) ${entry.url}`,
        );
      }
      console.log("");
    }
    return rows;
  } finally {
    await client.end();
  }
}

async function main() {
  const useDatabase = process.argv.includes("--database");
  const articles = useDatabase
    ? await loadDatabaseArticles()
    : SEED_ARTICLES.map((article) => ({
        slug: article.slug,
        section_keys: article.sectionKeys,
      }));

  const report = auditKnowledgeSections(
    articles.map((article) => ({ slug: article.slug, sectionKeys: article.section_keys })),
  );

  console.log(`Source: ${useDatabase ? "database" : "seed registry"} (${articles.length} articles)`);
  console.log("");
  console.log("Key                                  kind     articles  suggestion");
  for (const entry of report.entries) {
    console.log(
      `${entry.key.padEnd(36)} ${entry.kind.padEnd(8)} ${String(entry.articles.length).padEnd(8)} ${
        entry.suggestedPageKey ?? "—"
      }`,
    );
  }
  console.log("");
  console.log(`Legacy keys with a confident page: ${report.mappedLegacyKeys.join(", ") || "none"}`);
  console.log(`Unmapped stale keys: ${report.unmappedKeys.join(", ") || "none"}`);
  console.log(
    `Articles without any page/section assignment: ${
      report.articlesWithoutAssignments.length
        ? report.articlesWithoutAssignments.join(", ")
        : "none"
    }`,
  );
  console.log("");
  console.log("Alias table:");
  for (const [legacy, page] of Object.entries(LEGACY_SECTION_ALIASES)) {
    console.log(`  ${legacy} → ${page}`);
  }
  console.log("");
  console.log(
    "No rows were modified. Re-run the seed with --overwrite, or edit the article in the console, to migrate a key.",
  );
}

main().catch((err) => {
  console.error("audit-knowledge-sections failed:", err);
  process.exit(1);
});
