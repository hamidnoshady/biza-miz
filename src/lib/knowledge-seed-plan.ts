/**
 * Seed-safety planning for the knowledge base (issue #938).
 *
 * `scripts/seed-knowledge.ts` used to upsert every row it owns and force
 * `status = 'published'` plus the full tag set on every run. That is fine on a
 * fresh database and destructive on a live one: an operator who unpublished a
 * seeded article, or edited its body in the console, had the change silently
 * reverted by the next deploy that re-ran the seed.
 *
 * The rule is now conservative and explicit:
 *
 *  - a **missing** row is inserted;
 *  - an existing row is updated only when it was created *and last written*
 *    by this seed (`created_by`/`updated_by` = `seed:knowledge`) and is still
 *    published/active — i.e. nobody has touched it;
 *  - a hand-edited, unpublished or hand-deactivated row is **skipped** and
 *    reported;
 *  - `--overwrite` (a deliberate operator choice) restores the registry
 *    content for every row.
 *
 * The function is pure so the decisions are unit-tested without a database;
 * the script only executes them.
 */

export const SEED_ACTOR = "seed:knowledge";

export type SeedObjectKind = "category" | "tag" | "article";

export interface SeedDecision {
  action: "insert" | "update" | "skip";
  reason:
    | "missing"
    | "seed-owned"
    | "overwrite"
    | "not-seed-owned"
    | "edited-by-hand"
    | "unpublished"
    | "inactive";
}

export interface SeedArticleRow {
  createdBy: string;
  updatedBy: string;
  status: string;
}

export interface SeedCategoryRow {
  createdBy: string;
  isActive: boolean;
  /**
   * Whether the stored title/description/icon/tone/order differ from the
   * registry. `knowledge_categories` has no `updated_by`, so this is how the
   * script recognises an edit made in the console; without it a rerun would
   * quietly restore the seeded wording.
   */
  edited?: boolean;
}

export interface SeedTagRow {
  createdBy: string;
  /** Label/description differ from the registry (tags have no `updated_by`). */
  edited?: boolean;
}

export interface SeedPlanOptions {
  actor?: string;
  overwrite?: boolean;
}

function isSeedOwned(createdBy: string, actor: string): boolean {
  return createdBy === actor;
}

/** Decide one article's fate from the row currently stored (null = absent). */
export function planSeedArticle(
  existing: SeedArticleRow | null,
  options: SeedPlanOptions = {},
): SeedDecision {
  const actor = options.actor ?? SEED_ACTOR;
  if (!existing) return { action: "insert", reason: "missing" };
  if (options.overwrite) return { action: "update", reason: "overwrite" };
  if (!isSeedOwned(existing.createdBy, actor)) {
    return { action: "skip", reason: "not-seed-owned" };
  }
  if (existing.status !== "published") {
    // The operator unpublished it on purpose; never republish silently.
    return { action: "skip", reason: "unpublished" };
  }
  if (existing.updatedBy !== actor) {
    return { action: "skip", reason: "edited-by-hand" };
  }
  return { action: "update", reason: "seed-owned" };
}

/** Decide one category's fate from the row currently stored (null = absent). */
export function planSeedCategory(
  existing: SeedCategoryRow | null,
  options: SeedPlanOptions = {},
): SeedDecision {
  const actor = options.actor ?? SEED_ACTOR;
  if (!existing) return { action: "insert", reason: "missing" };
  if (options.overwrite) return { action: "update", reason: "overwrite" };
  if (!isSeedOwned(existing.createdBy, actor)) {
    return { action: "skip", reason: "not-seed-owned" };
  }
  if (!existing.isActive) {
    // Deactivating a category hides its whole branch on purpose (#938 policy).
    return { action: "skip", reason: "inactive" };
  }
  if (existing.edited) return { action: "skip", reason: "edited-by-hand" };
  return { action: "update", reason: "seed-owned" };
}

/** Decide one tag's fate from the row currently stored (null = absent). */
export function planSeedTag(
  existing: SeedTagRow | null,
  options: SeedPlanOptions = {},
): SeedDecision {
  const actor = options.actor ?? SEED_ACTOR;
  if (!existing) return { action: "insert", reason: "missing" };
  if (options.overwrite) return { action: "update", reason: "overwrite" };
  if (!isSeedOwned(existing.createdBy, actor)) {
    return { action: "skip", reason: "not-seed-owned" };
  }
  if (existing.edited) return { action: "skip", reason: "edited-by-hand" };
  return { action: "update", reason: "seed-owned" };
}

/** Persian explanation of a skip, used by the script's report. */
export function seedDecisionLabel(decision: SeedDecision): string {
  switch (decision.reason) {
    case "missing":
      return "ایجاد";
    case "seed-owned":
      return "به‌روزرسانی (دست‌نخورده)";
    case "overwrite":
      return "بازنویسی (—overwrite)";
    case "not-seed-owned":
      return "رد شد: ردیف دست‌ساز است";
    case "edited-by-hand":
      return "رد شد: پس از انتشار ویرایش شده";
    case "unpublished":
      return "رد شد: به‌عمد پیش‌نویس شده";
    case "inactive":
      return "رد شد: به‌عمد غیرفعال شده";
  }
}
