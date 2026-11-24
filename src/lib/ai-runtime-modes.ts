/**
 * Issue #812 §7 — the three user-facing AI runtime modes.
 *
 * The three chat profiles are `auto`, `instant` (Fast) and `thinking`.
 * Deep Research was a separately approved workflow and is retired (issue #1367):
 * its value is kept for historical rows only and is never selectable.
 * Thinking now uses a real independently managed LiteLLM model alias.
 *
 * The load-bearing rule: **mode selection changes the actual LiteLLM model
 * alias**, not only a line of prompt text. `resolveModeRuntime` reads the
 * platform's configured alias for the chosen mode and hands back the config a
 * turn should go out with. An unconfigured alias means "use the gateway's
 * default chat model", which is exactly what a deployment that has not set
 * aliases up yet keeps doing — so turning this on is additive, never a cutover.
 *
 * What this module deliberately does NOT own: routing, fallbacks, retries,
 * provider deployments, budgets or TPS/RPS. Those are LiteLLM's. The app
 * chooses which alias to ask for and nothing more.
 */
import { query } from "./db";
import type { AiConfig } from "./ai";
import {
  AI_CHAT_MODES,
  AI_RUNTIME_MODES,
  DEFAULT_AI_MODE,
  isRetiredAiRuntimeMode,
  isAiRuntimeModeAvailable,
  type AiModeAvailability,
  type AiRuntimeMode,
} from "./ai-runtime-modes-shared";

// Re-exported so callers that already import from `./ai-runtime-modes` keep
// working. A CLIENT component should import them from
// `./ai-runtime-modes-shared`; this module reaches the database.
export {
  AI_CHAT_MODES,
  AI_MODE_HINTS,
  AI_MODE_LABELS,
  AI_RETIRED_MODES,
  AI_RUNTIME_MODES,
  DEFAULT_AI_MODE,
  firstRetiredAiRuntimeMode,
  isAiRuntimeMode,
  isAiRuntimeModeAvailable,
  isRetiredAiRuntimeMode,
  normalizeAiRuntimeMode,
  resolveRequestedAiRuntimeMode,
  type AiRuntimeMode,
} from "./ai-runtime-modes-shared";

export interface PlatformAiModeRow {
  mode_key: string;
  model_alias: string;
  is_active: boolean;
  temperature: number | null;
  max_output_tokens: number | null;
  prompt_scope_key: string;
}

/** The row shape `query` requires — every column is unknown-shaped to the DB. */
type PlatformAiModeRowInput = Omit<PlatformAiModeRow, "temperature"> & {
  temperature: string | number | null;
} & Record<string, unknown>;

/** The row a mode has before the console ever wrote one. */
function defaultPlatformAiModeRow(mode: AiRuntimeMode): PlatformAiModeRow {
  return {
    mode_key: mode,
    model_alias: "",
    // Issue #1367 — a retired mode never starts active, even on a deployment
    // that has never opened the console.
    is_active: !isRetiredAiRuntimeMode(mode),
    temperature: null,
    max_output_tokens: null,
    prompt_scope_key: `mode:${mode}`,
  };
}

/**
 * The three configured modes. Falls back to sensible defaults when the table
 * has never been written, so a deployment that has not opened the console yet
 * behaves exactly as it did before.
 *
 * This is the RUNTIME read (snake_case rows, tolerant of a missing table). The
 * super-admin console's read is `listPlatformAiModeSettings` in
 * `ai-control-plane.ts`; the two are deliberately named apart.
 */
export async function listPlatformAiModeRows(): Promise<PlatformAiModeRow[]> {
  try {
    const { rows } = await query<PlatformAiModeRowInput>(
      `SELECT mode_key, model_alias, is_active, temperature, max_output_tokens, prompt_scope_key
         FROM platform_ai_modes`,
    );
    if (rows.length > 0) {
      // PostgreSQL returns numeric columns as strings through node-postgres.
      return rows.map((row) => ({
        ...row,
        temperature: row.temperature === null ? null : Number(row.temperature),
      }));
    }
  } catch (err) {
    console.error("platform AI modes unavailable; using defaults", err);
  }
  return AI_RUNTIME_MODES.map(defaultPlatformAiModeRow);
}

/** One mode's configuration, or the default when it is absent. */
export async function getPlatformAiMode(mode: AiRuntimeMode): Promise<PlatformAiModeRow> {
  const modes = await listPlatformAiModeRows();
  return modes.find((row) => row.mode_key === mode) ?? defaultPlatformAiModeRow(mode);
}

/**
 * Issue #1546 — the single decision about whether a chat mode may be offered.
 *
 * `/api/ai/modes` renders it in the picker and the chat route refuses a turn on
 * it, so the offer and the refusal cannot disagree. A retired mode is never
 * offered; a mode switched off in the console is never offered; Fast also needs
 * its own alias, because a blank one resolves to the gateway's default chat
 * model — Auto under a faster-sounding label.
 */
export function modeAvailability(
  row: { model_alias?: string | null; is_active?: boolean | null },
  mode: AiRuntimeMode,
): AiModeAvailability {
  if (!isAiRuntimeModeAvailable(mode) || row.is_active === false) {
    return { mode, available: false, reason: "disabled" };
  }
  if (mode === "instant" && !row.model_alias?.trim()) {
    return { mode, available: false, reason: "fast_alias_not_configured" };
  }
  return { mode, available: true, reason: null };
}

/**
 * The three chat modes with `modeAvailability` applied, in picker order. A mode
 * the settings table has no row for is decided from the same default row the
 * runtime read would use, so the endpoints and a turn cannot disagree.
 */
export function aiModeAvailability(
  rows: readonly PlatformAiModeRow[],
): AiModeAvailability[] {
  const byMode = new Map(rows.map((row) => [row.mode_key, row]));
  return AI_CHAT_MODES.map((mode) =>
    modeAvailability(byMode.get(mode) ?? defaultPlatformAiModeRow(mode), mode),
  );
}

/** What a turn actually goes out with, once the mode has been applied. */
export interface ModeRuntime {
  mode: AiRuntimeMode;
  /** The LiteLLM alias this mode asks for; empty means the gateway default. */
  modelAlias: string;
  /** The prompt scope whose published row shapes this mode. */
  promptScopeKey: string;
  temperature: number | null;
  maxOutputTokens: number | null;
  /** True when the mode is switched off in the console. */
  disabled: boolean;
}

/**
 * Applies a mode to a resolved `AiConfig`. Pure apart from the one settings
 * read, so the alias decision is testable without a provider.
 *
 * The alias REPLACES `config.model` — that is the whole point. When no alias is
 * configured the model is left alone, which is the additive behaviour a
 * deployment upgrading in place needs.
 */
export async function resolveModeRuntime(
  config: AiConfig,
  mode: AiRuntimeMode,
): Promise<{ config: AiConfig; runtime: ModeRuntime }> {
  const row = await getPlatformAiMode(mode);
  const runtime: ModeRuntime = {
    mode,
    modelAlias: row.model_alias?.trim() ?? "",
    promptScopeKey: row.prompt_scope_key?.trim() || `mode:${mode}`,
    temperature: row.temperature,
    maxOutputTokens: row.max_output_tokens,
    disabled: row.is_active === false,
  };
  return {
    config: {
      ...config,
      ...(runtime.modelAlias ? { model: runtime.modelAlias } : {}),
      ...(runtime.temperature !== null ? { temperature: runtime.temperature } : {}),
      ...(runtime.maxOutputTokens !== null ? { maxOutputTokens: runtime.maxOutputTokens } : {}),
    },
    runtime,
  };
}
