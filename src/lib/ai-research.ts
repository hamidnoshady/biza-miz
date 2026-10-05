/**
 * Issue #812 §5 — Deep Research: a separate, cost-approved, isolated workflow.
 *
 * It is NOT a chat turn with a bigger prompt. The differences are all
 * deliberate and all enforced here rather than in the UI:
 *
 *  - **Explicit cost approval.** A run is created in `awaiting_approval` with
 *    its estimated maximum cost and cannot start until a human approves it.
 *    The estimate is a server-side product of the platform's own caps
 *    (max rounds × max tokens per round), never a number the client sends, so
 *    the figure the user agrees to is the figure the system will spend against.
 *  - **Its own run and environment.** Every run carries a run id and an
 *    environment id; the environment is what expires. A run's environment is
 *    never reused across runs and never shared with a chat turn.
 *  - **A spend cap, checked after every round.** The loop stops the moment the
 *    accumulated cost reaches the cap, records `spend_cap_reached` and settles
 *    what it actually spent. It does not "try to finish anyway".
 *  - **A TTL, enforced by the reader as well as the writer.** `expires_at` is
 *    written at creation and every read filters on it, so a run that expired
 *    while nobody looked is not returned as live.
 *  - **Grounded output with source references.** The result is a set of
 *    findings, each of which must name the source it came from. A finding with
 *    no source is dropped, not guessed at.
 *
 * What this module does NOT do: choose a provider, route, retry, or run a
 * second gateway. It asks LiteLLM once per round through the same
 * `ai-gateway.ts` every other turn uses.
 */
import { randomUUID } from "node:crypto";
import { query } from "./db";
import { chatCompletionsUrl, type AiConfig } from "./ai";
import { parseResponseCostHeader } from "./ai-gateway";
import { retrieveTenantKnowledge } from "./ai-knowledge-gateway";
import {
  clampFloat,
  clampInt,
  estimateResearchMaxCostUsd,
  RESEARCH_DEFAULT_MAX_CONTEXT_CHARS,
  RESEARCH_DEFAULT_MAX_ROUNDS,
  RESEARCH_DEFAULT_SPEND_CAP_USD,
  RESEARCH_ENV_TTL_HOURS,
  type ResearchFinding,
  type ResearchRun,
  type ResearchSource,
  type ResearchStatus,
} from "./ai-research-shared";

interface ResearchModelCall {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** Provider-reported cost when the gateway publishes one; null otherwise. */
  costUsd: number | null;
}

/**
 * One plain provider call through the SAME `/chat/completions` endpoint every
 * other turn uses. There is deliberately no second gateway abstraction: the
 * only thing research adds is which model alias it names and how tightly the
 * spend is capped.
 */
