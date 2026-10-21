/**
 * Section-identity audit for the knowledge base (issue #874 F26 / #938).
 *
 * Before #936, an article claimed a dashboard *section* (`section_keys` held
 * keys like `pos` or `settings`). The page picker stores `page:<route>` keys
 * instead, and keeps the old keys as fallbacks. Seeded and hand-written rows
 * can therefore still hold keys that no longer exist in either registry
 * (`overview`, `stock`, `ai`).
 *
 * Nothing is deleted here: this module only classifies every key an article
 * carries and suggests the canonical page for the legacy ones. The script
 * `scripts/audit-knowledge-sections.ts` prints the report; content is migrated
 * deliberately by an operator (or by re-running the seed with `--overwrite`).
 */
import { KNOWLEDGE_PAGES, KNOWLEDGE_SECTIONS } from "./knowledge-base";

export type KbSectionKeyKind = "page" | "section" | "stale";

/**
 * Legacy keys that have a confident canonical page. `overview` was the old
 * general dashboard article, which now belongs to the accounting overview
 * page; `stock` was an inventory sub-key. `ai` is intentionally absent — the
 * workspace home has no «آموزش» button, so there is no page to map it to.
 */
export const LEGACY_SECTION_ALIASES: Readonly<Record<string, string>> = {
  overview: "page:/accounting/overview",
  stock: "inventory",
};

const PAGE_KEYS = new Set(KNOWLEDGE_PAGES.map((page) => page.key));
const SECTION_KEYS = new Set(KNOWLEDGE_SECTIONS.map((section) => section.key));

export function knowledgeSectionKeyKind(key: string): KbSectionKeyKind {
  if (PAGE_KEYS.has(key)) return "page";
  if (SECTION_KEYS.has(key)) return "section";
  return "stale";
}

/** The key itself when known, the operator-visible page when aliased, else null. */
export function suggestedPageKeyForLegacyKey(key: string): string | null {
  const kind = knowledgeSectionKeyKind(key);
  if (kind === "page") return key;
  if (kind === "section") {
    // A section key keeps its own fallback resolution; the picker's canonical
    // page suggestion is the first page whose route equals the section route.
    const section = KNOWLEDGE_SECTIONS.find((candidate) => candidate.key === key);
    const page = section
      ? KNOWLEDGE_PAGES.find((candidate) => candidate.route === section.route)
      : undefined;
    return page?.key ?? null;
  }
  return LEGACY_SECTION_ALIASES[key] ?? null;
}

export interface KbSectionAuditInput {
  slug: string;
  sectionKeys: readonly string[];
}

export interface KbSectionAuditEntry {
  key: string;
  kind: KbSectionKeyKind;
  suggestedPageKey: string | null;
  /** Article slugs carrying this key (sorted, deduped). */
  articles: string[];
}

export interface KbSectionAuditReport {
  entries: KbSectionAuditEntry[];
  mappedLegacyKeys: string[];
  unmappedKeys: string[];
  articlesWithoutAssignments: string[];
}

/** Classify every section/page key currently stored on the given articles. */
export function auditKnowledgeSections(
  articles: readonly KbSectionAuditInput[],
): KbSectionAuditReport {
  const byKey = new Map<string, Set<string>>();
  const without: string[] = [];
  for (const article of articles) {
    if (!article.sectionKeys.length) {
      without.push(article.slug);
      continue;
    }
    for (const key of article.sectionKeys) {
      const set = byKey.get(key) ?? new Set<string>();
      set.add(article.slug);
      byKey.set(key, set);
    }
  }
  const entries: KbSectionAuditEntry[] = [...byKey.entries()]
    .map(([key, slugs]) => ({
      key,
      kind: knowledgeSectionKeyKind(key),
      suggestedPageKey: suggestedPageKeyForLegacyKey(key),
      articles: [...slugs].sort(),
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));

  return {
    entries,
    mappedLegacyKeys: entries
      .filter((entry) => entry.kind === "stale" && entry.suggestedPageKey)
      .map((entry) => entry.key),
    unmappedKeys: entries
      .filter((entry) => entry.kind === "stale" && !entry.suggestedPageKey)
      .map((entry) => entry.key),
    articlesWithoutAssignments: without.sort(),
  };
}
