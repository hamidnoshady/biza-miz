/**
 * The stateful half of the OAuth 2.1 authorization server: client registration,
 * authorization codes, and tokens.
 *
 * Everything here runs *inside* a tenant scope that `resolveMcpTenant` already
 * established from the request's host — a business is served from its own origin
 * (Phase 23), so the address a client registered at is the business it is
 * registering with. That is why none of these functions takes a bypass: the
 * tenant is known before the first row is touched, unlike in `auth.ts` where the
 * token itself is the only thing that names it.
 *
 * DB-touching; the security-relevant comparisons it depends on (PKCE, redirect
 * matching, scope narrowing) are pure and unit tested in `oauth.ts`/`scopes.ts`.
 */
import { query } from "../db";
import {
  createMcpAccessToken,
  createMcpAuthorizationCode,
  createMcpRefreshToken,
  hashMcpToken,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  matchesRegisteredRedirectUri,
  verifyCodeChallenge,
} from "./oauth";
import { grantableScopes, parseMcpScopes, type McpScope, type McpWriteMode } from "./scopes";
import { LEGACY_GRANTS, parseMcpGrants, validateMcpGrantsMint } from "./grants";

/**
 * How long each credential lives.
 *
 * The authorization code is deliberately at the short end of what OAuth 2.1
 * permits — it is single-use anyway, and the window in which a leaked one is
 * worth anything should be measured in the seconds a redirect takes. The access
 * token is short enough that a revoked connection stops working on its own even
 * if a client never retries, and the refresh token long enough that a connector
 * an owner set up once and forgot keeps working for a season.
 */
export const AUTHORIZATION_CODE_TTL_MINUTES = 5;
export const ACCESS_TOKEN_TTL_HOURS = 12;
export const REFRESH_TOKEN_TTL_DAYS = 180;

// ---------------------------------------------------------------------------
// Client registration (RFC 7591)
// ---------------------------------------------------------------------------

export interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

export type RegisterClientResult =
  | { ok: true; client: RegisteredClient }
  | { ok: false; error: "invalid_client_metadata"; description: string };

const MAX_CLIENTS_PER_BUSINESS = 50;

/**
 * Register a public client.
 *
 * No client secret is issued, and `token_endpoint_auth_method` is always
 * `none`: every client that reaches this server is a phone app, a desktop app
 * or a browser extension, none of which can keep a secret. PKCE is what
 * authenticates the exchange instead — which is exactly the case OAuth 2.1
 * mandates it for.
 *
 * Registration is open, as the spec intends, but bounded: a business cannot
 * accumulate more than `MAX_CLIENTS_PER_BUSINESS` registrations, so an
 * unauthenticated endpoint cannot be used to fill a tenant's table. Nothing a
 * registration alone can do is sensitive — a client id with no consented code
 * grants nothing at all.
 */
export async function registerMcpClient(
  businessId: string,
  input: { clientName: unknown; redirectUris: unknown; clientUri?: unknown; softwareId?: unknown },
): Promise<RegisterClientResult> {
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

  const { rows: existing } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM mcp_oauth_clients WHERE business_id = $1`,
    [businessId],
  );
  if (Number(existing[0]?.count ?? 0) >= MAX_CLIENTS_PER_BUSINESS) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "too many registered clients for this business",
    };
  }

  const { rows } = await query<{ id: string; created_at: string }>(
    `INSERT INTO mcp_oauth_clients (business_id, client_name, redirect_uris, client_uri, software_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [
      businessId,
      clientName,
      redirectUris,
      typeof input.clientUri === "string" ? input.clientUri.slice(0, 500) : null,
      typeof input.softwareId === "string" ? input.softwareId.slice(0, 200) : null,
    ],
  );
  return {
    ok: true,
    client: {
      clientId: rows[0].id,
      clientName,
      redirectUris,
      createdAt: rows[0].created_at,
    },
  };
}

export async function getMcpClient(
  businessId: string,
  clientId: string,
): Promise<RegisteredClient | null> {
  // A malformed client_id must be a clean "unknown client", not a 500 from
  // Postgres refusing to cast it to uuid.
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return null;
  const { rows } = await query<{
    id: string;
    client_name: string;
    redirect_uris: string[];
    created_at: string;
  }>(
    `SELECT id, client_name, redirect_uris, created_at
       FROM mcp_oauth_clients WHERE id = $1 AND business_id = $2`,
    [clientId, businessId],
  );
  const row = rows[0];
  return row
    ? {
        clientId: row.id,
        clientName: row.client_name,
        redirectUris: row.redirect_uris ?? [],
        createdAt: row.created_at,
      }
    : null;
}

