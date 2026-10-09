/**
 * Creating, listing and revoking MCP connections, and the approval queue that
 * `write_mode = 'approve'` feeds.
 *
 * DB-touching, so no direct unit test per repo convention — the pure parts have
 * their own (`scopes.ts`, `oauth.ts`, `tools.ts`), and the behaviour that only
 * shows up against Postgres is covered by
 * `integration/mcp-connector.integration.test.ts`.
 */
import { query } from "../db";
import { ACTION_CATALOG, type ActionType } from "../ai";
import { createMcpStaticToken, hashMcpToken, mcpTokenDisplayPrefix } from "./oauth";
import {
  MCP_SCOPES,
  parseMcpScopes,
  type McpScope,
  type McpWriteMode,
  isMcpWriteMode,
} from "./scopes";

export type McpConnectionOrigin = "token" | "oauth";

/** Everything about a connection except anything that could authenticate as it. */
export interface McpConnectionSummary {
  id: string;
  name: string;
  scopes: McpScope[];
  writeMode: McpWriteMode;
  origin: McpConnectionOrigin;
  /** The registered client's name, for an OAuth connection — «Claude», «ChatGPT», … */
  clientName: string | null;
  /** The first characters of a static token; never enough to use it. NULL for OAuth. */
  tokenPrefix: string | null;
  locationId: string;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

type ConnectionRow = {
  id: string;
  name: string;
  scopes: unknown;
  write_mode: string;
  origin: McpConnectionOrigin;
  client_name: string | null;
  token_prefix: string | null;
  location_id: string;
  status: "active" | "revoked";
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

const SELECT_CONNECTION = `
  SELECT c.id, c.name, c.scopes, c.write_mode, c.origin, cl.client_name,
         c.token_prefix, c.location_id, c.status, c.last_used_at, c.expires_at,
         c.created_at, c.revoked_at
    FROM mcp_connections c
    LEFT JOIN mcp_oauth_clients cl ON cl.id = c.client_id AND cl.business_id = c.business_id`;

function mapConnection(row: ConnectionRow): McpConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    scopes: parseMcpScopes(row.scopes),
    writeMode: isMcpWriteMode(row.write_mode) ? row.write_mode : "approve",
    origin: row.origin,
    clientName: row.client_name,
    tokenPrefix: row.token_prefix,
    locationId: row.location_id,
    status: row.status,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export async function listMcpConnections(businessId: string): Promise<McpConnectionSummary[]> {
  const { rows } = await query<ConnectionRow>(
    `${SELECT_CONNECTION} WHERE c.business_id = $1 ORDER BY c.created_at DESC LIMIT 100`,
    [businessId],
  );
  return rows.map(mapConnection);
}

export async function getMcpConnection(
  businessId: string,
  id: string,
): Promise<McpConnectionSummary | null> {
  const { rows } = await query<ConnectionRow>(
    `${SELECT_CONNECTION} WHERE c.business_id = $1 AND c.id = $2`,
    [businessId, id],
  );
  return rows[0] ? mapConnection(rows[0]) : null;
}

const MAX_NAME_LENGTH = 120;
const MAX_EXPIRY_DAYS = 3650;

export interface CreateStaticConnectionInput {
  name: string;
  locationId: string;
  scopes: unknown;
  writeMode: unknown;
  expiresInDays?: number | null;
}

export type CreateMcpConnectionResult =
  | { ok: true; connection: McpConnectionSummary; token: string }
  | { ok: false; error: "invalid_name" | "invalid_scopes" | "invalid_write_mode" | "invalid_expiry" | "no_location" };

/**
 * Mint a static-token connection — the path for clients that authenticate with
 * a header from a config file (Codex, an IDE, a script) rather than by walking
 * an OAuth flow.
 *
 * The token exists only in this return value. Only its SHA-256 and a display
 * prefix are stored, the same rule api_keys, pairing codes and invitations all
 * follow, which is why there is no "show it again" anywhere in the UI.
 */
export async function createStaticMcpConnection(
  businessId: string,
  createdBy: string,
  input: CreateStaticConnectionInput,
): Promise<CreateMcpConnectionResult> {
  const name = input.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) return { ok: false, error: "invalid_name" };
  if (!input.locationId) return { ok: false, error: "no_location" };

  const scopes = parseMcpScopes(input.scopes);
  if (scopes.length === 0) return { ok: false, error: "invalid_scopes" };

  const writeMode = input.writeMode ?? "approve";
  if (!isMcpWriteMode(writeMode)) return { ok: false, error: "invalid_write_mode" };

  const days = input.expiresInDays ?? null;
  if (days !== null && (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRY_DAYS)) {
    return { ok: false, error: "invalid_expiry" };
  }

  const token = createMcpStaticToken();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO mcp_connections
       (business_id, location_id, name, scopes, write_mode, origin, token_prefix, token_hash,
        created_by, authorized_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'token', $6, $7, $8, $8,
             CASE WHEN $9::numeric IS NULL THEN NULL ELSE now() + ($9 || ' days')::interval END)
     RETURNING id`,
    [
      businessId,
      input.locationId,
      name,
      scopes,
      writeMode,
      mcpTokenDisplayPrefix(token),
      hashMcpToken(token),
      createdBy,
      days,
    ],
  );
  const connection = await getMcpConnection(businessId, rows[0].id);
  return connection ? { ok: true, connection, token } : { ok: false, error: "no_location" };
}

/**
 * Revoke a connection. Takes effect on its very next call — `authenticateMcp`
 * re-reads status every time and caches nothing, which is the property the
 * whole affordance rests on.
 *
 * Deliberately not a delete: the row is what `ai_action_audit.mcp_connection_id`
 * references, and "this connector existed, did these things, and was withdrawn
 * on this date" is the answer an audit needs. Its OAuth tokens are deleted
 * though — they can authenticate nothing once the connection is revoked, and
 * keeping hashes of dead credentials serves nobody.
 */
export async function revokeMcpConnection(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE mcp_connections SET status = 'revoked', revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND status = 'active'`,
    [id, businessId],
  );
  if ((rowCount ?? 0) === 0) return false;
  await query(`DELETE FROM mcp_oauth_tokens WHERE connection_id = $1 AND business_id = $2`, [
    id,
    businessId,
  ]);
  await cancelOutstandingProposals(businessId, id, "connection_revoked");
  return true;
}

