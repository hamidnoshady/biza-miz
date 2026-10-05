/**
 * Issue #812 §8 — the prompt store behind the one resolver.
 *
 * Versions, publish and rollback for every scope the resolver understands. The
 * table's own invariants do the heavy lifting, and they are worth stating
 * because they are what makes "a draft must not affect production" true rather
 * than merely intended:
 *
 *  - `ai_prompt_versions` has a partial UNIQUE index on `scope_key WHERE state
 *    = 'published'`. Two published rows for one scope is not a convention the
 *    code has to remember to keep; the database refuses it.
 *  - Publishing one version retires the previously published one, in the same
 *    transaction, so there is never a window with none and never a window with
 *    two.
 *  - Rollback republishes an older version rather than deleting anything, so
 *    the history of what was live stays readable.
 *  - A scope with nothing published resolves to the code default. The runtime
 *    can therefore never end up with an empty system prompt.
 */
import { getPool, query } from "./db";
import {
  BASE_PROMPT_SCOPE,
  agentPromptScope,
  appPromptScope,
  businessTypePromptScope,
  modePromptScope,
  type PublishedPromptRow,
} from "./ai-prompt-resolver";
import { isAiRuntimeMode, type AiRuntimeMode } from "./ai-runtime-modes-shared";

export type PromptState = "draft" | "published" | "retired";

export interface PromptVersionRow {
  id: string;
  scopeKey: string;
  version: number;
  text: string;
  state: PromptState;
  notes: string;
  createdBy: string;
  publishedBy: string | null;
  publishedAt: string | null;
  createdAt: string;
}

/** The scopes the console offers, in the resolver's composition order. */
export const PROMPT_SCOPES: readonly { key: string; label: string; hint: string }[] = [
  {
    key: BASE_PROMPT_SCOPE,
    label: "پایهٔ پلتفرم",
    hint: "قواعد غیرقابل‌مذاکره: زبان فارسی، تاریخ شمسی، نساختن عدد، هرگز نشان‌دادن شناسه. جایگزینی این لایه فقط متن را عوض می‌کند، نه وجودش را.",
  },
  {
    key: modePromptScope("auto"),
    label: "حالت خودکار",
    hint: "لایهٔ دوم پرامپت برای حالت خودکار.",
  },
  {
    key: modePromptScope("instant"),
    label: "حالت فوری",
    hint: "لایهٔ دوم پرامپت برای حالت فوری.",
  },
  {
    key: modePromptScope("deep_research"),
    label: "پژوهش عمیق",
    hint: "لایهٔ دوم پرامپت برای پژوهش عمیق؛ هر عدد باید منبع داشته باشد.",
  },
  {
    key: businessTypePromptScope("food_service"),
    label: "نوع کسب‌وکار — غذا و رستوران",
    hint: "قالب اختصاصی این نوع کسب‌وکار. فقط برای کسب‌وکارهای همین نوع اعمال می‌شود.",
  },
  {
    key: appPromptScope("accounting"),
    label: "بخش — حسابداری",
    hint: "زمینهٔ بخش حسابداری.",
  },
  {
    key: appPromptScope("crm"),
    label: "بخش — مشتریان",
    hint: "زمینهٔ بخش مشتریان.",
  },
  {
    key: appPromptScope("growth"),
    label: "بخش — رشد",
    hint: "زمینهٔ بخش رشد.",
  },
  {
    key: appPromptScope("website"),
    label: "بخش — وب‌سایت",
    hint: "زمینهٔ بخش وب‌سایت.",
  },
];

export function isPromptScopeKey(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const [kind, rest] = value.split(":");
  if (!rest) return kind === BASE_PROMPT_SCOPE;
  switch (kind) {
    case "mode":
      return isAiRuntimeMode(rest);
    case "business_type":
    case "app":
    case "agent":
      return rest.trim().length > 0;
    default:
      return false;
  }
}

/** Every version of every scope, newest first, for the console's editor. */
export async function listPromptVersions(scopeKey?: string): Promise<PromptVersionRow[]> {
  const params: unknown[] = [];
  let sql = `SELECT * FROM ai_prompt_versions`;
  if (scopeKey) {
    sql += ` WHERE scope_key = $1`;
    params.push(scopeKey);
  }
  sql += ` ORDER BY scope_key, version DESC`;
  const { rows } = await query<Record<string, unknown>>(sql, params);
  return rows.map(toRow);
}

export async function getPromptVersion(id: string): Promise<PromptVersionRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM ai_prompt_versions WHERE id = $1`,
    [id],
  );
  return rows.length === 0 ? null : toRow(rows[0]);
}

/** The published row for a scope, or null — the same read the resolver uses. */
export async function publishedPromptFor(scopeKey: string): Promise<PublishedPromptRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, scope_key, version, text, notes, published_at
       FROM ai_prompt_versions
      WHERE scope_key = $1 AND state = 'published'
      LIMIT 1`,
    [scopeKey],
  );
  if (rows.length === 0) return null;
  return {
    id: String(rows[0].id),
    scopeKey: String(rows[0].scope_key),
    version: Number(rows[0].version ?? 1),
    text: String(rows[0].text ?? ""),
    notes: String(rows[0].notes ?? ""),
    publishedAt: rows[0].published_at ? String(rows[0].published_at) : null,
  };
}