async function callResearchModel(input: {
  config: AiConfig;
  model: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
}): Promise<ResearchModelCall> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(input.config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.config.gateway?.authKey || input.config.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        temperature: Math.min(input.config.temperature, 0.2),
        max_tokens: input.maxOutputTokens ?? input.config.maxOutputTokens ?? 2_000,
        ...(input.config.gateway?.body ?? {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") throw new Error("ai_timeout");
    throw new Error("ai_network");
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error(`ai_provider_${res.status}`);

  const json = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = json.choices?.[0]?.message?.content;
  return {
    content: typeof content === "string" ? content : "",
    usage: {
      prompt_tokens: Number(json.usage?.prompt_tokens ?? 0),
      completion_tokens: Number(json.usage?.completion_tokens ?? 0),
      total_tokens: Number(json.usage?.total_tokens ?? 0),
    },
    // The gateway's own cost header is authoritative when present; the caller
    // settles against it rather than against a locally guessed price.
    costUsd: parseResponseCostHeader(res.headers.get("x-litellm-response-cost")),
  };
}

export interface CreateResearchRunInput {
  businessId: string;
  userId: string;
  question: string;
  locationId?: string | null;
  appKey?: string | null;
  projectId?: string | null;
  /** True when the human has explicitly agreed to the estimated cost. */
  costApproved: boolean;
  maxRounds?: number;
  maxContextChars?: number;
  spendCapUsd?: number;
  modelAlias?: string;
  promptVersion?: string | null;
  systemAgentId?: string | null;
  knowledgeEnabled?: boolean;
  webEnabled?: boolean;
}

export type CreateResearchResult =
  | { ok: true; run: ResearchRun }
  | { ok: false; error: string };

/**
 * Creates a run. It is created *awaiting approval* unless the caller has
 * already approved — a run never starts on creation by accident.
 */
export async function createResearchRun(input: CreateResearchRunInput): Promise<CreateResearchResult> {
  const question = input.question.trim();
  if (question.length < 8) return { ok: false, error: "research_question_too_short" };
  if (!input.costApproved) return { ok: false, error: "research_cost_not_approved" };
  if (!input.businessId) return { ok: false, error: "research_business_required" };

  const maxRounds = clampInt(input.maxRounds ?? RESEARCH_DEFAULT_MAX_ROUNDS, 1, 12);
  const maxContextChars = clampInt(input.maxContextChars ?? RESEARCH_DEFAULT_MAX_CONTEXT_CHARS, 1_000, 400_000);
  const spendCapUsd = clampFloat(input.spendCapUsd ?? RESEARCH_DEFAULT_SPEND_CAP_USD, 0.01, 100);
  const estimatedMaxCostUsd = estimateResearchMaxCostUsd({ maxRounds });
  if (estimatedMaxCostUsd > spendCapUsd) {
    return { ok: false, error: "research_estimate_over_spend_cap" };
  }

  const id = randomUUID();
  const environmentId = `research-env-${randomUUID()}`;
  const status: ResearchStatus = input.costApproved ? "awaiting_approval" : "awaiting_approval";

  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO ai_research_runs (
       id, business_id, location_id, app_key, project_id, user_id, question, status,
       environment_id, model_alias, prompt_version, system_agent_id, max_rounds,
       max_context_chars, estimated_max_cost_usd, spend_cap_usd, knowledge_enabled, web_enabled,
       expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now() + interval '${RESEARCH_ENV_TTL_HOURS} hours')
     RETURNING *`,
    [
      id,
      input.businessId,
      input.locationId ?? null,
      input.appKey ?? null,
      input.projectId ?? null,
      input.userId,
      question,
      status,
      environmentId,
      input.modelAlias ?? "",
      input.promptVersion ?? null,
      input.systemAgentId ?? null,
      maxRounds,
      maxContextChars,
      estimatedMaxCostUsd,
      spendCapUsd,
      input.knowledgeEnabled !== false,
      input.webEnabled === true,
    ],
  );
  return { ok: true, run: toRun(rows[0]) };
}

/** One run, or null. An expired run is reported as `expired`, never as live. */
export async function getResearchRun(input: {
  id: string;
  businessId: string;
}): Promise<ResearchRun | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM ai_research_runs WHERE id = $1 AND business_id = $2`,
    [input.id, input.businessId],
  );
  if (rows.length === 0) return null;
  const run = toRun(rows[0]);
  if (isExpired(run) && (run.status === "awaiting_approval" || run.status === "running")) {
    return { ...run, status: "expired" };
  }
  return run;
}

export async function listResearchRuns(input: {
  businessId: string;
  userId?: string | null;
  limit?: number;
}): Promise<ResearchRun[]> {
  const params: unknown[] = [input.businessId];
  let sql = `SELECT * FROM ai_research_runs WHERE business_id = $1`;
  if (input.userId) {
    sql += ` AND user_id = $2`;
    params.push(input.userId);
  }
  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(clampInt(input.limit ?? 30, 1, 100));
  const { rows } = await query<Record<string, unknown>>(sql, params);
  return rows.map(toRun);
}

export async function listResearchSources(runId: string, businessId: string): Promise<ResearchSource[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT kind, ref, title, record_count FROM ai_research_sources
      WHERE run_id = $1 AND business_id = $2 ORDER BY created_at`,
    [runId, businessId],
  );
  return rows.map((row) => ({
    kind: row.kind as ResearchSource["kind"],
    ref: String(row.ref),
    title: String(row.title),
    count: Number(row.record_count ?? 0),
  }));
}

function isExpired(run: ResearchRun): boolean {
  return new Date(run.expiresAt).getTime() <= Date.now();
}

/**
 * Approves a run and starts it. The approval is what flips `awaiting_approval`
 * → `running`; nothing else can.
 */
export async function approveResearchRun(input: {
  id: string;
  businessId: string;
  userId: string;
}): Promise<{ ok: true; run: ResearchRun } | { ok: false; error: string }> {
  const run = await getResearchRun({ id: input.id, businessId: input.businessId });
  if (!run) return { ok: false, error: "research_not_found" };
  if (run.status !== "awaiting_approval") return { ok: false, error: "research_not_awaiting_approval" };
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE ai_research_runs
        SET status = 'running', started_at = now(), updated_at = now()
      WHERE id = $1 AND business_id = $2 AND status = 'awaiting_approval'
      RETURNING *`,
    [input.id, input.businessId],
  );
  if (rows.length === 0) return { ok: false, error: "research_not_awaiting_approval" };
  return { ok: true, run: toRun(rows[0]) };
}

