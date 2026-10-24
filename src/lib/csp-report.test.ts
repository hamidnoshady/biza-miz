import { describe, expect, it, vi } from "vitest";
import {
  MAX_REPORTS_PER_REQUEST,
  createCspReportLog,
  parseCspReports,
  sanitizeReportUrl,
  type CspViolation,
} from "./csp-report";

describe("sanitizeReportUrl", () => {
  it("keeps origin and path, never the query string or fragment", () => {
    // A violating page can be a reset/invite link whose token is in the query.
    expect(sanitizeReportUrl("https://acme.example.com/reset-password?token=secret#x")).toBe(
      "https://acme.example.com/reset-password",
    );
    expect(sanitizeReportUrl("wss://evil.example/socket?session=abc")).toBe("wss://evil.example/socket");
  });

  it("keeps the CSP keywords that say which rule fired", () => {
    expect(sanitizeReportUrl("inline")).toBe("inline");
    expect(sanitizeReportUrl("EVAL")).toBe("eval");
    expect(sanitizeReportUrl("trusted-types-sink")).toBe("trusted-types-sink");
  });

  it("reduces non-web URLs to their scheme, and garbage to a label", () => {
    expect(sanitizeReportUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe("data");
    expect(sanitizeReportUrl("blob:https://acme.example.com/1234")).toBe("blob");
    expect(sanitizeReportUrl("chrome-extension://abcdef/inject.js")).toBe("chrome-extension");
    expect(sanitizeReportUrl("not a url")).toBe("invalid");
    expect(sanitizeReportUrl(42)).toBe("");
    expect(sanitizeReportUrl("   ")).toBe("");
  });

  it("bounds the length of what it returns", () => {
    const long = `https://acme.example.com/${"a".repeat(1000)}`;
    expect(sanitizeReportUrl(long).length).toBeLessThanOrEqual(200);
  });
});

describe("parseCspReports", () => {
  it("reads the report-uri format and drops samples, referrers and the policy", () => {
    const [entry, ...rest] = parseCspReports({
      "csp-report": {
        "document-uri": "https://acme.example.com/accounting/pos?order=1",
        referrer: "https://acme.example.com/login?next=%2Fsecret",
        "violated-directive": "script-src-elem",
        "effective-directive": "script-src-elem",
        "original-policy": "default-src 'self'; script-src 'self' 'nonce-abc'",
        disposition: "enforce",
        "blocked-uri": "inline",
        "line-number": 12,
        "column-number": "7",
        "source-file": "https://acme.example.com/accounting/pos?order=1",
        "status-code": 200,
        "script-sample": "self.__next_f.push([1,\"customer: Ali",
      },
    });
    expect(rest).toEqual([]);
    expect(entry).toEqual<CspViolation>({
      disposition: "enforce",
      directive: "script-src-elem",
      blocked: "inline",
      document: "https://acme.example.com/accounting/pos",
      source: "https://acme.example.com/accounting/pos",
      line: 12,
      column: 7,
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("customer");
    expect(serialized).not.toContain("nonce");
    expect(serialized).not.toContain("login");
  });

  it("falls back to the first token of violated-directive when effective-directive is absent", () => {
    const [entry] = parseCspReports({
      "csp-report": {
        "document-uri": "http://127.0.0.1:3000/dashboard",
        "violated-directive": "img-src 'self' data: blob: http: https:",
        "blocked-uri": "ftp://files.example/logo.png",
        disposition: "report",
      },
    });
    expect(entry).toMatchObject({ directive: "img-src", disposition: "report", blocked: "ftp" });
  });

  it("reads a Reporting API batch and ignores other report types", () => {
    const entries = parseCspReports([
      {
        type: "csp-violation",
        url: "https://acme.example.com/kb?x=1",
        body: {
          documentURL: "https://acme.example.com/knowledge/guide?draft=1",
          effectiveDirective: "frame-src",
          blockedURL: "https://videos.example.net/embed/1?t=2",
          disposition: "report",
          lineNumber: 3,
          columnNumber: 9,
          sample: "",
        },
      },
      { type: "deprecation", body: { id: "x", message: "y" } },
      { type: "csp-violation", body: null },
      "not an object",
    ]);
    expect(entries).toEqual<CspViolation[]>([
      {
        disposition: "report",
        directive: "frame-src",
        blocked: "https://videos.example.net/embed/1",
        document: "https://acme.example.com/knowledge/guide",
        line: 3,
        column: 9,
      },
    ]);
  });

  it("bounds how many entries one request can contribute", () => {
    const one = {
      type: "csp-violation",
      body: { documentURL: "https://acme.example.com/", effectiveDirective: "img-src", blockedURL: "data" },
    };
    const batch = Array.from({ length: MAX_REPORTS_PER_REQUEST * 5 }, () => one);
    expect(parseCspReports(batch)).toHaveLength(MAX_REPORTS_PER_REQUEST);
  });

  it("returns nothing for bodies that are not reports", () => {
    for (const body of [null, undefined, 42, "x", {}, { "csp-report": "x" }, { "csp-report": {} }, [{}]]) {
      expect(parseCspReports(body)).toEqual([]);
    }
    // A directive that is not a directive name cannot be smuggled into the log.
    expect(
      parseCspReports({
        "csp-report": { "document-uri": "https://a.example/", "effective-directive": "x\"}\n[forged] line" },
      }),
    ).toEqual([]);
  });
});

describe("createCspReportLog", () => {
  const sample: CspViolation = {
    disposition: "enforce",
    directive: "img-src",
    blocked: "https://cdn.example/a.png",
    document: "https://acme.example.com/",
  };

  it("logs up to the window budget, then summarises what it dropped", () => {
    let clock = 0;
    const lines: string[] = [];
    const log = createCspReportLog({ maxPerWindow: 2, windowMs: 1000, now: () => clock, log: (l) => lines.push(l) });

    log.record([sample, sample, sample]);
    log.record([sample]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`[csp] violation ${JSON.stringify(sample)}`);

    clock = 1000;
    log.record([sample]);
    expect(lines).toEqual([
      `[csp] violation ${JSON.stringify(sample)}`,
      `[csp] violation ${JSON.stringify(sample)}`,
      "[csp] 2 further violation report(s) suppressed in the last window",
      `[csp] violation ${JSON.stringify(sample)}`,
    ]);
  });

  it("writes nothing for an empty batch", () => {
    const log = vi.fn();
    createCspReportLog({ log }).record([]);
    expect(log).not.toHaveBeenCalled();
  });
});
