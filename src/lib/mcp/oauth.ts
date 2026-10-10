/**
 * The OAuth 2.1 bits of the MCP connector that have no database in them.
 *
 * Why this app runs an authorization server at all: the Claude mobile and
 * desktop apps, and ChatGPT's connectors, add a remote MCP server by asking for
 * one thing — a URL — and then following whatever authorization the server
 * advertises. There is no field to paste an API key into. A business that
 * cannot complete OAuth simply cannot be connected from a phone, which is the
 * main thing the owner asked for. (Codex and other config-file clients *can*
 * send a static bearer header, which is why `mcp_connections` also supports a
 * pasted token — but that path is the exception, not the design.)
 *
 * Scope of this file: PKCE, credential format, redirect-URI matching, and the
 * two discovery documents. Everything here is a pure function of its inputs, so
 * the security-relevant comparisons are unit tested rather than exercised only
 * through a live client.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ALL_MCP_SCOPES, formatMcpScopeString } from "./scopes";

/**
 * Namespaces every credential this server issues, so a public API key
 * (`posk_live_…`) or a server-sync token (`POS1-…`) pasted into an MCP client by
 * mistake is rejected on shape before any lookup happens.
 */
export const MCP_TOKEN_PREFIX = "posmcp_";
export const MCP_ACCESS_TOKEN_PREFIX = "posmcp_at_";
export const MCP_REFRESH_TOKEN_PREFIX = "posmcp_rt_";
export const MCP_CODE_PREFIX = "posmcp_ac_";

/** How much of a credential is safe to store and show. Never enough to authenticate. */
export const MCP_TOKEN_DISPLAY_PREFIX_LENGTH = 18;

