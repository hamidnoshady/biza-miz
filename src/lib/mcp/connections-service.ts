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
import {
  isLegacyGrants,
  LEGACY_GRANTS,
  mcpBrancheIds,
  mcpBranchScopeOf,
  parseMcpGrants,
  validateMcpGrantsMint,
  type McpGrants,
} from "./grants";
import { mcpWriteRegistryEntry } from "./registry";
import { reconcileStaleMcpClaims } from "./write-service";

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
  /** The pinned branch's display name, for the panel's branch-consent copy. */
  locationName: string | null;
  /** Issue #883 §1 — parsed app/branch grants. `{}` rows (pre-wave-2) parse to
   * the conservative legacy: every reachable app, every branch. */
  grants: McpGrants;
  /** Convenience derivations for the panel; SSOT stays `grants`. */
  branchScope: "single" | "multi";
  grantedBranchIds: string[] | null;
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
  location_name: string | null;
  grants: unknown;
  status: "active" | "revoked";
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

const SELECT_CONNECTION = `
  SELECT c.id, c.name, c.scopes, c.write_mode, c.origin, cl.client_name,
         c.token_prefix, c.location_id, l.name AS location_name, c.grants, c.status,
         c.last_used_at, c.expires_at, c.created_at, c.revoked_at
    FROM mcp_connections c
    LEFT JOIN mcp_oauth_clients cl ON cl.id = c.client_id AND cl.business_id = c.business_id
    LEFT JOIN locations l ON l.id = c.location_id AND l.business_id = c.business_id`;

