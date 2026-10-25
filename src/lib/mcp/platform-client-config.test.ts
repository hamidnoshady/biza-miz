/**
 * Issue #1126 §A — the Superadmin MCP endpoint's client-facing configuration.
 *
 * Pins three things:
 *
 *   1. The canonical endpoint derivation — admin-origin-only when host routing
 *      is on, request-origin passthrough when off, and never a tenant host.
 *   2. The generated client configurations — valid, correctly escaped, with a
 *      placeholder by default and a real token only when the caller passes one.
 *   3. The direction (§A vs §B): these configs point a third-party client AT
 *      this platform, and nothing here attaches an MCP provider TO this
 *      platform's own agents.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_TOKEN_PREFIX } from "./oauth";
import { agentToolsForTurn } from "../ai-system-agents";import {
  PLATFORM_MCP_CODEX_ENV_VAR,
  PLATFORM_MCP_ENDPOINT_FALLBACK,
  PLATFORM_MCP_PATH,
  PLATFORM_MCP_SERVER_NAME,
  PLATFORM_MCP_TOKEN_PLACEHOLDER,
  PLATFORM_MCP_TOKEN_PREFIX,
  TENANT_MCP_TOKEN_PREFIX,
  buildPlatformMcpClaudeDesktopConfig,
  buildPlatformMcpCodexConfig,
  buildPlatformMcpCodexExport,
  buildPlatformMcpDirectHttpConfig,
  classifyPlatformMcpTokenInput,
  platformMcpEndpointFromHeaders,
  resolvePlatformMcpEndpoint,
  shellString,
  tomlString,
  type PlatformMcpEndpointRequest,
} from "./platform-client-config";

const TOKEN = `${PLATFORM_MCP_TOKEN_PREFIX}0123456789abcdef0123456789abcdef01234567`;

function req(overrides: Partial<PlatformMcpEndpointRequest> = {}): PlatformMcpEndpointRequest {
  return {
    host: "admin.app.eshobe.com",
    forwardedHost: null,
    forwardedProto: "https",
    requestProtocol: "https:",
    ...overrides,
  };
}

describe("credential-family constants", () => {
  it("shares the platform prefix with the server module by import, not by copy", () => {
    // The mint format, the route's prefix firewall and these configs must be
    // unable to drift: platform-mcp.ts imports the constant from the
    // client-safe module instead of spelling the literal a second time.
    const serverSource = readFileSync(join(process.cwd(), "src/lib/mcp/platform-mcp.ts"), "utf8");
    expect(serverSource).toContain('from "./platform-client-config"');
    expect(serverSource).toContain("PLATFORM_MCP_TOKEN_PREFIX");
    expect(serverSource).not.toContain('"pospmcp_"');
    expect(serverSource).not.toContain("'pospmcp_'");
  });

  it("mirrors the tenant prefix exactly", () => {
    expect(TENANT_MCP_TOKEN_PREFIX).toBe(MCP_TOKEN_PREFIX);
  });

  it("keeps the two families disjoint at the fourth character", () => {
    expect(TOKEN.startsWith(TENANT_MCP_TOKEN_PREFIX)).toBe(false);
    expect(`${TENANT_MCP_TOKEN_PREFIX}abc`.startsWith(PLATFORM_MCP_TOKEN_PREFIX)).toBe(false);
  });

  it("stays importable from a client component", () => {
    // The console page imports the builders; a `node:` or pool import here
    // would break `next build` (see client-bundle-boundary.test.ts).
    const source = readFileSync(join(process.cwd(), "src/lib/mcp/platform-client-config.ts"), "utf8");
    expect(source).not.toMatch(/from\s+"node:/);
    expect(source).not.toMatch(/from\s+"(\.\.\/)+db"/);
  });
});

describe("resolvePlatformMcpEndpoint — host routing on", () => {
  const env = { ROOT_DOMAIN: "app.eshobe.com" };

  it("keeps the admin origin, including a non-default port", () => {
    const resolved = resolvePlatformMcpEndpoint(req(), env);
    expect(resolved.endpoint).toBe(`https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`);
    expect(resolved.warnings).toEqual([]);
  });

  it("keeps the proxy-declared scheme and port on a dev admin host", () => {
    const resolved = resolvePlatformMcpEndpoint(
      req({ host: "admin.localtest.me:3000", forwardedProto: "http", requestProtocol: "http:" }),
      { ROOT_DOMAIN: "localtest.me" },
    );
    expect(resolved.endpoint).toBe(`http://admin.localtest.me:3000${PLATFORM_MCP_PATH}`);
    expect(resolved.warnings).toEqual(["loopback"]);
  });

  it("never advertises a tenant host — it substitutes the admin origin", () => {
    const resolved = resolvePlatformMcpEndpoint(req({ host: "titea.app.eshobe.com" }), env);
    expect(resolved.endpoint).toBe(`https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`);
    expect(resolved.endpoint).not.toContain("titea");
    expect(resolved.warnings).toEqual(["tenant_host"]);
  });

  it("substitutes the admin origin for the apex too (middleware would 307 a client there)", () => {
    const resolved = resolvePlatformMcpEndpoint(req({ host: "app.eshobe.com" }), env);
    expect(resolved.endpoint).toBe(`https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`);
    expect(resolved.warnings).toEqual(["non_admin_host"]);
  });

  it("substitutes the admin origin for a host outside the root", () => {
    const resolved = resolvePlatformMcpEndpoint(req({ host: "stale.eshobe.com" }), env);
    expect(resolved.endpoint).toBe(`https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`);
    expect(resolved.warnings).toEqual(["unknown_host"]);
  });

  it("reads the host with the strict tenancy rule, not the lenient display one", () => {
    // A spoofed X-Forwarded-Host must not poison the canonical URL when the
    // deployment does not trust it.
    const resolved = resolvePlatformMcpEndpoint(
      req({ host: "titea.app.eshobe.com", forwardedHost: "admin.app.eshobe.com" }),
      env,
    );
    expect(resolved.warnings).toEqual(["tenant_host"]);
    expect(resolved.endpoint).toBe(`https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`);
  });

  it("honours X-Forwarded-Host where the edge rewrites Host", () => {
    const resolved = resolvePlatformMcpEndpoint(
      req({ host: "web-1.internal:3000", forwardedHost: "admin.app.eshobe.com" }),
      { ...env, TRUST_FORWARDED_HOST: "on" },
    );
    expect(resolved.endpoint).toBe(`https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`);
    expect(resolved.warnings).toEqual([]);
  });

  it("warns on plain HTTP to a public admin host instead of forcing https", () => {
    const resolved = resolvePlatformMcpEndpoint(req({ forwardedProto: "http", requestProtocol: "http:" }), env);
    expect(resolved.endpoint).toBe(`http://admin.app.eshobe.com${PLATFORM_MCP_PATH}`);
    expect(resolved.warnings).toEqual(["insecure_http"]);
  });

  it("does not let PLATFORM_BASE_URL override the live admin origin", () => {
    // The configured base names the apex/central host; advertising it for an
    // endpoint middleware only serves on the admin host would hand every
    // client a redirect.
    const resolved = resolvePlatformMcpEndpoint(req(), {
      ...env,
      PLATFORM_BASE_URL: "https://pos.eshobe.com",
    });
    expect(resolved.endpoint).toBe(`https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`);
  });
});

describe("resolvePlatformMcpEndpoint — routing off / single origin", () => {
  it("passes the request origin through when no root is configured", () => {
    const resolved = resolvePlatformMcpEndpoint(req({ host: "pos.my-cafe.ir" }), {});
    expect(resolved.endpoint).toBe(`https://pos.my-cafe.ir${PLATFORM_MCP_PATH}`);
    expect(resolved.warnings).toEqual([]);
  });

  it("passes the origin through with SUBDOMAIN_ROUTING=off even when a root is set", () => {
    const resolved = resolvePlatformMcpEndpoint(req({ host: "pos.my-cafe.ir" }), {
      ROOT_DOMAIN: "app.eshobe.com",
      SUBDOMAIN_ROUTING: "off",
    });
    expect(resolved.endpoint).toBe(`https://pos.my-cafe.ir${PLATFORM_MCP_PATH}`);
    expect(resolved.warnings).toEqual([]);
  });

  it("marks loopback origins as dev-only", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      const resolved = resolvePlatformMcpEndpoint(
        req({ host, forwardedProto: "http", requestProtocol: "http:" }),
        {},
      );
      expect(resolved.warnings, host).toEqual(["loopback"]);
    }
  });

  it("falls back to the configured base only when the request carries no host", () => {
    const resolved = resolvePlatformMcpEndpoint(req({ host: "" }), {
      PLATFORM_BASE_URL: "https://central.example.com/",
    });
    expect(resolved.endpoint).toBe(`https://central.example.com${PLATFORM_MCP_PATH}`);
    expect(resolved.warnings).toEqual([]);
  });

  it("reports unconfigured when there is neither a host nor a base", () => {
    const resolved = resolvePlatformMcpEndpoint(req({ host: "" }), {});
    expect(resolved.endpoint).toBe("");
    expect(resolved.warnings).toEqual(["unconfigured"]);
  });
});

describe("platformMcpEndpointFromHeaders", () => {
  it("reads a real Headers object", () => {
    const headers = new Headers({
      host: "admin.app.eshobe.com",
      "x-forwarded-proto": "https",
    });
    const resolved = platformMcpEndpointFromHeaders(headers, "https://admin.app.eshobe.com/api/platform/mcp-connections", {
      ROOT_DOMAIN: "app.eshobe.com",
    });
    expect(resolved.endpoint).toBe(`https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`);
  });

  it("survives an unparseable request URL with the https default", () => {
    const headers = new Headers({ host: "pos.my-cafe.ir" });
    const resolved = platformMcpEndpointFromHeaders(headers, "::::", {});
    expect(resolved.endpoint).toBe(`https://pos.my-cafe.ir${PLATFORM_MCP_PATH}`);
  });
});

describe("classifyPlatformMcpTokenInput", () => {
  it("classifies by shape alone", () => {
    expect(classifyPlatformMcpTokenInput(null)).toBe("empty");
    expect(classifyPlatformMcpTokenInput("   ")).toBe("empty");
    expect(classifyPlatformMcpTokenInput(TOKEN)).toBe("platform");
    expect(classifyPlatformMcpTokenInput(`  ${TOKEN}\n`)).toBe("platform");
    expect(classifyPlatformMcpTokenInput("posk_live_abc")).toBe("malformed");
    expect(classifyPlatformMcpTokenInput("Bearer ")).toBe("malformed");
  });

  it("names every tenant shape as the wrong realm", () => {
    for (const prefix of ["posmcp_", "posmcp_at_", "posmcp_rt_", "posmcp_ac_"]) {
      expect(classifyPlatformMcpTokenInput(`${prefix}abc`), prefix).toBe("tenant_realm");
    }
  });
});

describe("direct-HTTP config (Claude Code .mcp.json and friends)", () => {
  const endpoint = `https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`;

  it("matches the issue's shape with the placeholder by default", () => {
    const parsed = JSON.parse(buildPlatformMcpDirectHttpConfig(endpoint)) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    expect(parsed.mcpServers[PLATFORM_MCP_SERVER_NAME]).toEqual({
      type: "http",
      url: endpoint,
      headers: { Authorization: `Bearer ${PLATFORM_MCP_TOKEN_PLACEHOLDER}` },
    });
  });

  it("embeds a real token only when the caller passes one (one-time issuance)", () => {
    const withToken = buildPlatformMcpDirectHttpConfig(endpoint, { token: TOKEN });
    expect(withToken).toContain(`Bearer ${TOKEN}`);
    expect(withToken).not.toContain(PLATFORM_MCP_TOKEN_PLACEHOLDER);
    expect(buildPlatformMcpDirectHttpConfig(endpoint)).not.toContain(TOKEN);
  });
});

describe("Claude Desktop config (mcp-remote)", () => {
  const endpoint = `https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`;

  it("emits the stdio bridge Desktop requires, token in the child environment", () => {
    const parsed = JSON.parse(buildPlatformMcpClaudeDesktopConfig(endpoint)) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const server = parsed.mcpServers[PLATFORM_MCP_SERVER_NAME];
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "mcp-remote", endpoint, "--header", "Authorization:${AUTH_HEADER}"]);
    expect(server.env).toEqual({ AUTH_HEADER: `Bearer ${PLATFORM_MCP_TOKEN_PLACEHOLDER}` });
  });

  it("populates the environment value for a one-time issuance", () => {
    const text = buildPlatformMcpClaudeDesktopConfig(endpoint, { token: TOKEN });
    expect(text).toContain(`Bearer ${TOKEN}`);
    // The variable reference itself is literal text, never interpolated.
    expect(text).toContain("Authorization:${AUTH_HEADER}");
  });
});

describe("Codex config (config.toml)", () => {
  const endpoint = `https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`;

  it("emits the streamable-HTTP table with the token in the environment, never the file", () => {
    const text = buildPlatformMcpCodexConfig(endpoint);
    expect(text).toContain(`[mcp_servers.${PLATFORM_MCP_SERVER_NAME}]`);
    expect(text).toContain(`url = "${endpoint}"`);
    expect(text).toContain(`bearer_token_env_var = "${PLATFORM_MCP_CODEX_ENV_VAR}"`);
    // `command` + `url` together is a configuration error in Codex: exactly
    // one transport shape, never both.
    expect(text).not.toContain("command");
    expect(text).not.toContain(PLATFORM_MCP_TOKEN_PLACEHOLDER);
    expect(text).not.toContain(TOKEN);
  });

  it("exports the token the TOML names, placeholder by default", () => {
    expect(buildPlatformMcpCodexExport()).toBe(
      `export ${PLATFORM_MCP_CODEX_ENV_VAR}="${PLATFORM_MCP_TOKEN_PLACEHOLDER}"`,
    );
    expect(buildPlatformMcpCodexExport({ token: TOKEN })).toBe(
      `export ${PLATFORM_MCP_CODEX_ENV_VAR}="${TOKEN}"`,
    );
  });
});

describe("escaping", () => {
  it("quotes TOML basic strings", () => {
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(tomlString("line\nbreak")).toBe('"line\\nbreak"');
  });

  it("quotes shell double-quoted strings", () => {
    expect(shellString("a$b`c\"d\\e")).toBe('"a\\$b\\`c\\"d\\\\e"');
  });

  it("survives hostile input through the JSON builders", () => {
    const evil = 'https://x.example"/}, {"evil": "1';
    for (const built of [
      buildPlatformMcpDirectHttpConfig(evil, { token: 't"x' }),
      buildPlatformMcpClaudeDesktopConfig(evil, { token: 't"x' }),
    ]) {
      const parsed = JSON.parse(built) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(parsed.mcpServers)).toEqual([PLATFORM_MCP_SERVER_NAME]);
      expect(built).toContain('\\"');
    }
  });
});

describe("direction — client→platform (§A) is not platform-agent→provider (§B)", () => {
  const endpoint = `https://admin.app.eshobe.com${PLATFORM_MCP_PATH}`;
  const generated = [
    buildPlatformMcpDirectHttpConfig(endpoint),
    buildPlatformMcpClaudeDesktopConfig(endpoint),
    buildPlatformMcpCodexConfig(endpoint),
  ];

  it("points every generated config at the platform endpoint with a platform bearer", () => {
    for (const text of generated) {
      expect(text).toContain(PLATFORM_MCP_PATH);
      expect(text).toContain(PLATFORM_MCP_SERVER_NAME);
    }
    // The tenant endpoint path and the tenant credential stem appear nowhere:
    // `"url": "…/api/mcp"` (with the closing quote) is the tenant shape, and
    // `/api/platform/mcp` must not match it.
    for (const text of generated) {
      expect(text).not.toContain('"/api/mcp"');
      expect(text).not.toContain(`${TENANT_MCP_TOKEN_PREFIX} `);
      expect(text).not.toContain(TENANT_MCP_TOKEN_PLACEHOLDER_GUARD());
    }
  });

  it("advertises no OAuth flow — this realm is a static bearer, unlike the tenant one", () => {
    for (const text of generated) {
      expect(text.toLowerCase()).not.toContain("oauth");
      expect(text).not.toContain("client_id");
      expect(text).not.toContain("authorize");
      expect(text).not.toContain("token_endpoint");
      expect(text).not.toContain("pkce");
    }
  });

  it("leaves the platform's own agents untouched: MCP names never enter the native tool intersection", () => {
    // An agent allowlist naming an "MCP tool" narrows to nothing it names —
    // the runtime intersects the NATIVE catalogue, so a token minted for an
    // external client cannot smuggle a provider into an agent turn.
    const narrowed = agentToolsForTurn({
      agent: { allowedTools: ["mcp__external__invoice", "run_report"], allowedActions: [] },
      platformTools: ["run_report", "get_ar_aging"],
      platformActions: [],
    });
    expect(narrowed.tools).toEqual(["run_report"]);
    const onlyForeign = agentToolsForTurn({
      agent: { allowedTools: ["mcp__external__invoice"], allowedActions: [] },
      platformTools: ["run_report"],
      platformActions: [],
    });
    expect(onlyForeign.tools).toEqual([]);
  });

  it("falls back to a replace-me template, never a real host, when unconfigured", () => {
    expect(PLATFORM_MCP_ENDPOINT_FALLBACK).toBe(`https://YOUR-PLATFORM-HOST${PLATFORM_MCP_PATH}`);
    expect(() => new URL(PLATFORM_MCP_ENDPOINT_FALLBACK)).not.toThrow();
  });
});

/** A tenant-stem probe that cannot false-positive on `pospmcp_…` text. */
function TENANT_MCP_TOKEN_PLACEHOLDER_GUARD(): string {
  return `${TENANT_MCP_TOKEN_PREFIX}REPLACE`;
}
