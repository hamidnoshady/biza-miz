/**
 * Pure-function tests for the OpenObserve helpers — SQL shaping, escaping,
 * response parsing, and the search window. The network paths (shipper,
 * zoSearch) are deliberately not exercised here; their correctness at the
 * wire level is covered by scripts/dev-openobserve.mjs, which speaks the same
 * documented contract, and by the manual checklist in docs/deployment/openobserve.md.
 */
import { describe, expect, it } from "vitest";
import {
  buildLevelCountQuery,
  buildLogQuery,
  clampWindow,
  parseRows,
  sqlIdent,
  sqlLiteral,
} from "./observability";

describe("sqlLiteral / sqlIdent", () => {
  it("doubles single quotes and never breaks out of the literal", () => {
    expect(sqlLiteral("plain")).toBe("'plain'");
    expect(sqlLiteral("don't")).toBe("'don''t'");
    expect(sqlLiteral("'; DROP TABLE users; --")).toBe("'''; DROP TABLE users; --'");
  });

  it("doubles embedded double quotes in identifiers", () => {
    expect(sqlIdent('we"ird')).toBe('"we""ird"');
  });
});

describe("buildLogQuery", () => {
  it("omits WHERE when unfiltered and orders newest first", () => {
    expect(buildLogQuery({ stream: "app_logs" })).toBe(
      'SELECT * FROM "app_logs" ORDER BY _timestamp DESC',
    );
  });

  it("combines level, message search and host with AND", () => {
    const sql = buildLogQuery({ stream: "s", level: "error", q: "timeout", host: "cafe2" });
    expect(sql).toContain("WHERE level = 'error'");
    expect(sql).toContain("str_match(message, 'timeout')");
    expect(sql).toContain("host = 'cafe2'");
    expect(sql).toContain("ORDER BY _timestamp DESC");
  });

  it("treats level 'all' as no level filter", () => {
    expect(buildLogQuery({ stream: "s", level: "all" })).not.toContain("WHERE");
  });

  it("escapes a quotey search term instead of injecting it", () => {
    const sql = buildLogQuery({ stream: "s", q: "'; DROP" });
    expect(sql).toContain("str_match(message, '''; DROP')");
  });

  it("counts by level for the toolbar chips", () => {
    expect(buildLevelCountQuery({ stream: "s" })).toBe(
      'SELECT level, COUNT(*) AS cnt FROM "s" GROUP BY level',
    );
    expect(buildLevelCountQuery({ stream: "s", q: "x" })).toContain("WHERE str_match(message, 'x')");
  });
});

describe("clampWindow", () => {
  const now = Date.UTC(2026, 7, 29, 12, 0, 0);

  it("clamps starts older than 31 days and futures", () => {
    const clamped = clampWindow(now - 400 * 86400000, now + 5000, now);
    expect(clamped.startMs).toBe(now - 31 * 86400000);
    expect(clamped.endMs).toBe(now + 5000);
  });

  it("falls back to a six hour window on garbage input", () => {
    const fallback = clampWindow(Number.NaN, Number.NaN, now);
    expect(fallback.endMs - fallback.startMs).toBe(6 * 60 * 60 * 1000);
  });

  it("keeps an end at least a second past the start", () => {
    const win = clampWindow(now - 60000, now - 60000, now);
    expect(win.endMs).toBeGreaterThan(win.startMs);
  });
});

describe("parseRows", () => {
  it("accepts both documented response shapes", () => {
    expect(parseRows({ results: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(parseRows({ hits: [{ b: 2 }] })).toEqual([{ b: 2 }]);
  });

  it("degrades to an empty list on anything else", () => {
    expect(parseRows(null)).toEqual([]);
    expect(parseRows("{}")).toEqual([]);
    expect(parseRows({ results: "nope" })).toEqual([]);
  });
});