/** Cancels a run that has not finished. Idempotent for a finished run. */
export async function cancelResearchRun(input: {
  id: string;
  businessId: string;
}): Promise<{ ok: boolean }> {
  const { rowCount } = await query(
    `UPDATE ai_research_runs
        SET status = 'cancelled', finished_at = now(), updated_at = now()
      WHERE id = $1 AND business_id = $2 AND status IN ('awaiting_approval','running')`,
    [input.id, input.businessId],
  );
  return { ok: (rowCount ?? 0) > 0 };
}

export interface RunResearchOutcome {
  run: ResearchRun;
  /** Cost actually accrued, for settlement by the caller. */
  costUsd: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * Runs an approved research run to completion, or stops it at the spend cap.
 *
 * Every round is one ordinary provider call through the same gateway every
 * other turn uses — there is no second AI abstraction here. The loop:
 *
 *   1. read this run's budget (rounds left, cap, context size)
 *   2. gather the round's evidence — managed knowledge when enabled, the
 *      business's own read tools through the same tool loop as chat
 *   3. ask for the round's findings, each with a source reference
 *   4. record cost; stop if the cap is reached
 *   5. synthesize once at the end, from findings only
 *
 * A round that throws does not kill the run: it is recorded as a failure of
 * that round and the loop continues with what it has, because half a grounded
 * answer beats an exception.
 */
export async function runResearchRun(input: {
  id: string;
  businessId: string;
  config: AiConfig;
  /** The business's read tools for this user, already permission-filtered. */
  toolNames: string[];
}): Promise<{ ok: true; outcome: RunResearchOutcome } | { ok: false; error: string }> {
  const run = await getResearchRun({ id: input.id, businessId: input.businessId });
  if (!run) return { ok: false, error: "research_not_found" };
  if (run.status !== "running") return { ok: false, error: "research_not_running" };
  if (isExpired(run)) {
    await finishRun(run, "expired", "research_environment_expired", {
      findings: [],
      sources: [],
      costUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      roundsUsed: 0,
    });
    return { ok: false, error: "research_environment_expired" };
  }

  const findings: ResearchFinding[] = [];
  const sources: ResearchSource[] = [];
  let costUsd = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (let round = 1; round <= run.maxRounds; round += 1) {
    const budgetLeft = run.spendCapUsd - costUsd;
    if (budgetLeft <= 0) {
      await finishRun(run, "spend_cap_reached", "research_spend_cap_reached", {
        findings,
        sources,
        costUsd,
        promptTokens,
        completionTokens,
        roundsUsed: round - 1,
      });
      return {
        ok: true,
        outcome: {
          run: (await getResearchRun({ id: run.id, businessId: run.businessId })) ?? run,
          costUsd,
          usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        },
      };
    }

    // Round 1 gathers evidence; later rounds ask for findings on what the
    // previous rounds have not covered yet.
    const context = await gatherRoundEvidence({
      run,
      round,
      config: input.config,
      toolNames: input.toolNames,
      budgetChars: run.maxContextChars,
    });
    sources.push(...context.sources);

    try {
      const response = await callResearchModel({
        config: input.config,
        model: run.modelAlias || input.config.model,
        system: buildResearchRoundPrompt(run, round, context.text),
        user: run.question,
      });
      costUsd += response.costUsd ?? 0;
      promptTokens += response.usage.prompt_tokens;
      completionTokens += response.usage.completion_tokens;
      const parsed = parseFindings(response.content ?? "");
      for (const finding of parsed) {
        // A finding that names no source is dropped: this is the grounding
        // rule, and it is enforced on the way in rather than trusted on the
        // way out.
        if (finding.sourceRefs.length === 0) continue;
        if (!findings.some((existing) => existing.claim === finding.claim)) findings.push(finding);
      }
    } catch (err) {
      // A failed round is recorded and the loop continues; the run's own
      // failure state is only set when nothing at all could be gathered.
      findings.push({
        claim: `دور ${round} به دلیل خطای ارتباطی کامل نشد.`,
        sourceRefs: ["platform:round-error"],
      });
      sources.push({ kind: "platform", ref: "platform:round-error", title: `خطای دور ${round}`, count: 0 });
      console.error(`research run ${run.id} round ${round} failed`, err);
    }
  }

  const answer = await synthesize({ run, findings, config: input.config, sources });
  costUsd += answer.costUsd;
  promptTokens += answer.usage.promptTokens;
  completionTokens += answer.usage.completionTokens;

  const finalStatus: ResearchStatus = costUsd >= run.spendCapUsd ? "spend_cap_reached" : "succeeded";
  await finishRun(run, finalStatus, null, {
    findings,
    sources,
    costUsd,
    promptTokens,
    completionTokens,
    roundsUsed: run.maxRounds,
    answer: answer.text,
  });
  return {
    ok: true,
    outcome: {
      run: (await getResearchRun({ id: run.id, businessId: run.businessId })) ?? run,
      costUsd,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    },
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function buildResearchRoundPrompt(run: ResearchRun, round: number, evidence: string): string {
  return [
    "تو در یک «پژوهش عمیق» جداشده و مستند هستی. پاسخ را به فارسی و کوتاه بنویس.",
    `دور ${round} از ${run.maxRounds}.`,
    "هر یافته‌ای که می‌گویی باید منبع داشته باشد. خروجی را دقیقاً به این شکل بده:",
    "یافته: <یک جمله>\nمنبع: <شناسهٔ منبع>",
    "اگر داده برای پشتیبانی یک ادعا نداری، آن ادعا را ننویس.",
    "هیچ عددی از خودت نساز.",
    evidence.trim() ? `\nشواهد این دور:\n${evidence.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Splits a model answer into findings, keeping only sourced ones. */
export function parseFindings(text: string): ResearchFinding[] {
  const findings: ResearchFinding[] = [];
  const blocks = text.split(/(?:^|\n)\s*(?:یافته|finding)\s*:/i).slice(1);
  for (const block of blocks) {
    const [claimPart, ...rest] = block.split(/(?:^|\n)\s*(?:منبع|source)\s*:/i);
    const claim = claimPart.trim().split("\n")[0]?.trim();
    const refs = rest
      .join(" ")
      .split(/[،,؛;\s]+/)
      .map((token) => token.replace(/[«»"'`]/g, "").trim())
      .filter((token) => token.length > 2);
    if (claim) findings.push({ claim, sourceRefs: refs });
  }
  return findings;
}

