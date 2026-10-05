/**
 * Issue #812 §8 — the ONE prompt resolver.
 *
 * Before this, the assistant's prompt came from two places that disagreed: a
 * monolithic `buildSystemPrompt` in `ai.ts` and a fragment engine in
 * `ai-prompts.ts` that nothing called. There is now one resolver, and it is the
 * live source of truth. Its layers, in order:
 *
 *   1. platform base policy        `base`
 *   2. runtime mode prompt         `mode:<auto|instant|deep_research>`
 *   3. system agent prompt         `agent:<agent_key>`
 *   4. business-type fragment      `business_type:<industry>`
 *   5. app-context fragment        `app:<app_key>`
 *   6. tenant durable memory       (`ai_memory`, scope = tenant)
 *   7. app durable memory          (`ai_memory`, scope = app)
 *   8. project context             (standing instruction + project memory)
 *   9. current task context        (what this turn is for)
 *  10. runtime tool/action catalogue (what this turn may actually call)
 *
 * The order is the security property. Anything above cannot be overridden by
 * anything below, so a tenant memory row or a project note can inform an
 * answer but can never widen what a user may do — and platform security policy
 * is composed above all of it and cannot be overridden by it (§24).
 *
 * Two rules make a platform prompt override safe:
 *
 *  - **A published row replaces its layer's TEXT, never its existence.** If
 *    `mode:instant` has no published row, the code default is used; if it has
 *    one, only that layer's text changes. There is no way to publish away the
 *    base policy, the tool catalogue, or the memory framing.
 *  - **An unknown scope fails to the default, never to empty.** A typo in
 *    `scope_key`, or a row still in `draft`, is invisible to the runtime.
 */
import {
  appContextLines,
  businessTypeLines,
  platformBaseLines,
  projectContextLines,
  runtimeModeLines,
  systemAgentLines,
  toolCatalogueLines,
  type PromptContext,
} from "./ai";
import {
  memoryLayersForTurn,
  renderMemoryForPrompt,
  type MemoryScope,
} from "./ai-memory";
import { query } from "./db";
import type { AppKey } from "./apps";
import type { AiRuntimeMode } from "./ai-runtime-modes";

export const BASE_PROMPT_SCOPE = "base";

export function modePromptScope(mode: AiRuntimeMode): string {
  return `mode:${mode}`;
}

export function agentPromptScope(agentKey: string): string {
  return `agent:${agentKey}`;
}

export function businessTypePromptScope(businessType: string): string {
  return `business_type:${businessType}`;
}

export function appPromptScope(appKey: string): string {
  return `app:${appKey}`;
}

export interface PublishedPromptRow {
  id: string;
  scopeKey: string;
  version: number;
  text: string;
  notes: string;
  publishedAt: string | null;
}

/**
 * The published row for one scope, or null. `draft` and `retired` rows are
 * never returned: the runtime sees a scope only once somebody has published it.
 */
export async function getPublishedPrompt(scopeKey: string): Promise<PublishedPromptRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, scope_key, version, text, notes, published_at
       FROM ai_prompt_versions
      WHERE scope_key = $1 AND state = 'published'
      LIMIT 1`,
    [scopeKey],
  );
  return rows.length === 0 ? null : toPromptRow(rows[0]);
}

/** Every published row, keyed by scope — one round trip per resolved prompt. */
export async function listPublishedPrompts(): Promise<Map<string, PublishedPromptRow>> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, scope_key, version, text, notes, published_at
       FROM ai_prompt_versions
      WHERE state = 'published'`,
  );
  const map = new Map<string, PublishedPromptRow>();
  for (const row of rows) map.set(String(row.scope_key), toPromptRow(row));
  return map;
}

function toPromptRow(row: Record<string, unknown>): PublishedPromptRow {
  return {
    id: String(row.id),
    scopeKey: String(row.scope_key),
    version: Number(row.version ?? 1),
    text: String(row.text ?? ""),
    notes: String(row.notes ?? ""),
    publishedAt: row.published_at ? String(row.published_at) : null,
  };
}

/** Which scope keys actually produced a layer, for attribution (§21). */
export interface ResolvedPromptLayers {
  base: { version: number | null; scopeKey: string };
  mode: { version: number | null; scopeKey: string };
  agent: { version: number | null; scopeKey: string } | null;
  businessType: { version: number | null; scopeKey: string } | null;
  app: { version: number | null; scopeKey: string } | null;
  /** Memory scopes that actually contributed rows. */
  memoryScopes: MemoryScope[];
  toolCatalogue: boolean;
}

export interface ResolveSystemPromptInput extends PromptContext {
  /** The tenant. Required: memory and the business-type fragment need it. */
  businessId: string;
  /** The invoked system agent's stable key, when one is invoked. */
  agentKey?: string | null;
  /** The business's industry, used for the business-type fragment. */
  businessType?: string | null;
  /** The app this turn is scoped to, used for the app fragment. */
  appKey?: AppKey | null;
  /** The project this turn is scoped to, for its memory layer. */
  projectId?: string | null;
  /** What this turn is for — a suggestion card's prompt, a task label, etc. */
  taskContext?: string | null;
  /** Set false for turns that must not read durable memory (platform realm). */
  loadMemory?: boolean;
}

