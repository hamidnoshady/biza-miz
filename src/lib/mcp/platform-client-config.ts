/**
 * Issue #1126 §A — the Superadmin MCP endpoint's client-facing configuration.
 *
 * The tenant realm hands an owner two things on its Connections page: the
 * address to point a client at, and the config text to paste. The platform
 * realm minted `pospmcp_` bearer credentials with neither, so this module is
 * the missing half: the canonical endpoint derivation plus the ready-to-copy
 * client configurations for the transports we support.
 *
 * Pure and dependency-light on purpose: the console page (`"use client"`)
 * imports the builders, while the API route derives the endpoint from the
 * request headers. Nothing here touches the database or a `node:` builtin,
 * so the client-bundle boundary test keeps passing (see
 * `src/lib/client-bundle-boundary.test.ts`).
 *
 * Direction, stated once because §B exists: everything here configures a
 * third-party AI client **towards** this platform (`client → platform MCP`).
 * Minting a token never attaches an MCP server as a tool provider to this
 * platform's own system agents (`platform-agent → tool provider`) — that is
 * the separate, explicitly-approved §B feature, and there is deliberately no
 * helper here that would make it implicit.
 */
import {
  ADMIN_HOST_LABEL,
  parseHost,
  preferredProto,
  resolveRequestHost,
  subdomainRoutingEnabled,
} from "../host";
import { resolvePlatformBaseUrl } from "../deployment-role";

/** The platform MCP route. External clients POST JSON-RPC here; the console's own wire test fetches it relatively. */
export const PLATFORM_MCP_PATH = "/api/platform/mcp";

/** The server key used in every generated client configuration. */
export const PLATFORM_MCP_SERVER_NAME = "biza-miz-superadmin";

/**
 * The console credential family. Canonical home of the constant: the
 * server-side `platform-mcp.ts` imports it from here so the mint format, the
 * route's prefix firewall and these client configs can never drift apart.
 */
export const PLATFORM_MCP_TOKEN_PREFIX = "pospmcp_";

/**
 * The tenant credential family (`posmcp_…`, including the OAuth `posmcp_at_…`
 * / `posmcp_rt_…` / `posmcp_ac_…` shapes, which all share the stem). A
 * client-safe mirror of `MCP_TOKEN_PREFIX` from `./oauth` — that module
 * imports `node:crypto`, which a `"use client"` file may not reach, so the
 * literal lives here and `platform-client-config.test.ts` pins the two equal.
 */
export const TENANT_MCP_TOKEN_PREFIX = "posmcp_";

/** The placeholder every permanent (non-issuance) example carries instead of a real token. */
export const PLATFORM_MCP_TOKEN_PLACEHOLDER = "pospmcp_REPLACE_WITH_YOUR_TOKEN";

/** The environment variable the generated Codex configuration reads the bearer token from. */
export const PLATFORM_MCP_CODEX_ENV_VAR = "BIZAMIZ_SUPERADMIN_MCP_TOKEN";

/**
 * Template endpoint used only when no canonical endpoint could be derived
 * (unconfigured deployment). Never a real host: the operator must replace it.
 */
export const PLATFORM_MCP_ENDPOINT_FALLBACK = `https://YOUR-PLATFORM-HOST${PLATFORM_MCP_PATH}`;

/* ------------------------------------------------------------------------- */
/* Canonical endpoint derivation                                             */
/* ------------------------------------------------------------------------- */

/** Just the variables the endpoint derivation reads, so it stays pure. */
export interface PlatformMcpEndpointEnv {
  ROOT_DOMAIN?: string;
  SUBDOMAIN_ROUTING?: string;
  TRUST_FORWARDED_HOST?: string;
  PLATFORM_BASE_URL?: string;
  POS_DOMAIN?: string;
}

/** The request facts the derivation reads — headers plus the request's own scheme. */
export interface PlatformMcpEndpointRequest {
  host: string | null | undefined;
  forwardedHost: string | null | undefined;
  forwardedProto: string | null | undefined;
  /** `new URL(request.url).protocol`, e.g. `"https:"`. */
  requestProtocol: string;
}

export type PlatformMcpEndpointWarning =
  /** The request arrived on a tenant host; the canonical admin origin is advertised instead. */
  | "tenant_host"
  /** The request arrived on a non-admin platform host (the apex); the admin origin is advertised instead. */
  | "non_admin_host"
  /** The request host is not under ROOT_DOMAIN; the admin origin is advertised instead. */
  | "unknown_host"
  /** A loopback origin — correct for local development, never for a real client. */
  | "loopback"
  /** Plain HTTP on a non-loopback host — the proxy is not declaring TLS. */
  | "insecure_http"
  /** No host and no configured base URL — nothing canonical could be derived. */
  | "unconfigured";

