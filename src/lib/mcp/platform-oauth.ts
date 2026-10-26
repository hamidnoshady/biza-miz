/**
 * OAuth 2.1 authorization server for the SUPERADMIN console's MCP endpoint
 * (`/api/platform/mcp`), the counterpart of `oauth-service.ts` for the tenant
 * realm.
 *
 * Why it exists: a client that connects from a URL alone (Claude.ai, ChatGPT,
 * Claude Code's `/mcp` login) has nowhere to paste a `pospmcp_` token. It reads
 * the 401's `WWW-Authenticate`, discovers this server, registers itself and
 * sends a signed-in owner admin through the consent screen. A pasted token
 * stays supported; both resolve to one `platform_mcp_connections` row, so
 * revoking the connection ends either.
 *
 * What stays the same as the pasted token, on purpose:
 *   * the authority is the capability list (and optional business scope) the
 *     admin ticks on the consent screen, and every tool call re-verifies the
 *     admin's CURRENT role — consent grants nothing a role change cannot take
 *     back;
 *   * only an admin who may mint credentials (`admins.manage`) can consent;
 *   * the families never cross: `pospmcp_*` here, `posmcp_*` for tenants, each
 *     rejected on shape by the other side.
 *
 * Not tenant-scoped: every table is console-only (see migration 0258 and
 * EXEMPT_TABLES), reached through `withoutTenantScope` like the rest of
 * `platform-mcp.ts`.
 */
import { randomBytes } from "node:crypto";
import { query, withoutTenantScope } from "../db";
import {
  buildRedirect,
  canonicalRedirectUri,
  hashMcpToken,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  sameRedirectUri,
  verifyCodeChallenge,
} from "./oauth";
import { PLATFORM_MCP_TOKEN_PREFIX } from "./platform-client-config";

export const PLATFORM_MCP_ACCESS_TOKEN_PREFIX = `${PLATFORM_MCP_TOKEN_PREFIX}at_`;
export const PLATFORM_MCP_REFRESH_TOKEN_PREFIX = `${PLATFORM_MCP_TOKEN_PREFIX}rt_`;
export const PLATFORM_MCP_CODE_PREFIX = `${PLATFORM_MCP_TOKEN_PREFIX}ac_`;

/**
 * The one OAuth scope this realm advertises. It names the endpoint, not an
 * authority: what a token may actually do is the capability list on its
 * connection, chosen by the admin at consent — a client cannot ask for more by
 * naming a different scope.
 */
export const PLATFORM_MCP_OAUTH_SCOPE = "platform.mcp";

export const PLATFORM_AUTHORIZATION_CODE_TTL_MINUTES = 5;
export const PLATFORM_ACCESS_TOKEN_TTL_HOURS = 12;
export const PLATFORM_REFRESH_TOKEN_TTL_DAYS = 180;

/** Default and ceiling for how long a consented connection lives before the admin must consent again. */
export const PLATFORM_CONNECTION_DEFAULT_DAYS = 90;
export const PLATFORM_CONNECTION_MAX_DAYS = 365;

const REASON = "platform-mcp oauth";

