/**
 * Issue #812 §7 — the three user-facing AI runtime modes.
 *
 * `auto`, `instant` and `deep_research` replace the four modes that used to
 * exist. The retired "thinking / analytical" product mode was a prompt
 * directive wearing a mode's clothes — it changed no alias, no model and no
 * budget — so it is removed rather than migrated, and a stored `thinking`
 * preference resolves to `auto` instead of silently doing nothing.
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
  AI_RUNTIME_MODES,
  DEFAULT_AI_MODE,
  isAiRuntimeModeAvailable,
  type AiRuntimeMode,
} from "./ai-runtime-modes-shared";

// Re-exported so callers that already import from `./ai-runtime-modes` keep
// working. A CLIENT component should import them from
// `./ai-runtime-modes-shared`; this module reaches the database.
export {
  AI_MODE_HINTS,
  AI_MODE_LABELS,
  AI_RUNTIME_MODES,
  DEFAULT_AI_MODE,
  isAiRuntimeMode,
  isAiRuntimeModeAvailable,
  normalizeAiRuntimeMode,
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
type PlatformAiModeRowInput = PlatformAiModeRow & Record<string, unknown>;

/**
 * The three configured modes. Falls back to sensible defaults when the table
 * has never been written, so a deployment that has not opened the console yet
 * behaves exactly as it did before.
 */
export async function listPlatformAiModes(): Promise<PlatformAiModeRow[]> {
  try {
    const { rows } = await query<PlatformAiModeRowInput>(
      `SELECT mode_key, model_alias, is_active, temperature, max_output_tokens, prompt_scope_key
         FROM platform_ai_modes`,
    );
    if (rows.length > 0) return rows;
  } catch (err) {
    console.error("platform AI modes unavailable; using defaults", err);
  }
  return AI_RUNTIME_MODES.map((mode) => ({
    mode_key: mode,
    model_alias: "",
    is_active: mode !== "deep_research",
    temperature: null,
    max_output_tokens: null,
    prompt_scope_key: `mode:${mode}`,
  }));
}

/** One mode's configuration, or the default when it is absent. */
export async function getPlatformAiMode(mode: AiRuntimeMode): Promise<PlatformAiModeRow> {
  const modes = await listPlatformAiModes();
  return (
    modes.find((row) => row.mode_key === mode) ?? {
      mode_key: mode,
      model_alias: "",
      is_active: mode !== "deep_research",
      temperature: null,
      max_output_tokens: null,
      prompt_scope_key: `mode:${mode}`,
    }
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
