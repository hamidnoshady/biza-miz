/**
 * Issue #812 §3/§6 — the Superadmin control-plane writes.
 *
 * One module for the handful of things a platform admin may change about the AI
 * runtime: which LiteLLM alias a mode asks for, and the Deep Research platform
 * switches. Kept apart from the read paths (`ai-runtime-modes.ts`) so a write
 * has to come through a capability guard rather than being reachable from any
 * read helper.
 *
 * What this module will not grow into: provider/model/budget/TPS/RPS management,
 * plans, credit packages or token tariffs. The first belongs to LiteLLM; the
 * second belongs to Plans/Billing and joins the runtime through usage
 * settlement, not through this table.
 */
import { query } from "./db";
import type { AiRuntimeMode } from "./ai-runtime-modes-shared";

export interface PlatformAiModeRecord {
  mode: AiRuntimeMode;
  modelAlias: string;
  isActive: boolean;
  temperature: number | null;
  maxOutputTokens: number | null;
  promptScopeKey: string;
  updatedBy: string;
}

export async function listPlatformAiModes(): Promise<PlatformAiModeRecord[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT mode_key, model_alias, is_active, temperature, max_output_tokens, prompt_scope_key, updated_by
       FROM platform_ai_modes
      ORDER BY mode_key`,
  );
  return rows.map((row) => ({
    mode: row.mode_key as AiRuntimeMode,
    modelAlias: String(row.model_alias ?? ""),
    isActive: Boolean(row.is_active),
    temperature: row.temperature === null ? null : Number(row.temperature),
    maxOutputTokens: row.max_output_tokens === null ? null : Number(row.max_output_tokens),
    promptScopeKey: String(row.prompt_scope_key ?? ""),
    updatedBy: String(row.updated_by ?? ""),
  }));
}

export interface UpdateModeInput {
  mode: AiRuntimeMode;
  modelAlias?: string;
  isActive?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  updatedBy: string;
}

/**
 * Applies a partial update to one mode. Every field is clamped here rather than
 * trusted from the console, so a hand-crafted request cannot set a negative
 * token cap or a 99-degree temperature.
 */
export async function updatePlatformAiMode(input: UpdateModeInput): Promise<PlatformAiModeRecord | null> {
  const sets: string[] = ["updated_by = $2", "updated_at = now()"];
  const params: unknown[] = [input.mode, input.updatedBy];

  if (input.modelAlias !== undefined) {
    // An alias is a routing hint, not a URL or a key: it is trimmed and length
    // capped, and anything else is refused rather than forwarded to LiteLLM.
    const alias = input.modelAlias.trim();
    if (alias.length > 120 || /[^\w.:/-]/.test(alias)) return null;
    params.push(alias);
    sets.push(`model_alias = $${params.length}`);
  }
  if (input.isActive !== undefined) {
    params.push(input.isActive);
    sets.push(`is_active = $${params.length}`);
  }
  if (input.temperature !== undefined) {
    if (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) return null;
    params.push(Math.round(input.temperature * 100) / 100);
    sets.push(`temperature = $${params.length}`);
  }
  if (input.maxOutputTokens !== undefined) {
    if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 200_000) {
      return null;
    }
    params.push(input.maxOutputTokens);
    sets.push(`max_output_tokens = $${params.length}`);
  }

  const { rows } = await query<Record<string, unknown>>(
    `UPDATE platform_ai_modes SET ${sets.join(", ")} WHERE mode_key = $1
     RETURNING mode_key, model_alias, is_active, temperature, max_output_tokens, prompt_scope_key, updated_by`,
    params,
  );
  if (rows.length === 0) return null;
  return {
    mode: rows[0].mode_key as AiRuntimeMode,
    modelAlias: String(rows[0].model_alias ?? ""),
    isActive: Boolean(rows[0].is_active),
    temperature: rows[0].temperature === null ? null : Number(rows[0].temperature),
    maxOutputTokens: rows[0].max_output_tokens === null ? null : Number(rows[0].max_output_tokens),
    promptScopeKey: String(rows[0].prompt_scope_key ?? ""),
    updatedBy: String(rows[0].updated_by ?? ""),
  };
}

// ---------------------------------------------------------------------------
// §6 — the Deep Research platform switches
// ---------------------------------------------------------------------------

export interface ResearchPlatformSettings {
  enabled: boolean;
  modelAlias: string;
  maxRounds: number;
  maxContextBytes: number;
  ttlHours: number;
  maxSpendRial: number;
  minDataReadiness: number;
  externalWeb: boolean;
}

/**
 * Reads the Deep Research switches off the gateway singleton, where the rest of
 * the AI infrastructure configuration already lives — one settings row, not a
 * second one.
 */
export async function getResearchPlatformSettings(): Promise<ResearchPlatformSettings> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT research_enabled, research_model_alias, research_max_rounds,
            research_max_context_bytes, research_ttl_hours, research_max_spend_rial,
            research_min_data_readiness, research_external_web
       FROM platform_ai_gateway
      LIMIT 1`,
  );
  const row = rows[0];
  if (!row) {
    return {
      enabled: false,
      modelAlias: "",
      maxRounds: 4,
      maxContextBytes: 2_000_000,
      ttlHours: 24,
      maxSpendRial: 0,
      minDataReadiness: 1,
      externalWeb: false,
    };
  }
  return {
    enabled: Boolean(row.research_enabled),
    modelAlias: String(row.research_model_alias ?? ""),
    maxRounds: Number(row.research_max_rounds ?? 4),
    maxContextBytes: Number(row.research_max_context_bytes ?? 2_000_000),
    ttlHours: Number(row.research_ttl_hours ?? 24),
    maxSpendRial: Number(row.research_max_spend_rial ?? 0),
    minDataReadiness: Number(row.research_min_data_readiness ?? 1),
    externalWeb: Boolean(row.research_external_web),
  };
}

