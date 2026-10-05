/**
 * Issue #812 §5 — the Deep Research vocabulary and its pure cost arithmetic.
 *
 * Split from `ai-research.ts` so the browser can name a run's status, read its
 * findings and show the same default caps the server enforces without pulling
 * the database layer into the client bundle. Everything here is a type or a
 * pure function; the workflow itself lives in `ai-research.ts`.
 */
export type ResearchStatus =
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "spend_cap_reached";

export interface ResearchSource {
  kind: "knowledge" | "tool" | "web" | "platform";
  ref: string;
  title: string;
  /** Rows or records this source contributed. */
  count: number;
}

export interface ResearchFinding {
  claim: string;
  sourceRefs: string[];
}

export interface ResearchRun {
  id: string;
  businessId: string;
  locationId: string | null;
  appKey: string | null;
  projectId: string | null;
  userId: string;
  question: string;
  status: ResearchStatus;
  environmentId: string;
  modelAlias: string;
  promptVersion: string | null;
  systemAgentId: string | null;
  maxRounds: number;
  roundsUsed: number;
  maxContextChars: number;
  estimatedMaxCostUsd: number;
  actualCostUsd: number;
  spendCapUsd: number;
  knowledgeEnabled: boolean;
  webEnabled: boolean;
  findings: ResearchFinding[];
  sources: ResearchSource[];
  answer: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string;
}

/** How long a run and its environment stay alive. Superadmin-tunable (§6). */
export const RESEARCH_ENV_TTL_HOURS = 24;

/** Hard default caps, used until Superadmin sets tighter ones. */
export const RESEARCH_DEFAULT_MAX_ROUNDS = 4;
export const RESEARCH_DEFAULT_MAX_CONTEXT_CHARS = 60_000;
export const RESEARCH_DEFAULT_SPEND_CAP_USD = 1;

/** A conservative per-round token ceiling, used only for the estimate. */
const ESTIMATED_OUTPUT_TOKENS_PER_ROUND = 2_000;
/** Rough blended price used only to turn a token ceiling into an estimate. */
const ESTIMATED_BLENDED_USD_PER_1K_TOKENS = 0.002;

export function estimateResearchMaxCostUsd(input: {
  maxRounds: number;
  maxOutputTokensPerRound?: number;
}): number {
  const rounds = Math.max(1, Math.floor(input.maxRounds || 1));
  const perRound = input.maxOutputTokensPerRound ?? ESTIMATED_OUTPUT_TOKENS_PER_ROUND;
  // The rate is per 1K tokens, so the token count is divided by 1000 first.
  const raw = (rounds * perRound * ESTIMATED_BLENDED_USD_PER_1K_TOKENS) / 1000;
  // Rounded UP to the cent: the number the user approves must never be lower
  // than the number the loop is allowed to reach. `Math.ceil(x * 100) / 100`,
  // not `Math.ceil(x / 100) / 100` — the latter rounds 0.012 down to 0.01,
  // which is exactly the under-report this is here to prevent.
  return Math.ceil(raw * 100) / 100;
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