export type SavePromptResult =
  | { ok: true; version: PromptVersionRow }
  | { ok: false; error: string };

/**
 * Writes a DRAFT for a scope. A draft is invisible to the runtime until it is
 * published, which is the whole point: editing the live prompt is not something
 * a typo can do.
 */
export async function savePromptDraft(input: {
  scopeKey: string;
  text: string;
  notes?: string;
  createdBy: string;
}): Promise<SavePromptResult> {
  if (!isPromptScopeKey(input.scopeKey)) return { ok: false, error: "prompt_scope_unknown" };
  const text = input.text.trim();
  if (!text) return { ok: false, error: "prompt_text_required" };
  if (text.length > 40_000) return { ok: false, error: "prompt_text_too_long" };

  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO ai_prompt_versions (scope_key, version, text, state, notes, created_by)
     VALUES (
       $1,
       (SELECT COALESCE(MAX(version), 0) + 1 FROM ai_prompt_versions WHERE scope_key = $1),
       $2, 'draft', $3, $4
     )
     RETURNING *`,
    [input.scopeKey, text, input.notes ?? "", input.createdBy],
  );
  return { ok: true, version: toRow(rows[0]) };
}

export type PublishPromptResult =
  | { ok: true; published: PromptVersionRow; retired: PromptVersionRow | null }
  | { ok: false; error: string };

/**
 * Publishes one version and retires whatever was published for that scope.
 *
 * Two statements, in that order, inside one transaction — and the order is not
 * cosmetic. An earlier revision wrote both as CTEs of a single statement, which
 * *looks* atomic and is not: every CTE sees the same snapshot, so the
 * `published` UPDATE runs against a snapshot in which the old row is still
 * `published`, and the partial unique index on `scope_key WHERE state =
 * 'published'` rejects it. The index does not force the order — it enforces the
 * result, and a single statement cannot produce it.
 *
 * The consequence was not subtle: **publishing a second version of any scope
 * failed outright**, so a Superadmin could publish version 1 and nothing after
 * it. Only a test that publishes twice finds it, which is why
 * `integration/ai-prompt-resolver-agents.integration.test.ts` does exactly that.
 */
export async function publishPromptVersion(input: {
  id: string;
  publishedBy: string;
}): Promise<PublishPromptResult> {
  const version = await getPromptVersion(input.id);
  if (!version) return { ok: false, error: "prompt_version_not_found" };
  if (version.state === "published") return { ok: false, error: "prompt_already_published" };

  // `ai_prompt_versions` is platform-scope and in `EXEMPT_TABLES`, so there is
  // no tenant to scope this to — the scope here is the prompt scope, not a
  // business. The transaction is what matters: retire, then publish, or neither.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const retiredResult = await client.query<Record<string, unknown>>(
      `UPDATE ai_prompt_versions
          SET state = 'retired', updated_at = now()
        WHERE scope_key = $1 AND state = 'published'
        RETURNING *`,
      [version.scopeKey],
    );
    const publishedResult = await client.query<Record<string, unknown>>(
      `UPDATE ai_prompt_versions
          SET state = 'published', published_by = $1, published_at = now(), updated_at = now()
        WHERE id = $2
        RETURNING *`,
      [input.publishedBy, input.id],
    );
    const published = publishedResult.rows[0];
    if (!published) {
      await client.query("ROLLBACK");
      return { ok: false, error: "prompt_publish_failed" };
    }
    await client.query("COMMIT");
    return {
      ok: true,
      published: toRow(published),
      retired: retiredResult.rows[0] ? toRow(retiredResult.rows[0]) : null,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // A failed ROLLBACK must not mask the error that explains the failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Rolls a scope back to an older version by republishing it.
 *
 * Nothing is deleted and nothing is rewritten: the version that was live keeps
 * its row, its number and its publish timestamp, and the target becomes live
 * again. The history of what was live stays readable, which is the difference
 * between a rollback and a cover-up.
 */
export async function rollbackPromptVersion(input: {
  scopeKey: string;
  targetVersion: number;
  publishedBy: string;
}): Promise<PublishPromptResult> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id FROM ai_prompt_versions WHERE scope_key = $1 AND version = $2`,
    [input.scopeKey, input.targetVersion],
  );
  if (rows.length === 0) return { ok: false, error: "prompt_version_not_found" };
  return publishPromptVersion({ id: String(rows[0].id), publishedBy: input.publishedBy });
}

/** Retires a draft. A published version is refused — retire by publishing another. */
export async function retirePromptVersion(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE ai_prompt_versions SET state = 'retired', updated_at = now()
      WHERE id = $1 AND state = 'draft'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

function toRow(row: Record<string, unknown>): PromptVersionRow {
  return {
    id: String(row.id),
    scopeKey: String(row.scope_key),
    version: Number(row.version ?? 1),
    text: String(row.text ?? ""),
    state: (row.state as PromptState) ?? "draft",
    notes: String(row.notes ?? ""),
    createdBy: String(row.created_by ?? ""),
    publishedBy: (row.published_by as string | null) ?? null,
    publishedAt: row.published_at ? String(row.published_at) : null,
    createdAt: String(row.created_at),
  };
}
