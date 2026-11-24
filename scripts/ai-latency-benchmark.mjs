#!/usr/bin/env node
/**
 * Issue #1546 — measure a real LiteLLM alias, not an assumption.
 *
 * The application's own diagnostics (`ai.turn.latency`, see
 * `src/lib/ai-latency.ts`) record every production turn. This script is the
 * controlled comparison: the same representative prompts, the same optional
 * tool catalogue, run N times against one alias, reporting p50/p95
 * time-to-first-token, generation time, total time, tokens and reported cost.
 *
 * It sends exactly what the application sends — an OpenAI-compatible
 * `/v1/chat/completions` request with `stream: true` — so a number here is
 * comparable with the diagnostics line.
 *
 * Credentials are read from the environment only. Nothing is written into the
 * repository, and no prompt text, response text or key is printed.
 *
 * Usage:
 *   AI_BENCH_BASE_URL=https://litellm.example/v1 \
 *   AI_BENCH_API_KEY=...            (or AI_BENCH_AUTH=Bearer ... form is not accepted) \
 *   AI_BENCH_MODEL=pos-auto \
 *   [AI_BENCH_TOOLS_FILE=path/to/tools.json] \
 *   [AI_BENCH_RUNS=5] [AI_BENCH_OUT=ai-latency.json] \
 *   node scripts/ai-latency-benchmark.mjs
 *
 * `AI_BENCH_TOOLS_FILE` is a JSON array of OpenAI function tool declarations —
 * export the live catalogue with `npx vitest run src/lib/ai-tool-selection.test.ts`
 * (it prints the schema token totals) or from the app's own diagnostics.
 *
 * Exit codes: 0 measured, 1 request/summary failure, 2 missing configuration.
 */
import { readFileSync, writeFileSync } from "node:fs";

const CASES = [
  {
    id: "simple",
    // A turn with no tool round: the pure first-token + generation cost.
    prompt: "در یک جمله بگو دستیار چه کارهایی می‌تواند برای این کسب‌وکار انجام دهد.",
    tools: false,
  },
  {
    id: "app-focused",
    // A report question: one tool round, then the answer.
    prompt: "فروش دیروز را خلاصه کن و سه نکتهٔ مهم را بگو.",
    tools: true,
  },
  {
    id: "multi-tool",
    // Explicitly multi-part: forces several tool rounds.
    prompt: "فروش دیروز، موجودی انبار و مطالبات را جداگانه بررسی کن و در پایان جمع‌بندی کن.",
    tools: true,
  },
];

const baseUrl = (process.env.AI_BENCH_BASE_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.AI_BENCH_API_KEY ?? "";
const model = process.env.AI_BENCH_MODEL ?? "";
const runs = Number(process.env.AI_BENCH_RUNS ?? 5);
const outPath = process.env.AI_BENCH_OUT ?? "";

if (!baseUrl || !apiKey || !model) {
  console.error(
    [
      "ai-latency-benchmark: no gateway configured, nothing was measured.",
      "Required environment:",
      "  AI_BENCH_BASE_URL  LiteLLM base URL including /v1",
      "  AI_BENCH_API_KEY   a virtual key for the alias under test",
      "  AI_BENCH_MODEL     the LiteLLM alias (e.g. pos-auto, pos-instant)",
      "Optional: AI_BENCH_TOOLS_FILE, AI_BENCH_RUNS, AI_BENCH_OUT",
    ].join("\n"),
  );
  process.exit(2);
}

let tools = [];
if (process.env.AI_BENCH_TOOLS_FILE) {
  tools = JSON.parse(readFileSync(process.env.AI_BENCH_TOOLS_FILE, "utf8"));
  if (!Array.isArray(tools)) throw new Error("AI_BENCH_TOOLS_FILE must be a JSON array");
}

const SYSTEM =
  "You are the business assistant. Use the provided read-only tools when the answer needs business data, and answer briefly in the user's language.";

/** Nearest-rank percentile over a numeric sample. */
function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(Math.min(1, Math.max(0, p)) * sorted.length) - 1)];
}