export async function updateResearchPlatformSettings(
  input: Partial<Omit<ResearchPlatformSettings, "enabled">> & { enabled?: boolean },
): Promise<ResearchPlatformSettings> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (input.enabled !== undefined) push("research_enabled", input.enabled);
  if (input.modelAlias !== undefined) {
    const alias = input.modelAlias.trim();
    if (alias.length > 120 || /[^\w.:/-]/.test(alias)) throw new Error("research_model_alias_invalid");
    push("research_model_alias", alias);
  }
  if (input.maxRounds !== undefined) {
    if (!Number.isInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 12) {
      throw new Error("research_max_rounds_invalid");
    }
    push("research_max_rounds", input.maxRounds);
  }
  if (input.maxContextBytes !== undefined) {
    if (!Number.isInteger(input.maxContextBytes) || input.maxContextBytes < 1_000 || input.maxContextBytes > 20_000_000) {
      throw new Error("research_max_context_invalid");
    }
    push("research_max_context_bytes", input.maxContextBytes);
  }
  if (input.ttlHours !== undefined) {
    if (!Number.isInteger(input.ttlHours) || input.ttlHours < 1 || input.ttlHours > 24 * 30) {
      throw new Error("research_ttl_invalid");
    }
    push("research_ttl_hours", input.ttlHours);
  }
  if (input.maxSpendRial !== undefined) {
    if (!Number.isSafeInteger(input.maxSpendRial) || input.maxSpendRial < 0 || input.maxSpendRial > 1_000_000_000) {
      throw new Error("research_max_spend_invalid");
    }
    push("research_max_spend_rial", input.maxSpendRial);
  }
  if (input.minDataReadiness !== undefined) {
    if (!Number.isInteger(input.minDataReadiness) || input.minDataReadiness < 1 || input.minDataReadiness > 5) {
      throw new Error("research_readiness_invalid");
    }
    push("research_min_data_readiness", input.minDataReadiness);
  }
  if (input.externalWeb !== undefined) push("research_external_web", input.externalWeb);

  if (params.length === 0) return getResearchPlatformSettings();
  await query(`UPDATE platform_ai_gateway SET ${sets.join(", ")}`, params);
  return getResearchPlatformSettings();
}