function mint(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

export function isPlatformMcpAccessToken(token: string): boolean {
  return token.startsWith(PLATFORM_MCP_ACCESS_TOKEN_PREFIX);
}

// ---------------------------------------------------------------------------
// Client registration (RFC 7591)
// ---------------------------------------------------------------------------

export interface PlatformRegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

export type RegisterPlatformClientResult =
  | { ok: true; client: PlatformRegisteredClient }
  | { ok: false; error: "invalid_client_metadata"; description: string };

export const MAX_PLATFORM_CLIENTS = 200;
const ABANDONED_CLIENT_AFTER = "1 hour";

/**
 * A client nobody ever completed an exchange with and that owns no connection.
 * Every connect attempt registers a fresh client and an abandoned one is never
 * used again, so counting them forever would lock every standard client out
 * after a few hundred tries (the tenant realm hit exactly that at 50).
 */
const UNUSED_CLIENT = `
  cl.last_used_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM platform_mcp_connections c WHERE c.client_id = cl.id)`;

/**
 * Register a public client. Open, as the spec intends — it yields a client id
 * and nothing else: a registration with no consented code reaches no data. The
 * table is bounded, and the bound is on clients that matter: abandoned
 * registrations go first, then the oldest unused ones make room, and a client
 * that has a connection is never evicted.
 */
export async function registerPlatformMcpClient(input: {
  clientName: unknown;
  redirectUris: unknown;
  clientUri?: unknown;
  softwareId?: unknown;
}): Promise<RegisterPlatformClientResult> {
  const clientName =
    typeof input.clientName === "string" && input.clientName.trim().length > 0
      ? input.clientName.trim().slice(0, 200)
      : "";
  if (!clientName) {
    return { ok: false, error: "invalid_client_metadata", description: "client_name is required" };
  }
  const uris = Array.isArray(input.redirectUris) ? input.redirectUris : [];
  const redirectUris = uris.filter(isAllowedRedirectUri).slice(0, 10);
  if (redirectUris.length === 0) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description:
        "redirect_uris must contain at least one https URI, an http loopback URI, or a private-use scheme URI",
    };
  }

  return withoutTenantScope(REASON, async () => {
    await query(
      `DELETE FROM platform_mcp_oauth_clients cl
        WHERE ${UNUSED_CLIENT}
          AND cl.created_at < now() - interval '${ABANDONED_CLIENT_AFTER}'`,
    );
    const { rows: existing } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_mcp_oauth_clients`,
    );
    const overflow = Number(existing[0]?.count ?? 0) - MAX_PLATFORM_CLIENTS + 1;
    if (overflow > 0) {
      await query(
        `DELETE FROM platform_mcp_oauth_clients
          WHERE id IN (
            SELECT cl.id FROM platform_mcp_oauth_clients cl
             WHERE ${UNUSED_CLIENT}
             ORDER BY cl.created_at
             LIMIT $1)`,
        [overflow],
      );
    }
    const { rows: remaining } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_mcp_oauth_clients`,
    );
    if (Number(remaining[0]?.count ?? 0) >= MAX_PLATFORM_CLIENTS) {
      return {
        ok: false as const,
        error: "invalid_client_metadata" as const,
        description: "too many registered clients",
      };
    }

    const { rows } = await query<{ id: string; created_at: string }>(
      `INSERT INTO platform_mcp_oauth_clients (client_name, redirect_uris, client_uri, software_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [
        clientName,
        redirectUris,
        typeof input.clientUri === "string" ? input.clientUri.slice(0, 500) : null,
        typeof input.softwareId === "string" ? input.softwareId.slice(0, 200) : null,
      ],
    );
    return {
      ok: true as const,
      client: { clientId: rows[0].id, clientName, redirectUris, createdAt: rows[0].created_at },
    };
  });
}

export async function getPlatformMcpClient(clientId: string): Promise<PlatformRegisteredClient | null> {
  // A malformed client_id is a clean "unknown client", not a Postgres uuid cast error.
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return null;
  return withoutTenantScope(REASON, async () => {
    const { rows } = await query<{
      id: string;
      client_name: string;
      redirect_uris: string[];
      created_at: string;
    }>(`SELECT id, client_name, redirect_uris, created_at FROM platform_mcp_oauth_clients WHERE id = $1`, [clientId]);
    const row = rows[0];
    return row
      ? {
          clientId: row.id,
          clientName: row.client_name,
          redirectUris: row.redirect_uris ?? [],
          createdAt: row.created_at,
        }
      : null;
  });
}

// ---------------------------------------------------------------------------
// Authorization requests
// ---------------------------------------------------------------------------

export interface PlatformAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
}

export type ValidatePlatformAuthorizationResult =
  | { ok: true; client: PlatformRegisteredClient; request: PlatformAuthorizationRequest }
  /** Unknown client or unregistered redirect: shown, never redirected (that is how a code reaches an attacker). */
  | { ok: false; kind: "display"; error: string; description: string }
  | { ok: false; kind: "redirect"; redirectUri: string; error: string; description: string; state: string | null };

/**
 * Validate an `/authorize` request before any consent screen is shown. The
 * order is the security property: client and redirect_uri first, and only once
 * both are known-registered does another failure become a redirect — the other
 * way round this endpoint is an open redirect.
 */
export async function validatePlatformAuthorizationRequest(
  params: URLSearchParams,
): Promise<ValidatePlatformAuthorizationResult> {
  const clientId = params.get("client_id") ?? "";
  const requestedRedirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state");

  const client = clientId ? await getPlatformMcpClient(clientId) : null;
  if (!client) {
    return {
      ok: false,
      kind: "display",
      error: "invalid_client",
      description: "این برنامه نزد سکو ثبت نشده است.",
    };
  }
  const redirectUri = requestedRedirectUri
    ? canonicalRedirectUri(requestedRedirectUri, client.redirectUris)
    : null;
  if (!redirectUri) {
    return {
      ok: false,
      kind: "display",
      error: "invalid_request",
      description: "آدرس بازگشت با آنچه این برنامه ثبت کرده یکی نیست.",
    };
  }

  const fail = (error: string, description: string): ValidatePlatformAuthorizationResult => ({
    ok: false,
    kind: "redirect",
    redirectUri,
    error,
    description,
    state,
  });
  if (params.get("response_type") !== "code") {
    return fail("unsupported_response_type", "only response_type=code is supported");
  }
  if (params.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "code_challenge_method=S256 is required");
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!isValidCodeChallenge(codeChallenge)) {
    return fail("invalid_request", "a valid S256 code_challenge is required");
  }
  return { ok: true, client, request: { clientId: client.clientId, redirectUri, codeChallenge, state } };
}

// ---------------------------------------------------------------------------
// Consent → authorization code
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IssuePlatformCodeResult =
  | { ok: true; code: string; redirectTo: string }
  | {
      ok: false;
      error: "invalid_client" | "invalid_redirect" | "invalid_request" | "invalid_capabilities" | "invalid_businesses";
    };

/**
 * The admin said yes. Mint a single-use code carrying THEIR decision — the
 * capabilities and business scope are stored here, so the token endpoint (which
 * has no session) decides nothing beyond "is this code real and does the PKCE
 * verifier match". `capabilities` must already be filtered to what the admin's
 * current role holds and what the tool catalogue offers; this function only
 * refuses an empty set.
 */
export async function issuePlatformAuthorizationCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  adminId: string;
  connectionName: string;
  capabilities: readonly string[];
  /** null = the whole platform; otherwise the businesses the connection may bridge into. */
  businessIds: readonly string[] | null;
  expiresInDays: number | null;
}): Promise<IssuePlatformCodeResult> {
  const client = await getPlatformMcpClient(input.clientId);
  if (!client) return { ok: false, error: "invalid_client" };
  const redirectUri = canonicalRedirectUri(input.redirectUri, client.redirectUris);
  if (!redirectUri) return { ok: false, error: "invalid_redirect" };
  if (!isValidCodeChallenge(input.codeChallenge)) return { ok: false, error: "invalid_request" };
  if (input.capabilities.length === 0) return { ok: false, error: "invalid_capabilities" };
  if (input.businessIds !== null && (input.businessIds.length === 0 || !input.businessIds.every((id) => UUID.test(id)))) {
    return { ok: false, error: "invalid_businesses" };
  }

  const days =
    input.expiresInDays === null
      ? null
      : Math.min(Math.max(Math.floor(input.expiresInDays), 1), PLATFORM_CONNECTION_MAX_DAYS);
  const name = input.connectionName.trim().slice(0, 120) || client.clientName;
  const code = mint(PLATFORM_MCP_CODE_PREFIX);
  await withoutTenantScope(REASON, () =>
    query(
      `INSERT INTO platform_mcp_oauth_codes
         (client_id, code_hash, code_challenge, redirect_uri, admin_id, connection_name,
          capabilities, business_ids, connection_expires_in_days, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, now() + ($10 || ' minutes')::interval)`,
      [
        input.clientId,
        hashMcpToken(code),
        input.codeChallenge,
        redirectUri,
        input.adminId,
        name,
        JSON.stringify([...input.capabilities]),
        input.businessIds === null ? null : JSON.stringify([...input.businessIds]),
        days,
        PLATFORM_AUTHORIZATION_CODE_TTL_MINUTES,
      ],
    ),
  );

  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (input.state !== null) url.searchParams.set("state", input.state);
  return { ok: true, code, redirectTo: url.toString() };
}

/** The redirect back to a client that was refused, with `state` preserved. */
export function platformAccessDeniedRedirect(redirectUri: string, state: string | null): string {
  return buildRedirect(redirectUri, { error: "access_denied", state });
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface PlatformTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export type PlatformTokenExchangeResult =
  | { ok: true; tokens: PlatformTokenSet }
  | { ok: false; error: "invalid_grant" | "invalid_client"; description: string };

async function issueTokenSet(connectionId: string): Promise<PlatformTokenSet> {
  const accessToken = mint(PLATFORM_MCP_ACCESS_TOKEN_PREFIX);
  const refreshToken = mint(PLATFORM_MCP_REFRESH_TOKEN_PREFIX);
  await query(
    `INSERT INTO platform_mcp_oauth_tokens (connection_id, kind, token_hash, expires_at)
     VALUES ($1, 'access',  $2, now() + ($4 || ' hours')::interval),
            ($1, 'refresh', $3, now() + ($5 || ' days')::interval)`,
    [
      connectionId,
      hashMcpToken(accessToken),
      hashMcpToken(refreshToken),
      PLATFORM_ACCESS_TOKEN_TTL_HOURS,
      PLATFORM_REFRESH_TOKEN_TTL_DAYS,
    ],
  );
  return { accessToken, refreshToken, expiresInSeconds: PLATFORM_ACCESS_TOKEN_TTL_HOURS * 3600 };
}

/**
 * Exchange an authorization code for a token pair and create the connection the
 * admin consented to. The code is claimed with a conditional UPDATE, so two
 * simultaneous exchanges cannot both succeed; PKCE is verified after the claim
 * and a failed verification leaves the code spent — a code someone tried to
 * redeem with the wrong verifier has probably leaked.
 */
export async function exchangePlatformAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
}): Promise<PlatformTokenExchangeResult> {
  // No maintenance tick covers this realm, and the exchange is the one moment
  // dead rows are being produced; a failed sweep must never fail a sign-in.
  void sweepExpiredPlatformMcpGrants().catch(() => undefined);
  return withoutTenantScope(REASON, async () => {
    const { rows } = await query<{
      client_id: string;
      code_challenge: string;
      redirect_uri: string;
      admin_id: string;
      connection_name: string;
      capabilities: unknown;
      business_ids: unknown;
      connection_expires_in_days: number | null;
    }>(
      `UPDATE platform_mcp_oauth_codes
          SET consumed_at = now()
        WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING client_id, code_challenge, redirect_uri, admin_id, connection_name,
                  capabilities, business_ids, connection_expires_in_days`,
      [hashMcpToken(input.code)],
    );
    const row = rows[0];
    if (!row) {
      return { ok: false as const, error: "invalid_grant" as const, description: "authorization code is invalid, expired or already used" };
    }
    if (row.client_id !== input.clientId) {
      return { ok: false as const, error: "invalid_client" as const, description: "this code was issued to a different client" };
    }
    if (!sameRedirectUri(input.redirectUri, row.redirect_uri)) {
      return { ok: false as const, error: "invalid_grant" as const, description: "redirect_uri does not match the authorization request" };
    }
    if (!verifyCodeChallenge(input.codeVerifier, row.code_challenge)) {
      return { ok: false as const, error: "invalid_grant" as const, description: "code_verifier does not match code_challenge" };
    }

    // The admin may have been deactivated between consent and exchange.
    const { rows: admin } = await query<{ is_active: boolean }>(
      `SELECT is_active FROM platform_admins WHERE id = $1`,
      [row.admin_id],
    );
    if (!admin[0]?.is_active) {
      return { ok: false as const, error: "invalid_grant" as const, description: "the authorizing administrator is no longer active" };
    }

    const { rows: created } = await query<{ id: string }>(
      `INSERT INTO platform_mcp_connections
         (admin_id, name, origin, client_id, capabilities, business_ids, expires_at)
       VALUES ($1, $2, 'oauth', $3, $4::jsonb, $5::jsonb,
               CASE WHEN $6::integer IS NULL THEN NULL ELSE now() + ($6 || ' days')::interval END)
       RETURNING id`,
      [
        row.admin_id,
        row.connection_name,
        row.client_id,
        JSON.stringify(row.capabilities ?? []),
        row.business_ids === null ? null : JSON.stringify(row.business_ids),
        row.connection_expires_in_days,
      ],
    );
    await query(`UPDATE platform_mcp_oauth_clients SET last_used_at = now() WHERE id = $1`, [row.client_id]);
    return { ok: true as const, tokens: await issueTokenSet(created[0].id) };
  });
}

/**
 * Refresh with rotation: the presented refresh token is revoked in the same
 * statement that claims it and a brand-new pair is issued, so the moment either
 * party uses the old one it is already dead. The connection's CURRENT state is
 * what gates it — a revoked or expired connection, or a deactivated admin,
 * cannot refresh — and its capabilities are read live on every call, so
 * narrowing a connection cannot be undone by a refresh.
 */
export async function refreshPlatformMcpToken(input: {
  refreshToken: string;
}): Promise<PlatformTokenExchangeResult> {
  return withoutTenantScope(REASON, async () => {
    const { rows } = await query<{ connection_id: string }>(
      `UPDATE platform_mcp_oauth_tokens t
          SET revoked_at = now()
         FROM platform_mcp_connections c
         JOIN platform_admins a ON a.id = c.admin_id
        WHERE t.token_hash = $1
          AND t.kind = 'refresh'
          AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > now())
          AND c.id = t.connection_id
          AND c.origin = 'oauth'
          AND c.status = 'active'
          AND (c.expires_at IS NULL OR c.expires_at > now())
          AND a.is_active
        RETURNING t.connection_id`,
      [hashMcpToken(input.refreshToken)],
    );
    if (!rows[0]) {
      return { ok: false as const, error: "invalid_grant" as const, description: "refresh token is invalid, expired or revoked" };
    }
    return { ok: true as const, tokens: await issueTokenSet(rows[0].connection_id) };
  });
}

/**
 * RFC 7009 revocation: always reports success to the caller (the endpoint is
 * unauthenticated, so a truthful "no such token" would be an oracle). Revokes
 * one token, not the connection.
 */
export async function revokePlatformMcpOauthToken(token: string): Promise<void> {
  await withoutTenantScope(REASON, () =>
    query(`UPDATE platform_mcp_oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
      hashMcpToken(token),
    ]),
  );
}

/** Dead rows: spent or expired codes, and tokens that can no longer authenticate anything. */
export async function sweepExpiredPlatformMcpGrants(): Promise<void> {
  await withoutTenantScope(REASON, async () => {
    await query(
      `DELETE FROM platform_mcp_oauth_codes
        WHERE expires_at < now() - interval '1 day' OR consumed_at < now() - interval '1 day'`,
    );
    await query(
      `DELETE FROM platform_mcp_oauth_tokens
        WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`,
    );
  });
}