export interface PlatformMcpEndpointResolution {
  /** The canonical `https://…/api/platform/mcp` URL, or `""` when unconfigured. */
  endpoint: string;
  /** The origin the endpoint hangs off, or `""` when unconfigured. */
  origin: string;
  warnings: PlatformMcpEndpointWarning[];
}

/**
 * The canonical public MCP endpoint for this deployment.
 *
 * Two shapes, matching how the console itself is served (see middleware's
 * `handlePlatformAdmin`):
 *
 *   * **Host routing on.** The console lives on `admin.{root}` and nowhere
 *     else — middleware 307s every other host there, and a 307 is not
 *     something a JSON-RPC client survives with its Authorization header, so
 *     the advertised URL must already be the admin origin. A request arriving
 *     on the admin host keeps its own origin (which preserves a non-default
 *     port and the proxy-declared scheme); anything else — tenant host, apex,
 *     unknown — advertises `https://admin.{root}` with a warning naming the
 *     substitution. A tenant host is never advertised: that address serves a
 *     different realm's endpoint with a different credential family.
 *   * **Host routing off** (single-origin install, desktop, `SUBDOMAIN_ROUTING=off`).
 *     The request's own origin is canonical — the same "ask the host" rule the
 *     tenant endpoint and desktop pairing follow. Only when the request
 *     carries no host at all does the configured `PLATFORM_BASE_URL`
 *     (→ `POS_DOMAIN` → `ROOT_DOMAIN`) stand in.
 *
 * `PLATFORM_BASE_URL` deliberately does NOT override a live request origin:
 * it names the platform's apex/central base, and advertising the apex for an
 * endpoint middleware only serves on the admin host would hand every client a
 * redirect. The host itself is read with `resolveRequestHost` — the strict
 * rule the tenancy decision uses — rather than the lenient
 * forwarded-host-first display precedence, so a spoofed forwarded header
 * cannot poison the canonical URL.
 */
export function resolvePlatformMcpEndpoint(
  request: PlatformMcpEndpointRequest,
  env: PlatformMcpEndpointEnv,
): PlatformMcpEndpointResolution {
  const warnings: PlatformMcpEndpointWarning[] = [];
  const proto = preferredProto(request.forwardedProto, request.requestProtocol);
  const host = resolveRequestHost(request.host, request.forwardedHost, env).trim();

  if (subdomainRoutingEnabled(env)) {
    const root = (env.ROOT_DOMAIN ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    const parsed = parseHost(host, root);
    if (parsed.kind === "admin" && host) {
      const origin = `${proto}://${host}`;
      if (isLoopbackHost(host)) warnings.push("loopback");
      else if (proto !== "https") warnings.push("insecure_http");
      return { endpoint: `${origin}${PLATFORM_MCP_PATH}`, origin, warnings };
    }
    if (parsed.kind === "business") warnings.push("tenant_host");
    else if (parsed.kind === "apex") warnings.push("non_admin_host");
    else warnings.push("unknown_host");
    const origin = `https://${ADMIN_HOST_LABEL}.${root}`;
    return { endpoint: `${origin}${PLATFORM_MCP_PATH}`, origin, warnings };
  }

  if (host) {
    const origin = `${proto}://${host}`;
    if (isLoopbackHost(host)) warnings.push("loopback");
    else if (proto !== "https") warnings.push("insecure_http");
    return { endpoint: `${origin}${PLATFORM_MCP_PATH}`, origin, warnings };
  }
  const configured = resolvePlatformBaseUrl(env);
  if (configured) {
    return { endpoint: `${configured}${PLATFORM_MCP_PATH}`, origin: configured, warnings };
  }
  warnings.push("unconfigured");
  return { endpoint: "", origin: "", warnings };
}

/** The route's convenience wrapper: headers in, canonical endpoint out. */
export function platformMcpEndpointFromHeaders(
  headers: Headers,
  requestUrl: string,
  env: PlatformMcpEndpointEnv = process.env as PlatformMcpEndpointEnv,
): PlatformMcpEndpointResolution {
  let protocol = "https:";
  try {
    protocol = new URL(requestUrl).protocol;
  } catch {
    // An unparseable request URL keeps the https default — the derivation
    // never throws on transport facts, it warns.
  }
  return resolvePlatformMcpEndpoint(
    {
      host: headers.get("host"),
      forwardedHost: headers.get("x-forwarded-host"),
      forwardedProto: headers.get("x-forwarded-proto"),
      requestProtocol: protocol,
    },
    env,
  );
}

function isLoopbackHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/:\d+$/, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare === "::1" || bare === "[::1]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;
  // The documented local root (see host.ts): syntactically a DNS name,
  // effectively loopback. Warn as loopback rather than insecure-http so a
  // local admin host reads as "dev", not "broken proxy".
  if (bare === "localtest.me" || bare.endsWith(".localtest.me")) return true;
  return false;
}

