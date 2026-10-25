import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CSP_REPORT_MAX_BYTES } from "@/lib/csp-report";
import { POST } from "./route";

/**
 * Issue #1003 — the collector the CSP's `report-uri`/`report-to` point at.
 * Session-less by necessity, so the contract is about what it does NOT do:
 * it answers the same empty 204 to everything, and only a genuine violation
 * produces a (sanitized) log line.
 */
function post(body: string, contentType = "application/csp-report") {
  return POST(
    new NextRequest("http://localhost/api/csp-report", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("POST /api/csp-report", () => {
  it("logs a violation without its query string and answers 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await post(
      JSON.stringify({
        "csp-report": {
          "document-uri": "https://acme.example.com/invite?token=secret",
          "effective-directive": "connect-src",
          "blocked-uri": "wss://evil.example/x",
          disposition: "enforce",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("connect-src");
    expect(line).toContain("https://acme.example.com/invite");
    expect(line).not.toContain("secret");
  });

  it("answers the same 204 to garbage and to oversized bodies, logging nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const response of [
      await post("not json"),
      await post(JSON.stringify({ hello: "world" }), "application/json"),
      await post(JSON.stringify({ pad: "x".repeat(CSP_REPORT_MAX_BYTES) })),
    ]) {
      expect(response.status).toBe(204);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