export interface ResolvedSystemPrompt {
  systemPrompt: string;
  layers: ResolvedPromptLayers;
}

/**
 * Resolves the system prompt for one turn.
 *
 * The default layer texts come from the layer builders in `ai.ts`, which are
 * the same code that produced every prompt before this existed — so a
 * deployment that has published nothing behaves exactly as it did. Publishing
 * a row changes one layer, and only that layer.
 */
export async function resolveSystemPrompt(input: ResolveSystemPromptInput): Promise<ResolvedSystemPrompt> {
  const ctx: PromptContext = input;
  const published = await listPublishedPrompts();
  const mode = input.runtimeMode ?? "auto";

  const baseKey = BASE_PROMPT_SCOPE;
  const modeKey = modePromptScope(mode);
  const agentKey = input.agentKey ? agentPromptScope(input.agentKey) : "";
  const businessTypeKey = input.businessType ? businessTypePromptScope(input.businessType) : "";
  const appKey = input.appKey ? appPromptScope(input.appKey) : "";

  const baseOverride = published.get(baseKey);
  const modeOverride = published.get(modeKey);
  const agentOverride = agentKey ? published.get(agentKey) : undefined;
  const businessTypeOverride = businessTypeKey ? published.get(businessTypeKey) : undefined;
  const appOverride = appKey ? published.get(appKey) : undefined;

  // Layers 6/7 — durable memory. Loaded as data and rendered inside a framing
  // that says, in as many words, that it cannot change the rules above it.
  let memoryBlock = "";
  const memoryScopes: MemoryScope[] = [];
  if (input.loadMemory !== false && input.businessId) {
    const layers = await memoryLayersForTurn({
      businessId: input.businessId,
      appKey: input.appKey ?? null,
      projectId: input.projectId ?? null,
    });
    memoryBlock = renderMemoryForPrompt(layers);
    for (const scope of ["platform", "tenant", "app", "project"] as const) {
      if (layers[scope].length > 0) memoryScopes.push(scope);
    }
  }

  const sections: string[] = [];
  const push = (text: string | null | undefined) => {
    const trimmed = (text ?? "").trim();
    if (trimmed) sections.push(trimmed);
  };

  // 1. platform base policy. A published row may reword it, but the identity
  //    lines it emits are re-appended: the model must always know which
  //    business and which member it is speaking for.
  const baseText = baseOverride?.text ?? platformBaseLines(ctx).join("\n");
  push(baseText);
  for (const line of platformBaseLines(ctx)) {
    if (line.startsWith("نام کسب‌وکار:") || line.startsWith("کاربر:")) push(line);
  }

  // 2. runtime mode
  push(modeOverride?.text ?? runtimeModeLines(ctx).join("\n"));

  // 3. system agent
  if (input.agentKey) push(agentOverride?.text ?? systemAgentLines(ctx).join("\n"));

  // 4. business type
  if (input.businessType) push(businessTypeOverride?.text ?? businessTypeLines(ctx).join("\n"));

  // 5. app context (mode behaviour, grounding rules, retrieval pointer)
  push(appOverride?.text ?? appContextLines(ctx).join("\n"));

  // 6/7. durable memory
  push(memoryBlock);

  // 8. project context
  push(projectContextLines(ctx).join("\n"));

  // 9. current task
  push(input.taskContext);

  // 10. runtime tool/action catalogue
  push(toolCatalogueLines(ctx).join("\n"));

  return {
    systemPrompt: sections.join("\n"),
    layers: {
      base: { version: baseOverride?.version ?? null, scopeKey: baseKey },
      mode: { version: modeOverride?.version ?? null, scopeKey: modeKey },
      agent: input.agentKey ? { version: agentOverride?.version ?? null, scopeKey: agentKey } : null,
      businessType: input.businessType && businessTypeKey
        ? { version: businessTypeOverride?.version ?? null, scopeKey: businessTypeKey }
        : null,
      app: input.appKey && appKey ? { version: appOverride?.version ?? null, scopeKey: appKey } : null,
      memoryScopes,
      toolCatalogue: toolCatalogueLines(ctx).length > 0,
    },
  };
}

/** Convenience for the memory manager UI: what a scope currently holds. */
export async function countMemoryByScope(businessId: string): Promise<Record<MemoryScope, number>> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT scope, count(*)::int AS n FROM ai_memory
      WHERE business_id = $1 AND deleted_at IS NULL GROUP BY scope`,
    [businessId],
  );
  const counts: Record<MemoryScope, number> = { platform: 0, tenant: 0, app: 0, project: 0 };
  for (const row of rows) {
    const scope = String(row.scope) as MemoryScope;
    if (scope in counts) counts[scope] = Number(row.n ?? 0);
  }
  return counts;
}