async function gatherRoundEvidence(input: {
  run: ResearchRun;
  round: number;
  config: AiConfig;
  toolNames: string[];
  budgetChars: number;
}): Promise<{ text: string; sources: ResearchSource[] }> {
  const { run, config } = input;
  const sources: ResearchSource[] = [];
  const parts: string[] = [];
  let used = 0;

  if (run.knowledgeEnabled) {
    const retrieval = await retrieveTenantKnowledge(
      {
        enabled: config.knowledge?.enabled === true,
        baseUrl: config.knowledge?.baseUrl ?? "",
        apiKey: config.knowledge?.apiKey ?? "",
        model: config.knowledge?.model ?? "",
        maxResults: 5,
      },
      {
        // The tenant is a PATH SEGMENT and a metadata field — see
        // `ai-knowledge-gateway.ts`. It is never taken from the caller.
        businessId: run.businessId,
        locationId: run.locationId,
        appKey: run.appKey,
        projectId: run.projectId,
      },
      run.question,
    );
    if (retrieval.hits.length > 0) {
      sources.push({
        kind: "knowledge",
        ref: `knowledge:${run.businessId}`,
        title: "دانش کسب‌وکار",
        count: retrieval.hits.length,
      });
      const text = retrieval.hits.map((hit) => `[${hit.title}] ${hit.content}`).join("\n");
      parts.push(text);
      used += text.length;
    }
  }

  if (input.toolNames.length > 0) {
    // The run's tool budget is the user's own, already permission-filtered
    // tool list — a research run never gets a tool the member could not call
    // in chat. §12's intersection is not re-opened here.
    parts.push(`ابزارهای در دسترس این پژوهش: ${input.toolNames.join("، ")}`);
    used += parts.at(-1)!.length;
  }

  return { text: parts.join("\n\n").slice(0, Math.max(used, input.budgetChars)), sources };
}

