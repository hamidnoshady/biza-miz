/**
 * Issue #1546 — privacy-safe latency diagnostics for one assistant turn.
 *
 * The reported 60–270 s turns could not be attributed from application logs:
 * nothing recorded how long the provider took to send its first byte, how many
 * rounds a turn made, or how many tool schemas each round carried, so the only
 * way to inspect a slow turn was to read LiteLLM's own logs and guess which
 * application request they belonged to.
 *
 * This module is the application-side half of that correlation. It records, per
 * provider round and per turn, only operational metadata:
 *
 *   - time-to-first-token, generation duration and round duration,
 *   - input/output tokens, effective model alias,
 *   - how many tool schemas were offered and which tools were actually called,
 *   - retries/fallbacks, round count and whether the turn hit its deadline.
 *
 * It deliberately has no field for a prompt, a message, a tool argument, a
 * customer record or a credential, and it never serialises the request or the
 * response. `requestId` is the application id already written to settlement and
 * audit rows, so a LiteLLM log line can be matched to a turn without any of the
 * turn's content leaving the database.
 *
 * Framework-free (no `db`, no `next`), so the service, the SDK adapter and any
 * benchmark harness share one shape.
 */
import type { AiToolSelectionDiagnostics } from "./ai-tool-selection";

/** One provider round: what it cost and how long it took. */
export interface AiRoundDiagnostics {
  /** 0-based round index within the turn. */
  round: number;
  /** ms from request dispatch to the first streamed token; null if none arrived. */
  ttftMs: number | null;
  /** ms from the first token to the end of the round. */
  generationMs: number;
  /** ms from dispatch to the end of the round. */
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Read tools this round asked for. Names only — never their arguments. */
  tools: string[];
  /** The stream_options protocol retry fired (not a generation retry). */
  protocolFallback: boolean;
}

/** One finished (or failed) assistant turn. */
export interface AiTurnDiagnostics {
  requestId?: string;
  /** The LiteLLM alias/model the turn actually asked for. */
  model: string;
  /** The product mode (`auto` | `instant` | `thinking`), if known. */
  mode?: string;
  /** How many tool schemas each round carried. */
  toolSchemaCount: number;
  /** The app sections the routing offered, for auditing the selection. */
  toolGroups: string[];
  /** Issue #1546 Phase 2 — sanitized reasons, counts and schema-token estimate. */
  toolSelection?: AiToolSelectionDiagnostics;
  rounds: AiRoundDiagnostics[];
  /** Total provider rounds, including the final plain answer. */
  roundCount: number;
  /** ms from turn start to turn end. */
  totalMs: number;
  /** First token of the whole turn. */
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  retries: number;
  fallbacks: number;
  /** The whole-turn deadline ended the turn (a partial answer, not a success). */
  deadlineHit: boolean;
  /** How the turn ended. */
  outcome: "answered" | "proposed" | "input_request" | "round_limit" | "failed" | "cancelled";
}

/**
 * Emits exactly one structured line per turn. `console.info` keeps it out of
 * the error stream (where a real provider failure still belongs) while a log
 * collector can index it by `event`.
 */
export function logAiTurnDiagnostics(diagnostics: AiTurnDiagnostics): void {
  try {
    console.info(
      JSON.stringify({
        event: "ai.turn.latency",
        ...diagnostics,
        // A round's tool list is bounded so one pathological turn cannot emit
        // an unbounded line.
        rounds: diagnostics.rounds.map((round) => ({ ...round, tools: round.tools.slice(0, 8) })),
      }),
    );
  } catch {
    // Diagnostics must never fail a turn.
  }
}

/** Nearest-rank percentile over a sample. `p` is 0–1. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const index = Math.max(0, Math.ceil(clamped * sorted.length) - 1);
  return sorted[index] ?? null;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

/** p50/p95 summary used by the benchmark report and its tests. */
export function summarizeLatency(values: readonly number[]): LatencySummary {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { count: 0, p50: null, p95: null, min: null, max: null };
  return {
    count: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    min: Math.min(...finite),
    max: Math.max(...finite),
  };
}

/** Builds an empty turn record so every exit path logs the same shape. */
export function startTurnDiagnostics(input: {
  requestId?: string;
  model: string;
  mode?: string;
  toolSchemaCount: number;
  toolGroups?: string[];
  toolSelection?: AiToolSelectionDiagnostics;
  startedAt: number;
}): AiTurnDiagnostics {
  return {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    model: input.model,
    ...(input.mode ? { mode: input.mode } : {}),
    toolSchemaCount: input.toolSchemaCount,
    toolGroups: input.toolGroups ?? [],
    ...(input.toolSelection ? { toolSelection: input.toolSelection } : {}),
    rounds: [],
    roundCount: 0,
    totalMs: 0,
    ttftMs: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    retries: 0,
    fallbacks: 0,
    deadlineHit: false,
    outcome: "answered",
  };
}

/** Adds one round and refreshes the turn totals. Mutates and returns `turn`. */
export function recordRound(turn: AiTurnDiagnostics, round: AiRoundDiagnostics): AiTurnDiagnostics {
  turn.rounds.push(round);
  turn.roundCount = turn.rounds.length;
  turn.inputTokens += round.inputTokens;
  turn.outputTokens += round.outputTokens;
  if (turn.ttftMs === null && round.ttftMs !== null) turn.ttftMs = round.ttftMs;
  if (round.protocolFallback) turn.fallbacks += 1;
  return turn;
}