function mapConnection(row: ConnectionRow): McpConnectionSummary {
  const grants = parseMcpGrants(row.grants);
  return {
    id: row.id,
    name: row.name,
    scopes: parseMcpScopes(row.scopes),
    writeMode: isMcpWriteMode(row.write_mode) ? row.write_mode : "approve",
    origin: row.origin,
    clientName: row.client_name,
    tokenPrefix: row.token_prefix,
    locationId: row.location_id,
    locationName: row.location_name,
    grants,
    branchScope: mcpBranchScopeOf(grants),
    grantedBranchIds: mcpBrancheIds(grants),
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
  /** Issue #883 §1 — explicit per-app grants + branch consent. Absent = the
   * panel's least-privilege default (see the UI), NOT legacy. */
  grants?: unknown;
}

export type CreateMcpConnectionResult =
  | { ok: true; connection: McpConnectionSummary; token: string }
  | { ok: false; error: "invalid_name" | "invalid_scopes" | "invalid_write_mode" | "invalid_expiry" | "no_location" | "invalid_grants" | "branch_out_of_scope" };

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

  // Issue #883 §1 — grants at mint. `undefined` means the caller predates the
  // granular document (old panel builds, API clients from before wave 2):
  // those mints get the conservative LEGACY shape so existing integrations
  // keep working unchanged. Explicit-but-empty documents still fail
  // validation below — a caller who SAYS `{}` said nothing, and minting that
  // into "all of everything" would be a silent upgrade nobody consented to.
  // `branches` names REAL locations of this business — a grant to a branch
  // that does not exist is a grant to nothing.
  const grants = input.grants === undefined ? LEGACY_GRANTS : parseMcpGrants(input.grants);
  if (!grants || validateMcpGrantsMint(grants) !== null) {
    return { ok: false, error: "invalid_grants" };
  }
  if (grants.branches !== "all") {
    if (!grants.branches.includes(input.locationId)) {
      // The connection's pinned branch must be inside its own consent —
      // otherwise the connector's pins and its consent would disagree.
      return { ok: false, error: "branch_out_of_scope" };
    }
    const { rows: branchCheck } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM locations
        WHERE business_id = $1 AND id = ANY($2::uuid[]) AND is_active`,
      [businessId, grants.branches],
    );
    if (Number(branchCheck[0]?.count ?? 0) !== grants.branches.length) {
      return { ok: false, error: "branch_out_of_scope" };
    }
  }

  const token = createMcpStaticToken();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO mcp_connections
       (business_id, location_id, name, scopes, write_mode, origin, token_prefix, token_hash,
        created_by, authorized_by, expires_at, grants)
     VALUES ($1, $2, $3, $4, $5, 'token', $6, $7, $8, $8,
             CASE WHEN $9::numeric IS NULL THEN NULL ELSE now() + ($9 || ' days')::interval END,
             $10::jsonb)
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
      JSON.stringify(grants),
    ],
  );
  const connection = await getMcpConnection(businessId, rows[0].id);
  if (connection) {
    await recordMcpGrantEvent({
      businessId,
      connectionId: rows[0].id,
      kind: "minted",
      scopes,
      writeMode,
      grants,
      actorUserId: createdBy,
      via: "api",
    });
  }
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
export async function revokeMcpConnection(
  businessId: string,
  id: string,
  actorUserId?: string | null,
): Promise<boolean> {
  const { rows: before } = await query<{ scopes: unknown; write_mode: string; grants: unknown }>(
    `SELECT scopes, write_mode, grants FROM mcp_connections
      WHERE id = $1 AND business_id = $2 AND status = 'active'`,
    [id, businessId],
  );
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
  if (before[0]) {
    await recordMcpGrantEvent({
      businessId,
      connectionId: id,
      kind: "revoked",
      scopes: Array.isArray(before[0].scopes) ? (before[0].scopes as string[]) : [],
      writeMode: before[0].write_mode,
      grants: before[0].grants ?? null,
      actorUserId: actorUserId ?? null,
      via: "api",
    });
  }
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
  input: { scopes: unknown; writeMode: unknown; authorizedBy: string; grants?: unknown },
): Promise<{ ok: true; connection: McpConnectionSummary } | { ok: false; error: string }> {
  const scopes = parseMcpScopes(input.scopes);
  if (scopes.length === 0) return { ok: false, error: "invalid_scopes" };
  if (!isMcpWriteMode(input.writeMode)) return { ok: false, error: "invalid_write_mode" };

  // Grants, when supplied, replace wholesale — the panel posts the full
  // document it rendered, so there is no partial-update ambiguity. A
  // narrowed app or branch consent cancels queued proposals for exactly the
  // reason dropping `pos.write` does.
  let grants: McpGrants | null = null;
  if (input.grants !== undefined) {
    grants = parseMcpGrants(input.grants);
    if (validateMcpGrantsMint(grants) !== null) {
      return { ok: false, error: "invalid_grants" };
    }
  }

  const { rows: current } = await query<{ grants: unknown }>(
    `SELECT grants FROM mcp_connections WHERE id = $1 AND business_id = $2 AND status = 'active'`,
    [id, businessId],
  );
  if (!current[0]) return { ok: false, error: "connection_not_found" };
  const previousGrants = parseMcpGrants(current[0].grants);

  const { rowCount } = await query(
    `UPDATE mcp_connections
        SET scopes = $3, write_mode = $4, authorized_by = $5,
            grants = COALESCE($6::jsonb, grants)
      WHERE id = $1 AND business_id = $2 AND status = 'active'`,
    [id, businessId, scopes, input.writeMode, input.authorizedBy, grants ? JSON.stringify(grants) : null],
  );
  if ((rowCount ?? 0) === 0) return { ok: false, error: "connection_not_found" };

  // Narrowing away the write grant cancels what it had queued: keeping those
  // rows approvable would let a human execute writes for a connector the
  // owner has since decided may not write (issue #883 P0-3). Same for a
  // narrowed app or branch consent (A3) — the approval-time gate would fail
  // them anyway, and failing them in-band here keeps the queue honest.
  if (!scopes.includes(MCP_SCOPES.write)) {
    await cancelOutstandingProposals(businessId, id, "connection_narrowed");
  } else if (grants && grantsNarrowed(previousGrants, grants)) {
    await cancelOutstandingProposals(businessId, id, "connection_narrowed");
  }

  const connection = await getMcpConnection(businessId, id);
  if (connection) {
    await recordMcpGrantEvent({
      businessId,
      connectionId: id,
      kind: "access_changed",
      scopes,
      writeMode: input.writeMode,
      grants: grants ?? current[0].grants ?? null,
      actorUserId: input.authorizedBy,
      via: "api",
    });
  }
  return connection ? { ok: true, connection } : { ok: false, error: "connection_not_found" };
}

/**
 * Did the replacement grant document narrow the old one? Broadenings are
 * harmless (queued proposals stay valid); narrowings dismiss them.
 * `same-or-narrower` per app and per branch set.
 */
function grantsNarrowed(previous: McpGrants, next: McpGrants): boolean {
  // Legacy ({}) can never be topped: any replacement is a narrowing unless it
  // is exactly legacy again.
  const prevLegacy = isLegacyGrants(previous);
  const nextLegacy = isLegacyGrants(next);
  if (prevLegacy && nextLegacy) return false;
  if (prevLegacy) return true;
  if (nextLegacy) return false;
  for (const app of Object.keys(previous.apps) as Array<keyof typeof previous.apps>) {
    const before = previous.apps[app]!;
    const after = next.apps[app] ?? { read: false, write: false };
    if (before.write && !after.write) return true;
    if (before.read && !after.read) return true;
  }
  if (previous.branches === "all") {
    if (next.branches !== "all") return true;
    return false;
  }
  if (next.branches === "all") return false;
  for (const branch of previous.branches) {
    if (!next.branches.includes(branch)) return true;
  }
  return false;
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
  /** Immutably stored at OVERVIEW time — what the executor saw when the
   * proposal was framed, distinct from the payload the approval will apply. */
  priorState: Record<string, unknown> | null;
  revertible: "always" | "while_open" | false;
  /** Issue #883 step-up — the action's risk tier from the registry, so the
   * owner sees why an apply-mode connector still queued this one. */
  risk: "low" | "high";
  /** How long the row has sat un-decided, for the "stale" hint. */
  createdAt: string;
}

export async function listMcpPendingActions(
  businessId: string,
  limit = 50,
): Promise<McpPendingAction[]> {
  // A4 — a crashed claimant's row must surface as failed-for-review, not sit
  // in `processing` forever. Reconciliation is one statement and cheap; doing
  // it here means every dashboard refresh heals the queue.
  await reconcileStaleMcpClaims(businessId);
  const { rows } = await query<{
    id: string;
    mcp_connection_id: string | null;
    connection_name: string | null;
    action_type: string;
    action_title: string;
    action_summary: string;
    proposal_payload: Record<string, unknown>;
    prior_state: Record<string, unknown> | null;
    created_at: string;
  }>(
    `SELECT a.id, a.mcp_connection_id, c.name AS connection_name, a.action_type,
            a.action_title, a.action_summary, a.proposal_payload, a.prior_state, a.created_at
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
      priorState: row.prior_state ?? null,
      revertible: meta?.revertible ?? false,
      risk: mcpWriteRegistryEntry(row.action_type)?.risk ?? "low",
      createdAt: row.created_at,
    };
  });
}