/**
 * Issue #883 P0-3 — a proposal whose connection can no longer write must not
 * sit in the approval queue holding authority the owner already withdrew.
 * Outstanding `proposed` rows are dismissed with the reason kept; a row in
 * `processing` is mid-execution — its claimant's finalize CAS owns it, so it
 * is left to close itself out (and `decideMcpPendingAction` revalidates the
 * connection at approval time, so nothing new can claim the survivors).
 */
export async function cancelOutstandingProposals(
  businessId: string,
  connectionId: string,
  reason: "connection_revoked" | "connection_narrowed",
): Promise<number> {
  const { rowCount } = await query(
    `UPDATE ai_action_audit
        SET status = 'dismissed', result = $3::jsonb
      WHERE business_id = $1 AND mcp_connection_id = $2 AND source = 'mcp' AND status = 'proposed'`,
    [businessId, connectionId, JSON.stringify({ cancelled: reason })],
  );
  return rowCount ?? 0;
}

/**
 * Change what an existing connection may do.
 *
 * Narrowing (dropping `pos.write`, or moving from 'apply' to 'approve') is the
 * case that matters: an owner who gets nervous about a connector must be able
 * to keep it connected and take the writes away, without re-running the OAuth
 * flow on their phone.
 */
export async function updateMcpConnectionAccess(
  businessId: string,
  id: string,
  input: { scopes: unknown; writeMode: unknown; authorizedBy: string },
): Promise<{ ok: true; connection: McpConnectionSummary } | { ok: false; error: string }> {
  const scopes = parseMcpScopes(input.scopes);
  if (scopes.length === 0) return { ok: false, error: "invalid_scopes" };
  if (!isMcpWriteMode(input.writeMode)) return { ok: false, error: "invalid_write_mode" };

  const { rowCount } = await query(
    `UPDATE mcp_connections
        SET scopes = $3, write_mode = $4, authorized_by = $5
      WHERE id = $1 AND business_id = $2 AND status = 'active'`,
    [id, businessId, scopes, input.writeMode, input.authorizedBy],
  );
  if ((rowCount ?? 0) === 0) return { ok: false, error: "connection_not_found" };

  // Narrowing away the write grant cancels what it had queued: keeping those
  // rows approvable would let a human execute writes for a connector the
  // owner has since decided may not write (issue #883 P0-3).
  if (!scopes.includes(MCP_SCOPES.write)) {
    await cancelOutstandingProposals(businessId, id, "connection_narrowed");
  }

  const connection = await getMcpConnection(businessId, id);
  return connection ? { ok: true, connection } : { ok: false, error: "connection_not_found" };
}

// ---------------------------------------------------------------------------
// The approval queue
// ---------------------------------------------------------------------------

/**
 * A write a connection asked for while in `approve` mode.
 *
 * These are `ai_action_audit` rows with `status = 'proposed'` and
 * `source = 'mcp'` — the existing "every change the assistant made to this
 * business" trail, extended rather than forked, exactly as migration 0097 did
 * for autopilot. The consequence worth stating: an approved MCP write and a
 * chat "Apply" land in the same list, in the same order, with the same undo.
 */
export interface McpPendingAction {
  id: string;
  connectionId: string | null;
  connectionName: string | null;
  actionType: string;
  actionLabel: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  revertible: "always" | "while_open" | false;
  createdAt: string;
}

export async function listMcpPendingActions(
  businessId: string,
  limit = 50,
): Promise<McpPendingAction[]> {
  const { rows } = await query<{
    id: string;
    mcp_connection_id: string | null;
    connection_name: string | null;
    action_type: string;
    action_title: string;
    action_summary: string;
    proposal_payload: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT a.id, a.mcp_connection_id, c.name AS connection_name, a.action_type,
            a.action_title, a.action_summary, a.proposal_payload, a.created_at
       FROM ai_action_audit a
       LEFT JOIN mcp_connections c ON c.id = a.mcp_connection_id AND c.business_id = a.business_id
      WHERE a.business_id = $1 AND a.source = 'mcp' AND a.status = 'proposed'
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [businessId, limit],
  );
  return rows.map((row) => {
    const meta = ACTION_CATALOG[row.action_type as ActionType];
    return {
      id: row.id,
      connectionId: row.mcp_connection_id,
      connectionName: row.connection_name,
      actionType: row.action_type,
      actionLabel: meta?.label ?? row.action_type,
      title: row.action_title,
      summary: row.action_summary,
      payload: row.proposal_payload ?? {},
      revertible: meta?.revertible ?? false,
      createdAt: row.created_at,
    };
  });
}

export async function countMcpPendingActions(businessId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ai_action_audit
      WHERE business_id = $1 AND source = 'mcp' AND status = 'proposed'`,
    [businessId],
  );
  return Number(rows[0]?.count ?? 0);
}
