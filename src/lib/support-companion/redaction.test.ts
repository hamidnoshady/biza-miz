import { describe, expect, it } from "vitest";
import {
  emptyRedactionSummary,
  filterAttributedLines,
  redactValue,
} from "./redaction";

describe("support evidence redaction (issue #984)", () => {
  it("drops blocklisted fields at any depth and counts them", () => {
    const summary = emptyRedactionSummary();
    const out = redactValue(
      {
        code: "DB_UNREACHABLE",
        password: "hunter2",
        nested: { apiKey: "abc", keep: 1 },
        list: [{ token: "t", ok: true }],
      },
      summary,
    );
    expect(out).toEqual({
      code: "DB_UNREACHABLE",
      password: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", keep: 1 },
      list: [{ token: "[REDACTED]", ok: true }],
    });
    expect(summary.blockedFields).toBe(3);
  });

  it("scrubs secret patterns inside free text", () => {
    const summary = emptyRedactionSummary();
    const out = redactValue(
      "connect postgres://pos:s3cret@localhost:5432/pos failed; password: hunter2",
      summary,
    );
    expect(String(out)).not.toContain("s3cret");
    expect(String(out)).not.toContain("hunter2");
    expect(String(out)).toContain("[REDACTED]");
    expect(summary.scrubbedValues).toBe(1);
  });

  it("excludes unattributed installation log lines instead of guessing the tenant", () => {
    const summary = emptyRedactionSummary();
    const kept = filterAttributedLines(
      [
        { text: "tenant job ok", businessId: "biz-a" },
        { text: "shared postgres log line", businessId: null },
        { text: "other tenant line", businessId: "biz-b" },
      ],
      "biz-a",
      summary,
    );
    expect(kept).toEqual(["tenant job ok"]);
    expect(summary.unattributedLines).toBe(2);
  });

  it("leaves plain values untouched", () => {
    const summary = emptyRedactionSummary();
    expect(redactValue({ a: 1, b: [1, 2], c: null }, summary)).toEqual({ a: 1, b: [1, 2], c: null });
    expect(summary).toEqual(emptyRedactionSummary());
  });
});