// ---------------------------------------------------------------------------
// Authorization requests
// ---------------------------------------------------------------------------

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scopes: McpScope[];
}

export type ValidateAuthorizationResult =
  | { ok: true; client: RegisteredClient; request: AuthorizationRequest }
  /**
   * The request cannot be trusted enough to redirect anywhere — an unknown
   * client, or a redirect_uri that is not registered. The spec is explicit that
   * these must be shown to the user rather than redirected, because redirecting
   * them is how a code is delivered to an attacker.
   */
  | { ok: false; kind: "display"; error: string; description: string }
  /** The client and redirect are sound, so the error goes back to the client. */
  | { ok: false; kind: "redirect"; redirectUri: string; error: string; description: string; state: string | null };

/**
 * Validate an incoming `/authorize` request before any consent screen is shown.
 *
 * The order is the point: client and redirect_uri are checked first, and only
 * once both are known-good does any other failure become a redirect. Reversing
 * that turns this endpoint into an open redirect.
 */
export async function validateAuthorizationRequest(
  businessId: string,
  params: URLSearchParams,
): Promise<ValidateAuthorizationResult> {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state");

  const client = clientId ? await getMcpClient(businessId, clientId) : null;
  if (!client) {
    return {
      ok: false,
      kind: "display",
      error: "invalid_client",
      description: "این برنامه نزد این کسب‌وکار ثبت نشده است.",
    };
  }
  if (!redirectUri || !matchesRegisteredRedirectUri(redirectUri, client.redirectUris)) {
    return {
      ok: false,
      kind: "display",
      error: "invalid_request",
      description: "آدرس بازگشت با آنچه این برنامه ثبت کرده یکی نیست.",
    };
  }

  const fail = (error: string, description: string): ValidateAuthorizationResult => ({
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

  return {
    ok: true,
    client,
    request: {
      clientId: client.clientId,
      redirectUri,
      codeChallenge,
      state,
      scopes: parseMcpScopes((params.get("scope") ?? "").split(/\s+/).filter(Boolean)),
    },
  };
}

// ---------------------------------------------------------------------------
// Consent → authorization code
// ---------------------------------------------------------------------------

export type IssueCodeResult =
  | { ok: true; code: string; redirectTo: string }
  | {
      ok: false;
      error:
        | "invalid_client"
        | "invalid_redirect"
        | "invalid_scopes"
        // Issue #883 §1: the consent grants the owner picked failed mint rules
        // (no app, write-without-read, empty branch list, branch picked the
        // connection can never reach). The consent page renders its own
        // copy for this; external clients get 'invalid_grants' as per RFC
        // 6749's free-form error code allowance.
        | "invalid_grants"
        | "invalid_request";
    };

/**
 * The owner said yes. Mint a single-use code carrying *their* decision.
 *
 * What is stored is the granted set, not the requested one: a client that asked
 * for `pos.write` and got only `pos.read` has a code that can never become a
 * write token, whatever it sends to `/token`. The branch and the consenting user
 * are pinned here too, so the token endpoint — which has no session — makes no
 * decisions at all beyond "is this code real and does the verifier match".
 */
export async function issueAuthorizationCode(input: {
  businessId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  requestedScopes: readonly McpScope[];
  approvedScopes: readonly McpScope[];
  writeMode: McpWriteMode;
  locationId: string;
  userId: string;
  connectionName: string;
  /**
   * Issue #883 §1 — the app/branch grants the owner approved on the consent
   * screen, carried verbatim onto the minted connection. Absent = the
   * legacy consent (everything at scope level); the consent UI always sends
   * a real document, but OAuth clients go through this flow programmatically,
   * and their consent page builds the grants from what they ticked. The
   * server validates the shape and that every named branch belongs to the
   * business before accepting.
   */
  grants?: unknown;
}): Promise<IssueCodeResult> {
  const client = await getMcpClient(input.businessId, input.clientId);
  if (!client) return { ok: false, error: "invalid_client" };
  if (!matchesRegisteredRedirectUri(input.redirectUri, client.redirectUris)) {
    return { ok: false, error: "invalid_redirect" };
  }
  if (!isValidCodeChallenge(input.codeChallenge)) return { ok: false, error: "invalid_request" };

  const scopes = grantableScopes(input.requestedScopes, input.approvedScopes);
  if (scopes.length === 0) return { ok: false, error: "invalid_scopes" };

  const grants = input.grants === undefined ? LEGACY_GRANTS : parseMcpGrants(input.grants);
  if (validateMcpGrantsMint(grants) !== null) return { ok: false, error: "invalid_grants" };
  if (grants.branches !== "all") {
    if (!grants.branches.includes(input.locationId)) return { ok: false, error: "invalid_grants" };
    const { rows: branchCheck } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM locations
        WHERE business_id = $1 AND id = ANY($2::uuid[]) AND is_active`,
      [input.businessId, grants.branches],
    );
    if (Number(branchCheck[0]?.count ?? 0) !== grants.branches.length) {
      return { ok: false, error: "invalid_grants" };
    }
  }

  const name = input.connectionName.trim().slice(0, 120) || client.clientName;
  const code = createMcpAuthorizationCode();
  await query(
    `INSERT INTO mcp_oauth_codes
       (business_id, client_id, code_hash, code_challenge, redirect_uri, scopes, write_mode,
        location_id, user_id, connection_name, expires_at, grants)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + ($11 || ' minutes')::interval, $12::jsonb)`,
    [
      input.businessId,
      input.clientId,
      hashMcpToken(code),
      input.codeChallenge,
      input.redirectUri,
      scopes,
      input.writeMode,
      input.locationId,
      input.userId,
      name,
      AUTHORIZATION_CODE_TTL_MINUTES,
      JSON.stringify(grants),
    ],
  );

  const url = new URL(input.redirectUri);
  url.searchParams.set("code", code);
  if (input.state !== null) url.searchParams.set("state", input.state);
  return { ok: true, code, redirectTo: url.toString() };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface McpTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: McpScope[];
}

export type TokenExchangeResult =
  | { ok: true; tokens: McpTokenSet }
  | { ok: false; error: "invalid_grant" | "invalid_client" | "invalid_request"; description: string };

async function issueTokenSet(input: {
  businessId: string;
  connectionId: string;
  scopes: McpScope[];
}): Promise<McpTokenSet> {
  const accessToken = createMcpAccessToken();
  const refreshToken = createMcpRefreshToken();
  await query(
    `INSERT INTO mcp_oauth_tokens (business_id, connection_id, kind, token_hash, expires_at)
     VALUES ($1, $2, 'access', $3, now() + ($5 || ' hours')::interval),
            ($1, $2, 'refresh', $4, now() + ($6 || ' days')::interval)`,
    [
      input.businessId,
      input.connectionId,
      hashMcpToken(accessToken),
      hashMcpToken(refreshToken),
      ACCESS_TOKEN_TTL_HOURS,
      REFRESH_TOKEN_TTL_DAYS,
    ],
  );
  return {
    accessToken,
    refreshToken,
    expiresInSeconds: ACCESS_TOKEN_TTL_HOURS * 3600,
    scopes: input.scopes,
  };
}

/**
 * Exchange an authorization code for a token pair, and create the connection
 * the owner consented to.
 *
 * The code is claimed with a conditional UPDATE rather than read-then-write, so
 * two simultaneous exchanges cannot both succeed — single use is enforced by the
 * database, not by this function's timing. PKCE is verified *after* the claim
 * and a failed verification leaves the code spent, which is the correct
 * behaviour: a code someone tried to redeem with the wrong verifier is a code
 * that has probably leaked.
 */
export async function exchangeAuthorizationCode(input: {
  businessId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
}): Promise<TokenExchangeResult> {
  const { rows } = await query<{
    id: string;
    client_id: string;
    code_challenge: string;
    redirect_uri: string;
    scopes: unknown;
    write_mode: McpWriteMode;
    location_id: string;
    user_id: string;
    connection_name: string;
    grants: unknown;
  }>(
    `UPDATE mcp_oauth_codes
        SET consumed_at = now()
      WHERE business_id = $1
        AND code_hash = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id, client_id, code_challenge, redirect_uri, scopes, write_mode,
                location_id, user_id, connection_name, grants`,
    [input.businessId, hashMcpToken(input.code)],
  );
  const row = rows[0];
  if (!row) {
    return { ok: false, error: "invalid_grant", description: "authorization code is invalid, expired or already used" };
  }
  if (row.client_id !== input.clientId) {
    return { ok: false, error: "invalid_client", description: "this code was issued to a different client" };
  }
  if (row.redirect_uri !== input.redirectUri) {
    return { ok: false, error: "invalid_grant", description: "redirect_uri does not match the authorization request" };
  }
  if (!verifyCodeChallenge(input.codeVerifier, row.code_challenge)) {
    return { ok: false, error: "invalid_grant", description: "code_verifier does not match code_challenge" };
  }

  const scopes = parseMcpScopes(row.scopes);
  const { rows: created } = await query<{ id: string }>(
    `INSERT INTO mcp_connections
       (business_id, location_id, name, scopes, write_mode, origin, client_id, created_by, authorized_by, grants)
     VALUES ($1, $2, $3, $4, $5, 'oauth', $6, $7, $7, $8::jsonb)
     RETURNING id`,
    [
      input.businessId,
      row.location_id,
      row.connection_name,
      scopes,
      row.write_mode,
      row.client_id,
      row.user_id,
      JSON.stringify(row.grants ?? {}),
    ],
  );

  // The consent-grants story starts here: what the owner agreed to in the
  // interface, through that interface. Imported lazily — oauth-service is
  // loaded at authenticate-time hot paths and this only fires on connection
  // minting.
  const { recordMcpGrantEvent } = await import("./connections-service");
  await recordMcpGrantEvent({
    businessId: input.businessId,
    connectionId: created[0].id,
    kind: "minted",
    scopes,
    writeMode: row.write_mode,
    grants: row.grants ?? null,
    actorUserId: row.user_id,
    via: "oauth_consent",
  });

  await query(`UPDATE mcp_oauth_clients SET last_used_at = now() WHERE id = $1 AND business_id = $2`, [
    row.client_id,
    input.businessId,
  ]);

  const tokens = await issueTokenSet({
    businessId: input.businessId,
    connectionId: created[0].id,
    scopes,
  });
  return { ok: true, tokens };
}

/**
 * Refresh, with rotation.
 *
 * The presented refresh token is revoked in the same statement that claims it
 * and a brand-new pair is issued — OAuth 2.1's requirement for public clients,
 * and the only thing that makes a stolen refresh token detectable: the moment
 * either party uses the old one, it is already dead.
 *
 * The connection's *current* scopes are re-read rather than carried on the
 * token, so an owner who narrowed a connection from the connections screen has
 * narrowed it for real — the next refresh cannot restore what they took away.
 */
export async function refreshMcpToken(input: {
  businessId: string;
  refreshToken: string;
}): Promise<TokenExchangeResult> {
  const { rows } = await query<{ connection_id: string; scopes: unknown }>(
    `UPDATE mcp_oauth_tokens t
        SET revoked_at = now()
       FROM mcp_connections c
      WHERE t.token_hash = $2
        AND t.business_id = $1
        AND t.kind = 'refresh'
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now())
        AND c.id = t.connection_id
        AND c.business_id = t.business_id
        AND c.status = 'active'
        AND (c.expires_at IS NULL OR c.expires_at > now())
      RETURNING t.connection_id, c.scopes`,
    [input.businessId, hashMcpToken(input.refreshToken)],
  );
  const row = rows[0];
  if (!row) {
    return { ok: false, error: "invalid_grant", description: "refresh token is invalid, expired or revoked" };
  }

  const tokens = await issueTokenSet({
    businessId: input.businessId,
    connectionId: row.connection_id,
    scopes: parseMcpScopes(row.scopes),
  });
  return { ok: true, tokens };
}

/**
 * RFC 7009 token revocation. Always reports success, as the spec requires —
 * telling an unauthenticated caller whether a token existed is a lookup oracle,
 * and the client's only legitimate interest is that the token is now unusable.
 */
export async function revokeMcpOauthToken(businessId: string, token: string): Promise<void> {
  await query(
    `UPDATE mcp_oauth_tokens SET revoked_at = now()
      WHERE business_id = $1 AND token_hash = $2 AND revoked_at IS NULL`,
    [businessId, hashMcpToken(token)],
  );
}

/**
 * Housekeeping for the two tables that accumulate dead rows: spent or expired
 * codes, and tokens that can no longer authenticate anything. Called from the
 * same maintenance tick that sweeps other expiring records.
 */
export async function sweepExpiredMcpGrants(businessId: string): Promise<void> {
  await query(
    `DELETE FROM mcp_oauth_codes
      WHERE business_id = $1 AND (expires_at < now() - interval '1 day' OR consumed_at < now() - interval '1 day')`,
    [businessId],
  );
  await query(
    `DELETE FROM mcp_oauth_tokens
      WHERE business_id = $1
        AND (expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days')`,
    [businessId],
  );
}
