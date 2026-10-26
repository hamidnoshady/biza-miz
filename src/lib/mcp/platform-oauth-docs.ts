/**
 * Discovery documents for the SUPERADMIN console's MCP endpoint — the platform
 * realm's twin of the tenant documents in `oauth.ts`. Pure (no database), so the
 * route handlers and the unit tests share one definition.
 *
 * Two shapes of "who is the authorization server", chosen by where the request
 * landed:
 *
 *   * **On the admin host** (`admin.{ROOT_DOMAIN}`, host routing on) the whole
 *     origin IS the console, so the issuer is the bare origin and the bare
 *     `/.well-known/oauth-authorization-server` answers with this realm's
 *     document. That is also what clients that predate RFC 8414's path
 *     insertion (they look at the server's origin) read.
 *   * **Anywhere else** (a single-origin install, routing off) the origin also
 *     serves tenant OAuth, so the console's issuer is path-inserted
 *     (`{origin}/api/platform/mcp`) and its documents live at the RFC 8414 /
 *     RFC 9728 path-inserted locations. The bare documents there stay tenant's.
 *
 * Endpoints are always built from the origin, never from the issuer, so the
 * path-inserted shape does not leak into the URLs a client calls.
 */
import { BRAND_NAME_EN } from "../brand";
import { hostRoutingEnabled, parseHost, requestHost, rootDomain } from "../host";
import { PLATFORM_MCP_PATH } from "./platform-client-config";
import { SUPPORTED_CODE_CHALLENGE_METHODS } from "./oauth";

/** The one OAuth scope this realm advertises; see `platform-oauth.ts`. */
export const PLATFORM_MCP_SCOPE = "platform.mcp";

export const PLATFORM_OAUTH_BASE = `${PLATFORM_MCP_PATH}/oauth`;

/** Whether a request arrived on the console's own host. */
export function isPlatformAdminHost(headers: Headers): boolean {
  if (!hostRoutingEnabled()) return false;
  return parseHost(requestHost(headers), rootDomain()).kind === "admin";
}

/**
 * Whether a `/.well-known/oauth-*` request is asking about the console realm:
 * it names the console's resource path, or it landed on the admin host where
 * the console is the only realm there is.
 */
export function wellKnownIsPlatformRealm(pathSuffix: string, adminHost: boolean): boolean {
  return pathSuffix.startsWith(PLATFORM_MCP_PATH) || adminHost;
}

export function platformIssuer(origin: string, adminHost: boolean): string {
  return adminHost ? origin : `${origin}${PLATFORM_MCP_PATH}`;
}

/** RFC 9728 protected-resource metadata for `/api/platform/mcp`. */
export function platformProtectedResourceMetadata(origin: string, adminHost: boolean) {
  return {
    resource: `${origin}${PLATFORM_MCP_PATH}`,
    authorization_servers: [platformIssuer(origin, adminHost)],
    scopes_supported: [PLATFORM_MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: `${BRAND_NAME_EN} console`,
    resource_documentation: `${origin}/platform/mcp-connections`,
  };
}

/** RFC 8414 authorization-server metadata for the console realm. */
export function platformAuthorizationServerMetadata(origin: string, adminHost: boolean) {
  return {
    issuer: platformIssuer(origin, adminHost),
    authorization_endpoint: `${origin}${PLATFORM_OAUTH_BASE}/authorize`,
    token_endpoint: `${origin}${PLATFORM_OAUTH_BASE}/token`,
    registration_endpoint: `${origin}${PLATFORM_OAUTH_BASE}/register`,
    revocation_endpoint: `${origin}${PLATFORM_OAUTH_BASE}/revoke`,
    scopes_supported: [PLATFORM_MCP_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: SUPPORTED_CODE_CHALLENGE_METHODS,
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${origin}/platform/mcp-connections`,
  };
}

/**
 * The `WWW-Authenticate` challenge on an unauthenticated console MCP request.
 * The path-inserted metadata URL (RFC 9728 §3.1) works in both host shapes, so
 * a client never needs to guess which document answers for the console.
 */
export function platformBearerChallenge(origin: string): string {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${PLATFORM_MCP_PATH}", scope="${PLATFORM_MCP_SCOPE}"`;
}