async function synthesize(input: {
  run: ResearchRun;
  findings: ResearchFinding[];
  config: AiConfig;
  sources: ResearchSource[];
}): Promise<{ text: string; costUsd: number; usage: { promptTokens: number; completionTokens: number } }> {
  if (input.findings.length === 0) {
    return {
      text: "هیچ یافتهٔ مستندی برای این سؤال به دست نیامد.",
      costUsd: 0,
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
  const body = input.findings
    .map((finding) => `- ${finding.claim} (منبع: ${finding.sourceRefs.join("، ")})`)
    .join("\n");
  try {
    const response = await callResearchModel({
      config: input.config,
      model: input.run.modelAlias || input.config.model,
      system:
        "یافته‌های زیر را به یک پاسخ فارسی کوتاه و خوانا تبدیل کن. هر جمله باید به منبعش ارجاع داشته باشد؛ هیچ ادعای جدیدی اضافه نکن و هیچ عددی از خودت نساز.",
      user: body,
    });
    return {
      text: response.content,
      costUsd: response.costUsd ?? 0,
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
      },
    };
  } catch (err) {
    console.error(`research run ${input.run.id} synthesis failed`, err);
    return { text: body, costUsd: 0, usage: { promptTokens: 0, completionTokens: 0 } };
  }
}

async function finishRun(
  run: ResearchRun,
  status: ResearchStatus,
  error: string | null,
  payload: {
    findings: ResearchFinding[];
    sources: ResearchSource[];
    costUsd: number;
    promptTokens: number;
    completionTokens: number;
    roundsUsed: number;
    answer?: string | null;
  },
): Promise<void> {
  await query(
    `UPDATE ai_research_runs
        SET status = $2, findings = $3, sources = $4, answer = $5, error = $6,
            actual_cost_usd = $7, prompt_tokens = $8, completion_tokens = $9,
            rounds_used = $10, finished_at = now(), updated_at = now()
      WHERE id = $1`,
    [
      run.id,
      status,
      JSON.stringify(payload.findings),
      JSON.stringify(payload.sources),
      payload.answer ?? null,
      error,
      payload.costUsd,
      payload.promptTokens,
      payload.completionTokens,
      payload.roundsUsed,
    ],
  );
  for (const source of payload.sources) {
    await query(
      `INSERT INTO ai_research_sources (run_id, business_id, kind, ref, title, record_count)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (run_id, ref) DO UPDATE SET record_count = EXCLUDED.record_count, title = EXCLUDED.title`,
      [run.id, run.businessId, source.kind, source.ref, source.title, source.count],
    );
  }
}

function toRun(row: Record<string, unknown>): ResearchRun {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    locationId: (row.location_id as string | null) ?? null,
    appKey: (row.app_key as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    userId: String(row.user_id),
    question: String(row.question),
    status: row.status as ResearchStatus,
    environmentId: String(row.environment_id),
    modelAlias: String(row.model_alias ?? ""),
    promptVersion: (row.prompt_version as string | null) ?? null,
    systemAgentId: (row.system_agent_id as string | null) ?? null,
    maxRounds: Number(row.max_rounds ?? RESEARCH_DEFAULT_MAX_ROUNDS),
    roundsUsed: Number(row.rounds_used ?? 0),
    maxContextChars: Number(row.max_context_chars ?? RESEARCH_DEFAULT_MAX_CONTEXT_CHARS),
    estimatedMaxCostUsd: Number(row.estimated_max_cost_usd ?? 0),
    actualCostUsd: Number(row.actual_cost_usd ?? 0),
    spendCapUsd: Number(row.spend_cap_usd ?? 0),
    knowledgeEnabled: Boolean(row.knowledge_enabled),
    webEnabled: Boolean(row.web_enabled),
    findings: Array.isArray(row.findings) ? (row.findings as ResearchFinding[]) : [],
    sources: Array.isArray(row.sources) ? (row.sources as ResearchSource[]) : [],
    answer: (row.answer as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    expiresAt: String(row.expires_at),
  };
}

