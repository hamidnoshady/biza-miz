/**
 * Issue #1546 — the diagnostics line is only useful if it is (a) correct and
 * (b) safe to keep. These tests pin both: the p50/p95 maths the benchmark
 * report uses, and the fact that the emitted line cannot contain a prompt, a
 * tool argument, a credential or a customer record.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  logAiTurnDiagnostics,
  percentile,
  recordRound,
  startTurnDiagnostics,
  summarizeLatency,
  type AiTurnDiagnostics,
} from "./ai-latency";

describe("percentile / summarizeLatency", () => {
  it("uses nearest-rank percentiles on a sorted sample", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 1)).toBe(5);
  });

  it("summarises a benchmark sample", () => {
    const summary = summarizeLatency([100, 200, 300, 400, 500]);
    expect(summary).toMatchObject({ count: 5, p50: 300, p95: 500, min: 100, max: 500 });
    expect(summarizeLatency([])).toEqual({ count: 0, p50: null, p95: null, min: null, max: null });
  });
});

describe("turn diagnostics", () => {
  function turn(): AiTurnDiagnostics {
    return startTurnDiagnostics({
      requestId: "req-1",
      model: "pos-auto",
      mode: "auto",
      toolSchemaCount: 42,
      toolGroups: ["accounting:sales"],
      startedAt: 0,
    });
  }

  it("accumulates rounds and keeps the first token of the whole turn", () => {
    const diagnostics = turn();
    recordRound(diagnostics, {
      round: 0,
      ttftMs: 1_200,
      generationMs: 800,
      totalMs: 2_000,
      inputTokens: 9_000,
      outputTokens: 120,
      tools: ["get_menu_performance"],
      protocolFallback: false,
    });
    recordRound(diagnostics, {
      round: 1,
      ttftMs: 900,
      generationMs: 300,
      totalMs: 1_200,
      inputTokens: 9_100,
      outputTokens: 80,
      tools: [],
      protocolFallback: true,
    });

    expect(diagnostics.roundCount).toBe(2);
    expect(diagnostics.ttftMs).toBe(1_200);
    expect(diagnostics.inputTokens).toBe(18_100);
    expect(diagnostics.outputTokens).toBe(200);
    expect(diagnostics.fallbacks).toBe(1);
  });

  it("logs one JSON line that carries operational metadata and no content", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const diagnostics = turn();
    recordRound(diagnostics, {
      round: 0,
      ttftMs: 500,
      generationMs: 500,
      totalMs: 1_000,
      inputTokens: 100,
      outputTokens: 10,
      tools: ["get_menu_performance"],
      protocolFallback: false,
    });
    logAiTurnDiagnostics(diagnostics);

    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line) as Record<string, unknown> & {
      rounds: { tool: string; tools: string[] }[];
    };
    expect(parsed).toMatchObject({
      event: "ai.turn.latency",
      requestId: "req-1",
      model: "pos-auto",
      toolSchemaCount: 42,
      roundCount: 1,
    });
    // Tool names are operational metadata; arguments, prompts and payloads are
    // not — and the shape has no field that could carry them.
    expect(parsed.rounds[0]!.tools).toEqual(["get_menu_performance"]);
    for (const forbidden of ["prompt", "messages", "content", "arguments", "apiKey", "authorization", "records"]) {
      expect(line.includes(`"${forbidden}"`), forbidden).toBe(false);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
