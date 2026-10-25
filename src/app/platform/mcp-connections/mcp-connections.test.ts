/**
 * Issue #1126 §A — static pins for the Superadmin MCP connect surface.
 *
 * What these hold honest without a browser or a database:
 *
 *   * the token's secrecy shape: React state only — never browser storage,
 *     never a URL, never a log, never echoed back by the diagnostic route;
 *   * the route wiring the page depends on (endpoint derivation, guarded
 *     diagnosis);
 *   * the client-bundle direction: the panels import the pure config module,
 *     never the database-backed server module.
 *
 * Written as source assertions in the `api-guards.test.ts` style: the
 * property that matters is structural ("this file cannot do X"), and a
 * render test would only prove one run did not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceOf(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8");
}

const page = () => sourceOf("src/app/platform/mcp-connections/page.tsx");
const panel = () => sourceOf("src/app/platform/mcp-connections/connect-panel.tsx");
const listRoute = () => sourceOf("src/app/api/platform/mcp-connections/route.ts");
const testRoute = () => sourceOf("src/app/api/platform/mcp-connections/test/route.ts");

describe("issue #1126 — token secrecy shape", () => {
  it("keeps the token in React state only, never browser storage", () => {
    for (const [name, source] of [
      ["page.tsx", page()],
      ["connect-panel.tsx", panel()],
    ] as const) {
      expect(source, `${name} must not use localStorage`).not.toContain("localStorage");
      expect(source, `${name} must not use sessionStorage`).not.toContain("sessionStorage");
      expect(source, `${name} must not use IndexedDB`).not.toContain("indexedDB");
      expect(source, `${name} must not touch cookies`).not.toContain("document.cookie");
    }
  });

  it("never puts the token in a URL, an HTML attribute, or a log", () => {
    for (const [name, source] of [
      ["page.tsx", page()],
      ["connect-panel.tsx", panel()],
    ] as const) {
      expect(source, `${name}: no token query param`).not.toContain("?token=");
      expect(source, `${name}: no token interpolation into a URL`).not.toMatch(/token=\$\{|id=\$\{token/);
      expect(source, `${name}: no token in an HTML attribute`).not.toMatch(/(title|aria-|data-)=\{[^}]*token[^}]*\}/);
      expect(source, `${name}: no console logging`).not.toMatch(/console\.(log|debug|info)\(/);
    }
  });

  it("dismisses the issuance by dropping state, and says the token is shown once", () => {
    expect(page()).toContain("onDismiss={() => setToken(null)}");
    expect(panel()).toContain("فقط همین‌بار");
    expect(panel()).toContain("دوباره نمایش داده نمی‌شود");
  });

  it("never echoes the token back from the diagnostic route", () => {
    const source = testRoute();
    expect(source).toContain("Cache-Control");
    expect(source).toContain("no-store");
    // The token is looked up by hash and never serialized into a response.
    expect(source).not.toMatch(/token:\s*token/);
    expect(source).not.toContain("token }");
    expect(source).not.toMatch(/console\.(log|debug|info)\(/);
  });
});

describe("issue #1126 — route wiring the panels depend on", () => {
  it("derives the canonical endpoint from the request in the list route", () => {
    expect(listRoute()).toContain("platformMcpEndpointFromHeaders(request.headers");
    expect(listRoute()).toContain("endpointWarnings");
  });

  it("guards the diagnostic route with the platform session, not the bearer", () => {
    // A bearer guard here would be circular: the route exists to explain why
    // a bearer does NOT work. The session is the authentication.
    expect(testRoute()).toContain("requirePlatformAdmin(");
    expect(testRoute()).toContain("diagnosePlatformMcpToken(token)");
    expect(testRoute()).not.toContain("authenticatePlatformMcp(");
  });

  it("bounds the diagnosed input before hashing", () => {
    expect(testRoute()).toContain("MAX_TOKEN_LENGTH");
    expect(testRoute()).toContain("invalid_token");
  });
});

describe("issue #1126 — client-bundle direction", () => {
  it("imports the pure config module from the panels, never the database-backed server module", () => {
    expect(panel()).toContain("@/lib/mcp/platform-client-config");
    expect(panel()).not.toContain("mcp/platform-mcp");
    expect(page()).not.toContain("mcp/platform-mcp");
  });

  it("renders code LTR inside the RTL page", () => {
    expect(panel()).toContain('<pre dir="ltr"');
    expect(panel()).toContain('dir="ltr"');
    expect(page()).toContain('dir="ltr"');
  });

  it("shows placeholders in the permanent guide, populated configs only at issuance", () => {
    // The connect panel builds its permanent examples without a token
    // argument (the builder defaults to the placeholder)...
    expect(panel()).toContain("buildPlatformMcpDirectHttpConfig(displayEndpoint)");
    expect(panel()).toContain("buildPlatformMcpClaudeDesktopConfig(displayEndpoint)");
    expect(panel()).toContain("buildPlatformMcpCodexConfig(displayEndpoint)");
    // ...and passes the real token only in the issuance panel.
    expect(panel()).toContain("buildPlatformMcpDirectHttpConfig(displayEndpoint, { token })");
    expect(panel()).toContain("buildPlatformMcpClaudeDesktopConfig(displayEndpoint, { token })");
    expect(panel()).toContain("buildPlatformMcpCodexExport({ token })");
  });
});