function summarize(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { count: 0, p50: null, p95: null, min: null, max: null };
  return {
    count: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    min: Math.min(...finite),
    max: Math.max(...finite),
  };
}

/** One streamed provider call. Returns timings and token counts only. */
async function measureOnce(prompt, withTools) {
  const startedAt = performance.now();
  let firstTokenAt = null;
  let text = "";
  let usage = null;
  let costUsd = null;

  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(withTools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`provider_status_${response.status}`);
  }
  const headerCost = Number(response.headers.get("x-litellm-response-cost"));
  if (Number.isFinite(headerCost) && headerCost >= 0) costUsd = headerCost;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        // Kept only to know whether the turn produced anything; never printed.
        text += delta.content;
      }
      if (delta.tool_calls?.length && firstTokenAt === null) firstTokenAt = performance.now();
    }
  }

  const totalMs = performance.now() - startedAt;
  return {
    ttftMs: firstTokenAt === null ? null : Math.round(firstTokenAt - startedAt),
    generationMs: firstTokenAt === null ? null : Math.round(totalMs - (firstTokenAt - startedAt)),
    totalMs: Math.round(totalMs),
    inputTokens: Number(usage?.prompt_tokens ?? 0),
    outputTokens: Number(usage?.completion_tokens ?? 0),
    toolSchemas: withTools ? tools.length : 0,
    costUsd,
    answered: text.trim().length > 0,
  };
}

const report = { model, toolSchemas: tools.length, runs, measuredAt: new Date().toISOString(), cases: [] };
let failures = 0;

for (const testCase of CASES) {
  const samples = [];
  for (let index = 0; index < runs; index++) {
    try {
      samples.push(await measureOnce(testCase.prompt, testCase.tools));
    } catch (error) {
      failures += 1;
      console.error(`${testCase.id}: run ${index + 1} failed (${error instanceof Error ? error.message : "unknown"})`);
    }
  }
  const caseReport = {
    id: testCase.id,
    toolsOffered: testCase.tools ? tools.length : 0,
    ttftMs: summarize(samples.map((sample) => sample.ttftMs).filter((value) => value !== null)),
    generationMs: summarize(samples.map((sample) => sample.generationMs).filter((value) => value !== null)),
    totalMs: summarize(samples.map((sample) => sample.totalMs)),
    inputTokens: summarize(samples.map((sample) => sample.inputTokens)),
    outputTokens: summarize(samples.map((sample) => sample.outputTokens)),
    answered: samples.filter((sample) => sample.answered).length,
    samples,
  };
  report.cases.push(caseReport);
  const line = [
    testCase.id.padEnd(12),
    `n=${caseReport.totalMs.count}`,
    `ttft p50=${caseReport.ttftMs.p50 ?? "-"}ms p95=${caseReport.ttftMs.p95 ?? "-"}ms`,
    `total p50=${caseReport.totalMs.p50 ?? "-"}ms p95=${caseReport.totalMs.p95 ?? "-"}ms`,
    `in=${caseReport.inputTokens.p50 ?? "-"} out=${caseReport.outputTokens.p50 ?? "-"}`,
    `schemas=${caseReport.toolsOffered}`,
  ].join("  ");
  console.log(line);
}

const costs = report.cases.flatMap((entry) => entry.samples.map((sample) => sample.costUsd)).filter((value) => value !== null);
report.costUsdTotal = costs.length ? costs.reduce((sum, value) => sum + value, 0) : null;
console.log(`cost: ${report.costUsdTotal === null ? "not reported by the gateway" : `${report.costUsdTotal.toFixed(6)} USD total`}`);

if (outPath) {
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report written to ${outPath}`);
}

process.exit(failures > 0 ? 1 : 0);