/* ------------------------------------------------------------------------- */
/* Token input classification (client precheck + server diagnosis share this) */
/* ------------------------------------------------------------------------- */

export type PlatformMcpTokenClass =
  | "empty"
  | "platform"
  | "tenant_realm"
  | "malformed";

/**
 * Which credential family a pasted value belongs to, by shape alone.
 *
 * `platform` means "worth a lookup" — nothing more; a revoked, expired or
 * never-minted `pospmcp_` value still fails downstream. `tenant_realm` covers
 * every tenant shape (`posmcp_…`, `posmcp_at_…`, `posmcp_rt_…`,
 * `posmcp_ac_…`): the single most actionable misconfiguration is a tenant
 * token pasted into a platform client, and naming it beats "invalid token".
 */
export function classifyPlatformMcpTokenInput(raw: string | null | undefined): PlatformMcpTokenClass {
  const value = (raw ?? "").trim();
  if (!value) return "empty";
  if (value.startsWith(PLATFORM_MCP_TOKEN_PREFIX)) return "platform";
  if (value.startsWith(TENANT_MCP_TOKEN_PREFIX)) return "tenant_realm";
  return "malformed";
}

/* ------------------------------------------------------------------------- */
/* Client configurations                                                     */
/* ------------------------------------------------------------------------- */

export interface PlatformMcpClientConfigOptions {
  /**
   * The bearer token to embed. Pass the real token ONLY in the one-time
   * issuance context, with the secret-handling warning beside it; everywhere
   * else omit it and the placeholder is used. The Codex TOML never embeds a
   * token at all — it reads the environment (see `buildPlatformMcpCodexExport`).
   */
  token?: string;
}

function bearerFor(token: string | undefined): string {
  const value = (token ?? "").trim() || PLATFORM_MCP_TOKEN_PLACEHOLDER;
  return `Bearer ${value}`;
}

/**
 * Direct streamable-HTTP JSON for config-file clients that accept a URL plus
 * headers (Claude Code's `.mcp.json`). Built with `JSON.stringify`, so the
 * escaping is the serializer's, not ours.
 */
export function buildPlatformMcpDirectHttpConfig(
  endpoint: string,
  options: PlatformMcpClientConfigOptions = {},
): string {
  return JSON.stringify(
    {
      mcpServers: {
        [PLATFORM_MCP_SERVER_NAME]: {
          type: "http",
          url: endpoint,
          headers: { Authorization: bearerFor(options.token) },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Claude Desktop's `claude_desktop_config.json` shape. Desktop only accepts
 * `command` (stdio) servers and rejects the direct-HTTP object as invalid, so
 * this bridges through `mcp-remote` (Node.js required) with the token carried
 * in the child process environment — the same pattern the tenant panel uses.
 */
export function buildPlatformMcpClaudeDesktopConfig(
  endpoint: string,
  options: PlatformMcpClientConfigOptions = {},
): string {
  return JSON.stringify(
    {
      mcpServers: {
        [PLATFORM_MCP_SERVER_NAME]: {
          command: "npx",
          args: ["-y", "mcp-remote", endpoint, "--header", "Authorization:${AUTH_HEADER}"],
          env: { AUTH_HEADER: bearerFor(options.token) },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Codex's `~/.codex/config.toml` (or project `.codex/config.toml`) streamable-HTTP
 * form: `url` selects the transport, `bearer_token_env_var` names the variable
 * Codex reads at connect time and sends as `Authorization: Bearer …`.
 * Supplying `command` alongside `url` is a configuration error in Codex, so
 * this emits exactly one of the two shapes — never both.
 */
export function buildPlatformMcpCodexConfig(endpoint: string): string {
  return (
    `[mcp_servers.${PLATFORM_MCP_SERVER_NAME}]\n` +
    `url = ${tomlString(endpoint)}\n` +
    `bearer_token_env_var = ${tomlString(PLATFORM_MCP_CODEX_ENV_VAR)}\n`
  );
}

/**
 * The shell companion to the Codex TOML: exports the bearer token the config
 * above names. The only generated snippet that may carry a real token for
 * Codex — `config.toml` itself stays secret-free.
 */
export function buildPlatformMcpCodexExport(options: PlatformMcpClientConfigOptions = {}): string {
  const value = (options.token ?? "").trim() || PLATFORM_MCP_TOKEN_PLACEHOLDER;
  return `export ${PLATFORM_MCP_CODEX_ENV_VAR}=${shellString(value)}`;
}

/** A TOML basic string, escaped. */
export function tomlString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\b", "\\b")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\f", "\\f")
    .replaceAll("\r", "\\r")}"`;
}

/** A POSIX-shell double-quoted string, escaped. */
export function shellString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}