export async function countMcpPendingActions(businessId: string): Promise<number> {
  await reconcileStaleMcpClaims(businessId);
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ai_action_audit
      WHERE business_id = $1 AND source = 'mcp' AND status = 'proposed'`,
    [businessId],
  );
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// The outcome history (issue #883 §11 — history tab with pagination/filters)
// ---------------------------------------------------------------------------

export interface McpHistoryAction {
  id: string;
  connectionId: string | null;
  connectionName: string | null;
  actionType: string;
  actionLabel: string;
  title: string;
  summary: string;
  status: "applied" | "failed" | "dismissed";
  result: Record<string, unknown> | null;
  requiresReview: boolean;
  createdAt: string;
  closedAt: string | null;
}

export interface ListMcpHistoryInput {
  limit?: number;
  offset?: number;
  status?: "applied" | "failed" | "dismissed" | "";
  connectionId?: string;
  search?: string;
}

export interface McpHistoryPage {
  rows: McpHistoryAction[];
  total: number;
}

/**
 * The decided half of the MCP trail. propose→execute lifecycle is in
 * `listMcpPendingActions`; this is the owner's audit of what the connector
 * actually did (or tried to). Pagination is OFFSET-based — the queue size is
 * bounded by the rate limits, so cursor mechanics buy nothing here.
 */
/* -------------------------------------------------------------------------- */
/* Consent-grants history (issue #883 §1 follow-up)                           */
/*                                                                            */
/* `mcp_grant_events` is the append-once answer to "who agreed to this?" —    */
/* one row each time a connection's allowance is decided: the minted consent, */
/* every access change, and the revocation. Nothing edits and nothing deletes, */
/* so a row written at minting still reads identically when auditors ask why  */
/* a connector could touch the CRM last winter.                                */
/* -------------------------------------------------------------------------- */

export interface McpGrantEvent {
  id: string;
  kind: "minted" | "access_changed" | "revoked";
  scopes: string[];
  writeMode: string;
  grants: unknown;
  actorUserId: string | null;
  actorName: string | null;
  via: "api" | "oauth_consent" | "system";
  createdAt: string;
}

export async function recordMcpGrantEvent(input: {
  businessId: string;
  connectionId: string;
  kind: McpGrantEvent["kind"];
  scopes: string[];
  writeMode: string;
  grants: unknown;
  actorUserId: string | null;
  via: McpGrantEvent["via"];
}): Promise<void> {
  await query(
    `INSERT INTO mcp_grant_events
       (business_id, connection_id, kind, scopes, write_mode, grants, actor_user_id, via)
     VALUES ($1, $2, $3, $4::text[], $5, $6::jsonb, $7, $8)`,
    [
      input.businessId,
      input.connectionId,
      input.kind,
      input.scopes,
      input.writeMode,
      JSON.stringify(input.grants ?? null),
      input.actorUserId,
      input.via,
    ],
  );
}

/**
 * One connection's grant history, newest first. Returns the connection's
 * current summary alongside so a panel call gets "what is" and "what happened"
 * in one shape; null when the connection does not belong to this business.
 */
export async function listMcpGrantHistory(
  businessId: string,
  connectionId: string,
): Promise<{ connection: McpConnectionSummary; events: McpGrantEvent[] } | null> {
  const connection = await getMcpConnection(businessId, connectionId);
  if (!connection) return null;
  const { rows } = await query<{
    id: string;
    kind: "minted" | "access_changed" | "revoked";
    scopes: unknown;
    write_mode: string;
    grants: unknown;
    actor_user_id: string | null;
    actor_name: string | null;
    via: "api" | "oauth_consent" | "system";
    created_at: string;
  }>(
    `SELECT e.id, e.kind, e.scopes, e.write_mode, e.grants, e.actor_user_id,
            u.name AS actor_name, e.via, e.created_at
       FROM mcp_grant_events e
       LEFT JOIN users u ON u.id = e.actor_user_id AND u.business_id = e.business_id
      WHERE e.business_id = $1 AND e.connection_id = $2
      ORDER BY e.created_at DESC, e.id DESC`,
    [businessId, connectionId],
  );
  return {
    connection,
    events: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
      writeMode: row.write_mode,
      grants: row.grants,
      actorUserId: row.actor_user_id,
      actorName: row.actor_name,
      via: row.via,
      createdAt: row.created_at,
    })),
  };
}

export async function listMcpHistory(
  businessId: string,
  input: ListMcpHistoryInput = {},
): Promise<McpHistoryPage> {
  await reconcileStaleMcpClaims(businessId);
  const limit = Math.min(Math.max(1, input.limit ?? 20), 100);
  const offset = Math.max(0, input.offset ?? 0);
  const status = input.status && ["applied", "failed", "dismissed"].includes(input.status)
    ? input.status
    : null;
  const search = input.search?.trim() ? `%${input.search.trim()}%` : null;

  const { rows } = await query<{
    id: string;
    mcp_connection_id: string | null;
    connection_name: string | null;
    action_type: string;
    action_title: string;
    action_summary: string;
    status: string;
    result: Record<string, unknown> | null;
    created_at: string;
    applied_at: string | null;
    total: string;
  }>(
    `SELECT a.id, a.mcp_connection_id, c.name AS connection_name, a.action_type,
            a.action_title, a.action_summary, a.status, a.result,
            a.created_at, a.applied_at, count(*) OVER()::text AS total
       FROM ai_action_audit a
       LEFT JOIN mcp_connections c ON c.id = a.mcp_connection_id AND c.business_id = a.business_id
      WHERE a.business_id = $1
        AND a.source = 'mcp'
        AND a.status IN ('applied', 'failed', 'dismissed')
        AND ($2::text IS NULL OR a.status = $2)
        AND ($3::uuid IS NULL OR a.mcp_connection_id = $3)
        AND ($4::text IS NULL OR a.action_title ILIKE $4 OR a.action_summary ILIKE $4 OR a.action_type ILIKE $4)
      ORDER BY a.created_at DESC
      LIMIT $5 OFFSET $6`,
    [businessId, status, input.connectionId ?? null, search, limit, offset],
  );
  return {
    rows: rows.map((row) => ({
      id: row.id,
      connectionId: row.mcp_connection_id,
      connectionName: row.connection_name,
      actionType: row.action_type,
      actionLabel: ACTION_CATALOG[row.action_type as ActionType]?.label ?? row.action_type,
      title: row.action_title,
      summary: row.action_summary,
      status: row.status as McpHistoryAction["status"],
      result: row.result,
      requiresReview: row.result?.requiresReview === true,
      createdAt: row.created_at,
      closedAt: row.applied_at,
    })),
    total: Number(rows[0]?.total ?? 0),
  };
}