function mint(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** A long-lived token an owner pastes into a client config (Codex, a script, an IDE). */
export function createMcpStaticToken(): string {
  return mint(MCP_TOKEN_PREFIX);
}

export function createMcpAccessToken(): string {
  return mint(MCP_ACCESS_TOKEN_PREFIX);
}

export function createMcpRefreshToken(): string {
  return mint(MCP_REFRESH_TOKEN_PREFIX);
}

export function createMcpAuthorizationCode(): string {
  return mint(MCP_CODE_PREFIX);
}

/** SHA-256, matching how api_keys, pairing codes and rollup tokens are all stored. */
export function hashMcpToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function mcpTokenDisplayPrefix(secret: string): string {
  return secret.slice(0, MCP_TOKEN_DISPLAY_PREFIX_LENGTH);
}

/** Shape only — never an authentication decision. Any credential this server minted starts here. */
export function looksLikeMcpToken(raw: string): boolean {
  return raw.trim().startsWith(MCP_TOKEN_PREFIX);
}

/** Extracts exactly one bearer credential belonging to this realm. */
export function parseMcpBearerToken(request: Pick<Request, "headers">): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  const token = match?.[1] ?? null;
  return token && looksLikeMcpToken(token) ? token : null;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/**
 * S256 only.
 *
 * OAuth 2.1 removes the implicit and password grants and requires PKCE on every
 * authorization-code exchange; `plain` is still nominally allowed there but is
 * no protection at all against an intercepted code, and every client that
 * reaches this server supports S256. Refusing `plain` outright means there is no
 * downgrade for an attacker to request.
 */
export const SUPPORTED_CODE_CHALLENGE_METHODS = ["S256"] as const;

export function isSupportedCodeChallengeMethod(value: unknown): boolean {
  return value === "S256";
}

/** A code_challenge is well-formed if it is a base64url string of the right length for a SHA-256 digest. */
export function isValidCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/** RFC 7636 §4.1: the verifier is 43..128 unreserved characters. */
export function isValidCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/**
 * Whether `verifier` is the one the stored `challenge` was derived from.
 *
 * Constant-time: the challenge is the only thing standing between a leaked
 * authorization code and a working token, so the comparison must not leak how
 * much of a guess was right.
 */
export function verifyCodeChallenge(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  const expected = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

/**
 * Whether a registered redirect URI is one this server will send a code to.
 *
 * Three shapes are allowed, which is what real MCP clients use:
 *   - `https://…` — Claude's and ChatGPT's hosted callbacks.
 *   - `http://127.0.0.1[:port]/…` or `http://localhost[:port]/…` — the loopback
 *     redirect a desktop client runs (RFC 8252 §7.3). Plain `http` is correct
 *     here and only here.
 *   - a custom scheme with a dot in it (`com.example.app:/callback`) — the other
 *     RFC 8252 native pattern.
 *
 * Everything else — `javascript:`, `data:`, `file:`, a bare `http://` host —
 * is refused at registration, so an unsafe target never reaches the exact-match
 * check below.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // A fragment is forbidden on a redirect URI (RFC 6749 §3.1.2) and would be
  // silently dropped when the code is appended.
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  }
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/i.test(url.protocol);
}

/**
 * Exact string match against the registered set.
 *
 * Not a prefix match, not a host match, not "same origin". A loose comparison
 * here is the classic way an authorization code is redirected to an attacker's
 * path on a legitimate host, and there is no client that needs the flexibility:
 * every one of them registers the exact URI it will listen on.
 *
 * The one concession is the loopback port, which RFC 8252 §7.3 says a server
 * must ignore because a desktop client binds an ephemeral one it cannot know at
 * registration time.
 */
export function matchesRegisteredRedirectUri(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== "http:") return false;
  if (want.hostname !== "127.0.0.1" && want.hostname !== "localhost" && want.hostname !== "[::1]") {
    return false;
  }
  return registered.some((candidate) => {
    try {
      const have = new URL(candidate);
      return (
        have.protocol === "http:" &&
        have.hostname === want.hostname &&
        have.pathname === want.pathname
      );
    } catch {
      return false;
    }
  });
}

/** Builds the redirect back to the client, preserving `state` exactly as it arrived. */
export function buildRedirect(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Discovery documents
// ---------------------------------------------------------------------------

/**
 * RFC 9728 — protected resource metadata.
 *
 * This is the document a 401 from `/api/mcp` points at, and it is how a client
 * that has never seen this server learns where to authorize. It names the
 * authorization server rather than describing it, because for us they are the
 * same origin but a client must not assume that.
 */
/**
 * Issue #883 §4 — the platform console's realm deliberately remains *absent*
 * from RFC 9728 discovery. `/api/platform/mcp` speaks to console operators
 * only (`pospmcp_` tokens minted from the console UI); nothing in the OAuth
 * handshake flow could ever produce one, so advertising `/api/platform/mcp`
 * as a protected resource could only encourage external MCP clients to ping
 * a surface they cannot possibly join. Tenants keep `/api/mcp`, platforms
 * keep silence — one document, applied to one of the two resources. The
 * `resourcePath` override lets the well-known route answer the path-inserted
 * form (`…/oauth-protected-resource/api/platform/mcp`) with the same
 * deliberate-omission verdict instead of a lie.
 */
export function protectedResourceMetadata(issuer: string, resourcePath = "/api/mcp") {
  if (resourcePath.startsWith("/api/platform/mcp")) return null;
  return {
    resource: `${issuer}${resourcePath}`,
    authorization_servers: [issuer],
    scopes_supported: ALL_MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Business Suite",
    resource_documentation: `${issuer}/settings/connections?tab=mcp`,
  };
}

/**
 * RFC 8414 — authorization server metadata.
 *
 * `registration_endpoint` is what makes "paste a URL and press connect" work at
 * all: without dynamic client registration (RFC 7591) every business would have
 * to hand-register Claude, ChatGPT and every other client before its owner could
 * use any of them.
 */
export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/mcp/oauth/authorize`,
    token_endpoint: `${issuer}/api/mcp/oauth/token`,
    registration_endpoint: `${issuer}/api/mcp/oauth/register`,
    revocation_endpoint: `${issuer}/api/mcp/oauth/revoke`,
    scopes_supported: ALL_MCP_SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: SUPPORTED_CODE_CHALLENGE_METHODS,
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${issuer}/settings/connections?tab=mcp`,
  };
}

/**
 * The `WWW-Authenticate` challenge on an unauthenticated MCP request.
 *
 * The `resource_metadata` parameter is not decoration: it is the whole
 * discovery chain. A client hitting `/api/mcp` with no token reads this header,
 * fetches the metadata it names, finds the authorization server, registers
 * itself and starts the flow — with nobody typing anything but the original URL.
 */
export function bearerChallenge(issuer: string): string {
  return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="${formatMcpScopeString(ALL_MCP_SCOPES)}"`;
}
