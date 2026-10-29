/**
 * Issue #1128 §E — the service half of client media review.
 *
 * Three legs hold this feature up, and it matters which one you are reading:
 * the vocabulary is in `media-review.ts` (pure, browser-safe, no crypto), the
 * invariants are in migration 0265 (constraints and triggers), and this file is
 * the only place that touches `node:crypto` or resolves a token to a tenant.
 *
 * The four things only a service can do:
 *
 *   * **A TOKEN SELECTS ITS OWN TENANT, AND NOTHING ELSE DOES.** There is no
 *     member session on the client side — that is the whole point of a scoped
 *     link — so the tenant cannot be read from a cookie. The token is hashed and
 *     looked up under `withoutTenantScope` for exactly one query, and every
 *     statement after that runs inside the resolved tenant's own scope. The
 *     bypass is a lookup, not a session: it is never held open across a write.
 *     `api-auth.ts` established the shape and the reason for it.
 *   * **THE NAMESPACE IS CHECKED BEFORE ANY LOOKUP.** A pasted API key, a pairing
 *     code or a guessed string is refused by shape, so the database is never
 *     asked about it. Same rule `parseApiBearerToken` follows.
 *   * **ONLY THE HASH IS EVER STORED.** `createMediaReviewToken` returns the
 *     plaintext exactly once, to the member who minted it, and this module keeps
 *     no copy. Migration 0265's `token_hash ~ '^[0-9a-f]{64}$'` means a
 *     plaintext token could not be persisted even by a bug here.
 *   * **BYTES ARE STREAMED, NEVER PRESIGNED.** `presignS3Get` exists and would be
 *     one line, but a presigned URL cannot be revoked before it expires and
 *     leaves no record of who fetched what — and §E requires both. So the token
 *     resolves to a round, the round to an item, and the item is streamed by the
 *     same code the tenant's own library uses, which refuses a storage key that
 *     does not belong to the business it was asked for. `storage_key` never
 *     leaves this file.
 *
 * NOT INDUSTRY-GATED, deliberately, and unlike §D's `assertAgencyIndustry`. The
 * Media Library is a platform feature every trade already has, and "send a batch
 * of files to a client and get an approval" is not an agency idea: a photographer,
 * a print shop and a web studio all need it. The agency-specific part is the
 * *format vocabulary*, which is nullable metadata rather than a gate, so another
 * trade leaves it empty and loses nothing. Nothing here is a new app either — it
 * lives inside the existing Media Library, which is what keeps the
 * four-tenant-app rule intact.
 *
 * Also deliberately absent: any journal entry. This is an approval workflow; it
 * moves no money and posts nothing.
 */

import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTenant, withTenantTransaction, withoutTenantScope } from "./db";
import { isValidMediaUuid } from "./media";
import { getActiveMediaAssetWithStorageKey, getMediaConfig, streamMediaObject } from "./media-service";
import {
  AGENCY_MEDIA_FORMATS,
  AGENCY_MEDIA_FORMAT_LABELS,
  MEDIA_REVIEW_DECIDABLE_STATUSES,
  MEDIA_REVIEW_NOTE_MAX_LENGTH,
  MEDIA_REVIEW_TOKEN_PREFIX,
  canTransitionReviewRound,
  clampReviewLinkTtlDays,
  clientReviewActionsFrom,
  isAgencyMediaFormat,
  isReviewItemStatus,
  isReviewLinkPurpose,
  isReviewRoundAction,
  isReviewRoundOpenForItems,
  isReviewRoundStatus,
  looksLikeMediaReviewToken,
  mediaReviewTokenDisplayPrefix,
  reviewDecisionNoteRequired,
  reviewLinkExpiresAt,
  reviewLinkPurposeAllowsDownload,
  reviewLinkRefusal,
  reviewRoundActionTarget,
  reviewRoundActionsFrom,
  trimReviewNote,
  type AgencyMediaFormat,
  type MediaReviewItemStatus,
  type MediaReviewLinkPurpose,
  type MediaReviewRoundAction,
  type MediaReviewRoundStatus,
  agencyReviewActionsFrom,
  isReviewRoundIdentityFrozen,
  MEDIA_REVIEW_SETTLED_STATUSES,
} from "./media-review";

/* ===========================================================================
 * Errors
 * ======================================================================== */

/**
 * Every refusal this service can produce, as a stable code.
 *
 * One union rather than ad hoc messages, so a route maps code → status in one
 * table and a screen maps code → Persian copy in another, and neither invents
 * its own vocabulary. The client-facing three (`token_expired`, `token_revoked`,
 * `round_not_sent`) are deliberately distinct: "this link does not work" is not
 * an answer a client can act on, but "ask the agency for a new link" and "ask the
 * agency why this was withdrawn" are two different phone calls.
 *
 * `link_exists` is separate from `invalid_purpose` for the same reason — one live
 * link per round per purpose is a rule, and "revoke the current link first" is
 * actionable while "invalid purpose" sends somebody to look at their request.
 */
export const MEDIA_REVIEW_ERROR_CODES = [
  "missing_fields",
  "invalid_format",
  "invalid_purpose",
  "invalid_action",
  "invalid_status",
  "round_not_found",
  "link_not_found",
  "link_exists",
  "item_not_found",
  "asset_not_found",
  "too_many_items",
  "invalid_transition",
  "round_not_open_for_items",
  "round_frozen",
  "round_not_sent",
  "items_pending",
  "items_not_approved",
  "note_required",
  "invalid_token",
  "token_expired",
  "token_revoked",
  "download_not_permitted",
  "storage_unavailable",
] as const;

export type MediaReviewErrorCode = (typeof MEDIA_REVIEW_ERROR_CODES)[number];

export class MediaReviewError extends Error {
  constructor(readonly code: MediaReviewErrorCode) {
    super(code);
    this.name = "MediaReviewError";
  }
}

/**
 * How many assets one round may carry.
 *
 * A product judgement rather than a database limit: a client sent four hundred
 * files does not review them, they close the tab. It lives here and not in a
 * route so the tenant UI and the API cannot disagree about it.
 */
export const MAX_REVIEW_ROUND_ITEMS = 50;

/** Fallback audit label when nobody is named — Persian for "the client". */
const CLIENT_ACTOR_FALLBACK = "کارفرما";

/* ===========================================================================
 * Who is acting
 * ======================================================================== */

/** A member of the tenant. `fullName` becomes the audit label. */
export interface ReviewActor {
  userId: string;
  fullName: string;
}

/* ===========================================================================
 * Wire shapes
 * ======================================================================== */

export interface ReviewRoundItem {
  assetId: string;
  fileName: string;
  kind: string;
  mimeType: string | null;
  byteSize: number;
  format: AgencyMediaFormat | null;
  versionLabel: string | null;
  position: number;
  status: MediaReviewItemStatus;
  note: string | null;
  decidedAt: string | null;
  /**
   * Where a screen loads this item's bytes from.
   *
   * For a member it is the library's own file route, which authorizes from their
   * session. For a client it is the token route, because the library route would
   * answer 403 — a client has no session, and that gap is exactly why §E's scoped
   * links exist. Either way it is a relative API path, never a `storage_key` and
   * never a presigned URL.
   */
  fileUrl: string;
}

export interface ReviewRoundLink {
  id: string;
  purpose: MediaReviewLinkPurpose;
  tokenPrefix: string;
  ttlDays: number;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
}

export interface ReviewRoundEvent {
  id: string;
  actorKind: "member" | "client" | "system";
  actorLabel: string;
  action: string;
  fromState: string | null;
  toState: string | null;
  note: string | null;
  assetId: string | null;
  createdAt: string;
}

export interface ReviewRound {
  id: string;
  title: string;
  note: string | null;
  status: MediaReviewRoundStatus;
  projectId: string | null;
  projectName: string | null;
  clientPartyId: string | null;
  clientName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  createdBy: string | null;
  createdByName: string;
  sentAt: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  decidedCount: number;
  /**
   * Both action lists come from the pure module, so a screen cannot offer a move
   * the state machine would refuse and a route cannot accept one it would not.
   * `actions` is the agency's; `clientActions` is what a token holder may do.
   */
  actions: readonly MediaReviewRoundAction[];
  clientActions: readonly MediaReviewRoundAction[];
}

export interface ReviewRoundDetail extends ReviewRound {
  items: ReviewRoundItem[];
  links: ReviewRoundLink[];
  events: ReviewRoundEvent[];
}

export interface ReviewRoundSummary extends ReviewRound {
  /**
   * How many unrevoked, unexpired links point at this round. On the summary and
   * not the round because it is a security fact a dashboard should show at a
   * glance: a round with a live link is a round somebody outside the tenant can
   * open right now.
   */
  liveLinkCount: number;
}

/** What a client sees. No links, no events, no storage keys, no other rounds. */
export interface ClientReviewView {
  round: ReviewRound;
  items: ReviewRoundItem[];
  clientName: string | null;
  actions: readonly MediaReviewRoundAction[];
}

/* ===========================================================================
 * Coercion
 * ======================================================================== */

function trimTo(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max);
}

function nullableText(value: unknown, max: number): string | null {
  const text = trimTo(value, max);
  return text ? text : null;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && isValidMediaUuid(value) ? value : null;
}

/** Postgres `bigint` and `count(*)` arrive as strings; these are only counted. */
function intOr(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : (value as number | null | undefined);
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/**
 * Timestamps to ISO.
 *
 * node-postgres hands back a `Date` for `timestamptz`, and `toISOString` is the
 * only rendering that does not shift a value by the server's offset — the same
 * trap §D paid for in CI with `date` columns, one column type over.
 */
function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/* ===========================================================================
 * Row mapping
 * ======================================================================== */

type Row = Record<string, unknown>;

function rowToRound(row: Row): ReviewRound {
  const status = isReviewRoundStatus(row.state) ? row.state : "draft";
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    note: nullableText(row.note, MEDIA_REVIEW_NOTE_MAX_LENGTH),
    status,
    projectId: uuidOrNull(row.project_id),
    projectName: nullableText(row.project_name, 200),
    clientPartyId: uuidOrNull(row.client_party_id),
    clientName: nullableText(row.client_name, 200),
    campaignId: uuidOrNull(row.campaign_id),
    campaignName: nullableText(row.campaign_name, 200),
    createdBy: uuidOrNull(row.created_by),
    createdByName: String(row.created_by_name ?? ""),
    sentAt: iso(row.sent_at),
    decidedAt: iso(row.decided_at),
    decidedByName: nullableText(row.decided_by_name, 200),
    decisionNote: nullableText(row.decision_note, MEDIA_REVIEW_NOTE_MAX_LENGTH),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    itemCount: intOr(row.item_count, 0),
    decidedCount: intOr(row.decided_count, 0),
    actions: agencyReviewActionsFrom(status),
    clientActions: clientReviewActionsFrom(status),
  };
}

function rowToItem(row: Row, fileUrlFor: (assetId: string) => string): ReviewRoundItem {
  const assetId = String(row.asset_id);
  return {
    assetId,
    fileName: String(row.file_name ?? ""),
    kind: String(row.kind ?? "document"),
    mimeType: nullableText(row.mime_type, 200),
    byteSize: intOr(row.byte_size, 0),
    format: isAgencyMediaFormat(row.format) ? row.format : null,
    versionLabel: nullableText(row.version_label, 80),
    position: intOr(row.position, 0),
    status: isReviewItemStatus(row.state) ? row.state : "pending",
    note: nullableText(row.note, MEDIA_REVIEW_NOTE_MAX_LENGTH),
    decidedAt: iso(row.decided_at),
    fileUrl: fileUrlFor(assetId),
  };
}

function rowToLink(row: Row): ReviewRoundLink {
  return {
    id: String(row.id),
    purpose: isReviewLinkPurpose(row.purpose) ? row.purpose : "review",
    tokenPrefix: String(row.token_prefix ?? ""),
    ttlDays: intOr(row.ttl_days, 7),
    expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
    revokedAt: iso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
    useCount: intOr(row.use_count, 0),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function rowToEvent(row: Row): ReviewRoundEvent {
  const kind = row.actor_kind;
  return {
    id: String(row.id),
    actorKind: kind === "member" || kind === "client" || kind === "system" ? kind : "system",
    actorLabel: String(row.actor_label ?? CLIENT_ACTOR_FALLBACK),
    action: String(row.action ?? ""),
    fromState: nullableText(row.from_state, 40),
    toState: nullableText(row.to_state, 40),
    note: nullableText(row.note, MEDIA_REVIEW_NOTE_MAX_LENGTH),
    assetId: uuidOrNull(row.asset_id),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/* ===========================================================================
 * Shared SELECT fragments
 * ======================================================================== */

/**
 * The round, its two progress counts, and the names a screen shows.
 *
 * The counts are computed in SQL rather than by the caller so a list view and a
 * detail view cannot disagree about how far a client has got — the kind of drift
 * that ends with an agency telephoning a client who has already finished.
 */
const ROUND_SELECT = `
  SELECT r.*,
         p.name  AS project_name,
         cp.name AS client_name,
         gc.name AS campaign_name,
         (SELECT count(*)::int FROM media_review_round_items i
           WHERE i.round_id = r.id) AS item_count,
         (SELECT count(*)::int FROM media_review_round_items i
           WHERE i.round_id = r.id AND i.state <> 'pending') AS decided_count
    FROM media_review_rounds r
    LEFT JOIN ai_projects p       ON p.id = r.project_id
    LEFT JOIN parties cp          ON cp.id = r.client_party_id
    LEFT JOIN growth_campaigns gc ON gc.id = r.campaign_id`;

const ITEM_SELECT = `
  SELECT i.*, a.file_name, a.kind, a.mime_type, a.byte_size
    FROM media_review_round_items i
    JOIN media_assets a ON a.id = i.asset_id`;

/** A member's own library route: it authorizes from their session. */
const memberFileUrl = (assetId: string): string => `/api/media/${assetId}/file`;

/**
 * The token-scoped route a client's bytes come from.
 *
 * The token is already in the client's hands — it is the URL they opened — so
 * embedding it per item exposes nothing new, and it saves a screen from
 * reconstructing a path it could get subtly wrong.
 */
export function clientFileUrl(token: string, assetId: string): string {
  return `/api/media/review/${encodeURIComponent(token)}/assets/${assetId}/file`;
}

/* ===========================================================================
 * Tokens — the only crypto in §E
 * ======================================================================== */

/**
 * A fresh client review token, and its hash.
 *
 * 32 random bytes, base64url, behind the `bmrl_` namespace — the construction
 * `createApiKey` already uses, because it is the one the rest of the product
 * trusts and already knows how to refuse when the prefix is wrong. The plaintext
 * is returned to be shown once and then forgotten.
 */
export function createMediaReviewToken(): {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
} {
  const token = MEDIA_REVIEW_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashMediaReviewToken(token),
    tokenPrefix: mediaReviewTokenDisplayPrefix(token),
  };
}

/** sha-256 hex: the only form of a token that is ever written down. */
export function hashMediaReviewToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** What a resolved token grants. */
export interface ResolvedReviewToken {
  businessId: string;
  linkId: string;
  roundId: string;
  purpose: MediaReviewLinkPurpose;
}

export type ReviewTokenResolution =
  | { ok: true; grant: ResolvedReviewToken }
  | { ok: false; code: MediaReviewErrorCode };

/**
 * Resolve a plaintext token to a grant.
 *
 * The order of these checks is the security argument, so it is worth stating:
 *
 *   1. **Shape first.** `looksLikeMediaReviewToken` refuses anything outside the
 *      `bmrl_` namespace before a single query runs, so a pasted API key or a
 *      guessed string never reaches the database and cannot be used to probe it.
 *   2. **One unscoped lookup.** Link and round are read together, under
 *      `withoutTenantScope`, because the tenant is not known yet — the token is
 *      how it gets selected. This is the only statement in §E that runs outside a
 *      tenant scope; it selects one row by a unique index and is never held open
 *      across a write.
 *   3. **Liveness, with the reason.** Unexpired *and* unrevoked, via the pure
 *      helper, and the refusal distinguishes expired from revoked so the client
 *      is told which of two different things to ask the agency for.
 *   4. **The round must still be with the client.** A live link to a withdrawn or
 *      never-sent round grants nothing. `withdrawReviewRound` revokes links, but
 *      the state is checked as well: "never public cross-tenant URLs" deserves a
 *      brace behind the belt.
 *
 * Nothing here is tenant-scoped yet, so nothing here reads asset bytes. Callers
 * must enter the resolved tenant's scope before doing anything else.
 */
export async function resolveReviewToken(raw: unknown): Promise<ReviewTokenResolution> {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!looksLikeMediaReviewToken(token)) return { ok: false, code: "invalid_token" };

  const rows = await withoutTenantScope("media-review-token", async () => {
    const { rows: found } = await query<Row>(
      `SELECT l.id AS link_id, l.purpose, l.expires_at, l.revoked_at,
              r.id AS round_id, r.business_id, r.state
         FROM media_review_links l
         JOIN media_review_rounds r ON r.id = l.round_id
        WHERE l.token_hash = $1
        LIMIT 1`,
      [hashMediaReviewToken(token)],
    );
    return found;
  });
  const row = rows[0];
  if (!row) return { ok: false, code: "invalid_token" };

  const link = rowToLink({ ...row, id: row.link_id });
  const refusal = reviewLinkRefusal({
    expiresAt: row.expires_at as string | Date,
    revokedAt: (row.revoked_at as string | Date | null) ?? null,
  });
  if (refusal === "revoked") return { ok: false, code: "token_revoked" };
  if (refusal === "expired") return { ok: false, code: "token_expired" };

  const state = row.state;
  if (!isReviewRoundStatus(state) || !MEDIA_REVIEW_DECIDABLE_STATUSES.includes(state)) {
    return { ok: false, code: "round_not_sent" };
  }

  return {
    ok: true,
    grant: {
      businessId: String(row.business_id),
      linkId: link.id,
      roundId: String(row.round_id),
      purpose: link.purpose,
    },
  };
}

/* ===========================================================================
 * Audit
 * ======================================================================== */

interface EventInput {
  businessId: string;
  roundId: string;
  assetId?: string | null;
  linkId?: string | null;
  actorUserId?: string | null;
  actorKind: "member" | "client" | "system";
  actorLabel: string;
  action: string;
  fromState?: string | null;
  toState?: string | null;
  note?: string | null;
}

/**
 * Append one line to the trail.
 *
 * `actor_kind` and `actor_user_id` are coupled by a CHECK that runs one direction
 * only — a user id implies a member, but a member loses their id when the account
 * is deleted — so a client event must pass no user id and carry its name in
 * `actorLabel`. That label is NOT NULL for exactly this reason: the name has to
 * outlive the account.
 */
async function recordEvent(client: PoolClient, input: EventInput): Promise<void> {
  await client.query(
    `INSERT INTO media_review_events
       (business_id, round_id, asset_id, link_id, actor_user_id, actor_kind,
        actor_label, action, from_state, to_state, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      input.businessId,
      input.roundId,
      input.assetId ?? null,
      input.linkId ?? null,
      input.actorKind === "member" ? (input.actorUserId ?? null) : null,
      input.actorKind,
      (input.actorLabel.trim() || CLIENT_ACTOR_FALLBACK).slice(0, 200),
      input.action.trim().slice(0, 80),
      input.fromState ?? null,
      input.toState ?? null,
      input.note ?? null,
    ],
  );
}

/**
 * A member's name for the audit label.
 *
 * Read rather than taken on trust from the session, because a session's display
 * name can be stale and the trail is the record of who actually acted. Read once
 * per transaction and passed around, never re-queried per event.
 */
async function actorLabelFor(
  client: PoolClient,
  businessId: string,
  actor: ReviewActor,
): Promise<string> {
  const given = actor.fullName.trim();
  if (given) return given.slice(0, 200);
  const { rows } = await client.query<{ full_name: string }>(
    `SELECT full_name FROM users WHERE id = $1 AND business_id = $2 LIMIT 1`,
    [actor.userId, businessId],
  );
  return (rows[0]?.full_name ?? "").trim().slice(0, 200) || CLIENT_ACTOR_FALLBACK;
}

/**
 * Count a link use, without writing an event.
 *
 * Deliberately not an audit row: a client refreshing the page twenty times is
 * twenty counter increments and one fact — "this link was opened" — which
 * `use_count` and `last_used_at` already state. Flooding the trail with page
 * views would bury the decisions and downloads that actually matter, and make
 * the trail worse at its one job. Downloads and decisions do get rows.
 *
 * Best-effort: a failed counter write must not 500 a client who is trying to look
 * at their proofs.
 */
async function touchLinkUse(businessId: string, linkId: string): Promise<void> {
  try {
    await withTenant(businessId, async () => {
      await query(
        `UPDATE media_review_links SET last_used_at = now(), use_count = use_count + 1
          WHERE id = $1 AND business_id = $2`,
        [linkId, businessId],
      );
    });
  } catch {
    // Swallowed deliberately; see above.
  }
}

/* ===========================================================================
 * Tenant side — reading
 * ======================================================================== */

export interface ReviewRoundFilters {
  status?: MediaReviewRoundStatus | "open" | "all";
  projectId?: string | null;
  clientPartyId?: string | null;
  campaignId?: string | null;
  limit?: number;
}

/** Rounds newest-first, with progress and how many live links each carries. */
export async function listReviewRounds(
  businessId: string,
  filters: ReviewRoundFilters = {},
): Promise<ReviewRoundSummary[]> {
  // Tenant scope is a predicate in the SQL rather than an ambient assumption:
  // seeding it first means a filterless list still cannot cross businesses, and
  // every filter below numbers itself after it. RLS is the backstop, not the plan.
  const where: string[] = [`r.business_id = $1`];
  const params: unknown[] = [businessId];
  const addWhere = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };

  const status = filters.status ?? "all";
  // "open" is anything a client could still act on or an agency could still
  // amend: approved is terminal, withdrawn is closed.
  if (status === "open") {
    where.push(`r.state IN ('draft','sent','changes_requested','rejected')`);
  } else if (isReviewRoundStatus(status)) {
    addWhere(`r.state = ?`, status);
  }
  if (filters.projectId) addWhere(`r.project_id = ?`, filters.projectId);
  if (filters.clientPartyId) addWhere(`r.client_party_id = ?`, filters.clientPartyId);
  if (filters.campaignId) addWhere(`r.campaign_id = ?`, filters.campaignId);

  params.push(Math.min(Math.max(intOr(filters.limit, 50), 1), 200));
  const limitParam = `$${params.length}`;

  return withTenant(businessId, async () => {
    const { rows } = await query<Row>(
      `${ROUND_SELECT.replace(
        "SELECT r.*,",
        `SELECT r.*,
                (SELECT count(*)::int FROM media_review_links l
                  WHERE l.round_id = r.id AND l.revoked_at IS NULL
                    AND l.expires_at > now()) AS live_link_count,`,
      )}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY r.created_at DESC
        LIMIT ${limitParam}`,
      params,
    );
    return rows.map((row) => ({
      ...rowToRound(row),
      liveLinkCount: intOr(row.live_link_count, 0),
    }));
  });
}

/** One round with its items, links and trail. */
export async function getReviewRound(
  businessId: string,
  roundId: string,
): Promise<ReviewRoundDetail | null> {
  if (!isValidMediaUuid(roundId)) return null;
  return withTenant(businessId, async () => {
    const { rows } = await query<Row>(
      `${ROUND_SELECT} WHERE r.id = $1 AND r.business_id = $2 LIMIT 1`,
      [roundId, businessId],
    );
    const row = rows[0];
    if (!row) return null;

    const [items, links, events] = await Promise.all([
      query<Row>(
        `${ITEM_SELECT} WHERE i.round_id = $1 AND i.business_id = $2 ORDER BY i.position, i.added_at`,
        [roundId, businessId],
      ),
      query<Row>(
        `SELECT * FROM media_review_links
          WHERE round_id = $1 AND business_id = $2 ORDER BY created_at DESC`,
        [roundId, businessId],
      ),
      query<Row>(
        `SELECT * FROM media_review_events
          WHERE round_id = $1 AND business_id = $2 ORDER BY id DESC LIMIT 200`,
        [roundId, businessId],
      ),
    ]);

    return {
      ...rowToRound(row),
      items: items.rows.map((item) => rowToItem(item, memberFileUrl)),
      links: links.rows.map(rowToLink),
      events: events.rows.map(rowToEvent),
    };
  });
}

/* ===========================================================================
 * Tenant side — writing
 * ======================================================================== */

export interface CreateReviewRoundInput {
  title: string;
  note?: string | null;
  projectId?: string | null;
  clientPartyId?: string | null;
  campaignId?: string | null;
  assetIds?: readonly unknown[];
  formats?: Record<string, unknown>;
}

/**
 * Create a draft round, optionally with its first assets.
 *
 * One transaction, because a round with half its items inserted is a round an
 * agency might send. The assets are not tenant-checked here: migration 0265's
 * trigger refuses a foreign or binned asset, which is the stronger guarantee, and
 * restating it in SQL that could drift would be a second, weaker answer to the
 * same question.
 */
export async function createReviewRound(
  businessId: string,
  actor: ReviewActor,
  input: CreateReviewRoundInput,
): Promise<ReviewRoundDetail> {
  const title = trimTo(input.title, 200);
  if (!title) throw new MediaReviewError("missing_fields");

  const assetIds = [
    ...new Set((input.assetIds ?? []).map((value) => String(value)).filter(isValidMediaUuid)),
  ];
  if (assetIds.length > MAX_REVIEW_ROUND_ITEMS) throw new MediaReviewError("too_many_items");

  const roundId = await withTenantTransaction(businessId, async (client) => {
    const label = await actorLabelFor(client, businessId, actor);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO media_review_rounds
         (business_id, title, note, project_id, client_party_id, campaign_id,
          created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        businessId,
        title,
        nullableText(input.note, MEDIA_REVIEW_NOTE_MAX_LENGTH),
        uuidOrNull(input.projectId),
        uuidOrNull(input.clientPartyId),
        uuidOrNull(input.campaignId),
        actor.userId,
        label,
      ],
    );
    const id = rows[0].id;

    let position = 0;
    for (const assetId of assetIds) {
      const format = isAgencyMediaFormat(input.formats?.[assetId]) ? input.formats?.[assetId] : null;
      await client.query(
        `INSERT INTO media_review_round_items
           (round_id, asset_id, business_id, format, position, added_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (round_id, asset_id) DO NOTHING`,
        [id, assetId, businessId, format, position, actor.userId],
      );
      position += 1;
    }

    await recordEvent(client, {
      businessId,
      roundId: id,
      actorUserId: actor.userId,
      actorKind: "member",
      actorLabel: label,
      action: "round.created",
      toState: "draft",
    });

    return id;
  });

  const detail = await getReviewRound(businessId, roundId);
  if (!detail) throw new MediaReviewError("round_not_found");
  return detail;
}

export interface UpdateReviewRoundInput {
  title?: unknown;
  note?: unknown;
  projectId?: unknown;
  clientPartyId?: unknown;
  campaignId?: unknown;
}

/**
 * Patch a draft round's title, note or scope.
 *
 * A true PATCH, and the distinction is one §D paid for in CI: a field that is
 * *absent* is left alone, while a field explicitly set to null is cleared. Only
 * `title` must stay non-empty, because the column is NOT NULL and an empty title
 * is not a refusal the database can phrase usefully.
 *
 * Scope is mutable only while the round is a draft. Migration 0265 refuses to move
 * a sent round's project, client or campaign, because those are what the client
 * was shown; the check here exists so that refusal arrives as a code a screen can
 * translate rather than as a constraint violation.
 */
export async function updateReviewRound(
  businessId: string,
  actor: ReviewActor,
  roundId: string,
  patch: UpdateReviewRoundInput,
): Promise<ReviewRoundDetail> {
  if (!isValidMediaUuid(roundId)) throw new MediaReviewError("round_not_found");

  await withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query<Row>(
      `SELECT id, state, title, note, project_id, client_party_id, campaign_id
         FROM media_review_rounds WHERE id = $1 AND business_id = $2 LIMIT 1 FOR UPDATE`,
      [roundId, businessId],
    );
    const current = rows[0];
    if (!current) throw new MediaReviewError("round_not_found");
    const status = isReviewRoundStatus(current.state) ? current.state : "draft";

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    let titleChanged = false;
    if (patch.title !== undefined) {
      const title = trimTo(patch.title, 200);
      if (!title) throw new MediaReviewError("missing_fields");
      if (title !== String(current.title)) {
        titleChanged = true;
        add("title", title);
      }
    }
    let noteChanged = false;
    if (patch.note !== undefined) {
      const note = nullableText(patch.note, MEDIA_REVIEW_NOTE_MAX_LENGTH);
      if (note !== nullableText(current.note, MEDIA_REVIEW_NOTE_MAX_LENGTH)) {
        noteChanged = true;
        add("note", note);
      }
    }

    let scopeChanged = false;
    const scopeColumns: Array<[keyof UpdateReviewRoundInput, string]> = [
      ["projectId", "project_id"],
      ["clientPartyId", "client_party_id"],
      ["campaignId", "campaign_id"],
    ];
    for (const [key, column] of scopeColumns) {
      if (patch[key] === undefined) continue;
      const next = uuidOrNull(patch[key]);
      if (next !== uuidOrNull(current[column])) {
        scopeChanged = true;
        add(column, next);
      }
    }
    // Mirror migration 0265's round guard here, so a screen is answered with a
    // code it can translate («این دور ارسال شده است») instead of a raw 23514.
    //
    // Two different freezes, and they are not the same set:
    //
    //   - title and scope are what the client was shown, so they lock from `sent`
    //     onward — but a round sent back for changes is still being assembled and
    //     stays editable, which the old `status !== "draft"` test wrongly refused;
    //   - the free-text note is the agency's own running commentary, editable
    //     until the round is settled, after which the whole row is history.
    //
    // Too lax here and the database raises an error the UI cannot render; too
    // strict and an agency cannot correct a typo on work a client just sent back.
    if ((titleChanged || scopeChanged) && isReviewRoundIdentityFrozen(status)) {
      throw new MediaReviewError("round_frozen");
    }
    if (noteChanged && MEDIA_REVIEW_SETTLED_STATUSES.includes(status)) {
      throw new MediaReviewError("round_frozen");
    }

    if (!sets.length) return roundId;

    params.push(roundId, businessId);
    await client.query(
      `UPDATE media_review_rounds
          SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $${params.length - 1} AND business_id = $${params.length}`,
      params,
    );
    await recordEvent(client, {
      businessId,
      roundId,
      actorUserId: actor.userId,
      actorKind: "member",
      actorLabel: await actorLabelFor(client, businessId, actor),
      action: "round.updated",
    });
    return roundId;
  });

  const detail = await getReviewRound(businessId, roundId);
  if (!detail) throw new MediaReviewError("round_not_found");
  return detail;
}

/**
 * Add assets to a round that is still open for them.
 *
 * "Open" is the pure module's `isReviewRoundOpenForItems` — draft, sent back for
 * changes, or rejected — which is the same list migration 0265's item trigger
 * enforces, so the service and the database cannot drift apart about it.
 */
export async function addReviewRoundItems(
  businessId: string,
  actor: ReviewActor,
  roundId: string,
  assetIds: readonly unknown[],
  formats: Record<string, unknown> = {},
): Promise<ReviewRoundDetail> {
  if (!isValidMediaUuid(roundId)) throw new MediaReviewError("round_not_found");
  const ids = [...new Set(assetIds.map((value) => String(value)).filter(isValidMediaUuid))];
  if (!ids.length) throw new MediaReviewError("missing_fields");

  await withTenantTransaction(businessId, async (client) => {
    const status = await lockRoundStatus(client, businessId, roundId);
    if (!isReviewRoundOpenForItems(status)) throw new MediaReviewError("round_not_open_for_items");

    const { rows: counted } = await client.query<{ n: string; high: string }>(
      `SELECT count(*)::text AS n, coalesce(max(position), -1)::text AS high
         FROM media_review_round_items WHERE round_id = $1 AND business_id = $2`,
      [roundId, businessId],
    );
    if (intOr(counted[0]?.n, 0) + ids.length > MAX_REVIEW_ROUND_ITEMS) {
      throw new MediaReviewError("too_many_items");
    }
    let position = intOr(counted[0]?.high, -1) + 1;

    const label = await actorLabelFor(client, businessId, actor);
    for (const assetId of ids) {
      const format = isAgencyMediaFormat(formats[assetId]) ? formats[assetId] : null;
      await client.query(
        `INSERT INTO media_review_round_items
           (round_id, asset_id, business_id, format, position, added_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (round_id, asset_id) DO NOTHING`,
        [roundId, assetId, businessId, format, position, actor.userId],
      );
      position += 1;
    }

    await client.query(`UPDATE media_review_rounds SET updated_at = now() WHERE id = $1 AND business_id = $2`,
      [roundId, businessId],
    );
    await recordEvent(client, {
      businessId,
      roundId,
      actorUserId: actor.userId,
      actorKind: "member",
      actorLabel: label,
      action: "round.items_added",
      note: `${ids.length} فایل`,
    });
    return roundId;
  });

  const detail = await getReviewRound(businessId, roundId);
  if (!detail) throw new MediaReviewError("round_not_found");
  return detail;
}

/** Take an asset back out of a round that is still open for items. */
export async function removeReviewRoundItem(
  businessId: string,
  actor: ReviewActor,
  roundId: string,
  assetId: string,
): Promise<ReviewRoundDetail> {
  if (!isValidMediaUuid(roundId)) throw new MediaReviewError("round_not_found");
  if (!isValidMediaUuid(assetId)) throw new MediaReviewError("item_not_found");

  await withTenantTransaction(businessId, async (client) => {
    const status = await lockRoundStatus(client, businessId, roundId);
    if (!isReviewRoundOpenForItems(status)) throw new MediaReviewError("round_not_open_for_items");

    const deleted = await client.query(
      `DELETE FROM media_review_round_items
        WHERE round_id = $1 AND asset_id = $2 AND business_id = $3`,
      [roundId, assetId, businessId],
    );
    if (!deleted.rowCount) throw new MediaReviewError("item_not_found");

    await client.query(`UPDATE media_review_rounds SET updated_at = now() WHERE id = $1 AND business_id = $2`,
      [roundId, businessId],
    );
    await recordEvent(client, {
      businessId,
      roundId,
      assetId,
      actorUserId: actor.userId,
      actorKind: "member",
      actorLabel: await actorLabelFor(client, businessId, actor),
      action: "round.item_removed",
    });
    return roundId;
  });

  const detail = await getReviewRound(businessId, roundId);
  if (!detail) throw new MediaReviewError("round_not_found");
  return detail;
}

/**
 * Set an item's agency-facing format, version label or order.
 *
 * Metadata only, and only while the round is open: relabelling a file underneath
 * a client who is reading the batch is the same failure as swapping the file.
 */
export async function updateReviewRoundItem(
  businessId: string,
  actor: ReviewActor,
  roundId: string,
  assetId: string,
  patch: { format?: unknown; versionLabel?: unknown; position?: unknown },
): Promise<ReviewRoundDetail> {
  if (!isValidMediaUuid(roundId)) throw new MediaReviewError("round_not_found");
  if (!isValidMediaUuid(assetId)) throw new MediaReviewError("item_not_found");

  let format: AgencyMediaFormat | null | undefined;
  if (patch.format !== undefined) {
    if (patch.format === null || patch.format === "") format = null;
    else if (isAgencyMediaFormat(patch.format)) format = patch.format;
    else throw new MediaReviewError("invalid_format");
  }

  await withTenantTransaction(businessId, async (client) => {
    const status = await lockRoundStatus(client, businessId, roundId);
    if (!isReviewRoundOpenForItems(status)) throw new MediaReviewError("round_not_open_for_items");

    const sets: string[] = [];
    const params: unknown[] = [];
    if (format !== undefined) {
      params.push(format);
      sets.push(`format = $${params.length}`);
    }
    if (patch.versionLabel !== undefined) {
      params.push(nullableText(patch.versionLabel, 80));
      sets.push(`version_label = $${params.length}`);
    }
    if (patch.position !== undefined) {
      const position = intOr(patch.position, -1);
      if (position < 0) throw new MediaReviewError("missing_fields");
      params.push(position);
      sets.push(`position = $${params.length}`);
    }
    if (!sets.length) return roundId;

    params.push(roundId, assetId, businessId);
    const updated = await client.query(
      `UPDATE media_review_round_items SET ${sets.join(", ")}
        WHERE round_id = $${params.length - 2} AND asset_id = $${params.length - 1}
          AND business_id = $${params.length}`,
      params,
    );
    if (!updated.rowCount) throw new MediaReviewError("item_not_found");

    await client.query(`UPDATE media_review_rounds SET updated_at = now() WHERE id = $1 AND business_id = $2`,
      [roundId, businessId],
    );
    await recordEvent(client, {
      businessId,
      roundId,
      assetId,
      actorUserId: actor.userId,
      actorKind: "member",
      actorLabel: await actorLabelFor(client, businessId, actor),
      action: "round.item_updated",
    });
    return roundId;
  });

  const detail = await getReviewRound(businessId, roundId);
  if (!detail) throw new MediaReviewError("round_not_found");
  return detail;
}

/**
 * Lock a round row and return its status, or refuse if it is not there.
 *
 * `FOR UPDATE` is what makes the state machine safe under two members clicking at
 * once: without it, two concurrent sends both read `draft`, both pass
 * `canTransitionReviewRound`, and the second overwrites the first's stamps.
 */
async function lockRoundStatus(
  client: PoolClient,
  businessId: string,
  roundId: string,
): Promise<MediaReviewRoundStatus> {
  const { rows } = await client.query<Row>(
    `SELECT state FROM media_review_rounds WHERE id = $1 AND business_id = $2 LIMIT 1 FOR UPDATE`,
    [roundId, businessId],
  );
  const row = rows[0];
  if (!row) throw new MediaReviewError("round_not_found");
  return isReviewRoundStatus(row.state) ? row.state : "draft";
}

/**
 * Move a round to a new state — the agency's half of the machine.
 *
 * `send` and `withdraw` only; the three decisions belong to the client and go
 * through `decideReviewRound`. One function rather than an endpoint per move means
 * the transition table in `media-review.ts` is the only place that says what may
 * follow what, so a route cannot offer a move the state machine would refuse.
 *
 * `sent_at` is stamped once and kept: a round sent, returned for changes and
 * re-sent does not lose the date it first went to the client, because that date is
 * a fact about the engagement and not about the latest attempt. The events table
 * carries each sending separately.
 *
 * Withdrawing revokes every live link in the same transaction. That is not
 * tidiness: a withdrawn round whose link still worked would be a round the agency
 * believes it has taken back and has not.
 */
export async function transitionReviewRound(
  businessId: string,
  actor: ReviewActor,
  roundId: string,
  action: unknown,
): Promise<ReviewRoundDetail> {
  if (!isValidMediaUuid(roundId)) throw new MediaReviewError("round_not_found");
  if (!isReviewRoundAction(action) || (action !== "send" && action !== "withdraw")) {
    throw new MediaReviewError("invalid_action");
  }

  await withTenantTransaction(businessId, async (client) => {
    const from = await lockRoundStatus(client, businessId, roundId);
    // Resolved to its target before the check, because the transition table is
    // keyed by status rather than by act. One table then says what may follow
    // what, and an act cannot be added without the table already permitting its
    // move — which is the whole reason the table exists.
    const to = reviewRoundActionTarget(action);
    if (!canTransitionReviewRound(from, to)) throw new MediaReviewError("invalid_transition");

    if (action === "send") {
      const { rows: counted } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM media_review_round_items
          WHERE round_id = $1 AND business_id = $2`,
        [roundId, businessId],
      );
      // Refused here rather than left for the client to discover: a link that
      // opens onto an empty batch reads as a broken link, and the agency would
      // then chase the wrong problem.
      if (intOr(counted[0]?.n, 0) === 0) throw new MediaReviewError("missing_fields");
    }

    await client.query(
      `UPDATE media_review_rounds
          SET state = $1,
              sent_at = CASE WHEN $2::boolean THEN coalesce(sent_at, now()) ELSE sent_at END,
              updated_at = now()
        WHERE id = $3 AND business_id = $4`,
      [to, action === "send", roundId, businessId],
    );

    if (action === "withdraw") {
      await client.query(
        `UPDATE media_review_links SET revoked_at = now()
          WHERE round_id = $1 AND business_id = $2 AND revoked_at IS NULL`,
        [roundId, businessId],
      );
    }

    await recordEvent(client, {
      businessId,
      roundId,
      actorUserId: actor.userId,
      actorKind: "member",
      actorLabel: await actorLabelFor(client, businessId, actor),
      action: `round.${action}`,
      fromState: from,
      toState: to,
    });
    return roundId;
  });

  const detail = await getReviewRound(businessId, roundId);
  if (!detail) throw new MediaReviewError("round_not_found");
  return detail;
}

/**
 * Delete a draft round.
 *
 * The round's own events cascade away with it, which is the single deletion the
 * append-only trigger permits — a draft nobody outside the agency ever saw holds
 * no client-facing fact, and an agency must be able to clean up a round it created
 * by mistake. Because that trail goes too, the deletion is recorded in the
 * platform-wide `audit_log` instead, which is business-scoped and survives. So the
 * act is not unrecorded; it is recorded somewhere that outlives its subject.
 */
export async function deleteReviewRound(
  businessId: string,
  actor: ReviewActor,
  roundId: string,
): Promise<void> {
  if (!isValidMediaUuid(roundId)) throw new MediaReviewError("round_not_found");

  await withTenantTransaction(businessId, async (client) => {
    const status = await lockRoundStatus(client, businessId, roundId);
    // Named here so the refusal is a code a screen can translate; migration 0265
    // refuses it too, and that is the guarantee which actually holds.
    if (status !== "draft") throw new MediaReviewError("round_frozen");

    const { rows } = await client.query<Row>(
      `SELECT title, project_id, client_party_id FROM media_review_rounds
        WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [roundId, businessId],
    );
    await client.query(
      `DELETE FROM media_review_rounds WHERE id = $1 AND business_id = $2`,
      [roundId, businessId],
    );
    await client.query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, NULL, $2, 'media.review_round.delete', 'media_review_round', $3, $4::jsonb)`,
      [
        businessId,
        actor.userId,
        roundId,
        JSON.stringify({
          title: String(rows[0]?.title ?? ""),
          projectId: uuidOrNull(rows[0]?.project_id),
          clientPartyId: uuidOrNull(rows[0]?.client_party_id),
          deletedBy: actor.fullName.trim() || null,
        }),
      ],
    );
    return roundId;
  });
}

/* ===========================================================================
 * Links
 * ======================================================================== */

export interface CreateReviewLinkInput {
  purpose?: unknown;
  ttlDays?: unknown;
}

/**
 * Mint a scoped link and return its plaintext exactly once.
 *
 * The plaintext never touches storage: the hash is written and the token is handed
 * to the caller to show and forget. Migration 0265 pins `token_hash` to 64
 * lower-case hex, so a plaintext value could not be persisted even by a bug here.
 *
 * Only a sent round gets a link. Minting against a draft would produce a
 * credential that works before the agency has decided to send anything, which is
 * the exact inversion of the guarantee §E asks for.
 */
export async function createReviewLink(
  businessId: string,
  actor: ReviewActor,
  roundId: string,
  input: CreateReviewLinkInput = {},
): Promise<{ link: ReviewRoundLink; token: string }> {
  if (!isValidMediaUuid(roundId)) throw new MediaReviewError("round_not_found");
  if (input.purpose !== undefined && !isReviewLinkPurpose(input.purpose)) {
    throw new MediaReviewError("invalid_purpose");
  }
  const purpose: MediaReviewLinkPurpose = isReviewLinkPurpose(input.purpose) ? input.purpose : "review";
  const ttlDays = clampReviewLinkTtlDays(input.ttlDays);

  return withTenantTransaction(businessId, async (client) => {
    const status = await lockRoundStatus(client, businessId, roundId);
    if (status !== "sent") throw new MediaReviewError("round_not_sent");

    const { token, tokenHash, tokenPrefix } = createMediaReviewToken();
    let inserted;
    try {
      inserted = await client.query<Row>(
        `INSERT INTO media_review_links
           (business_id, round_id, token_hash, token_prefix, purpose, ttl_days, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          businessId,
          roundId,
          tokenHash,
          tokenPrefix,
          purpose,
          ttlDays,
          reviewLinkExpiresAt(new Date(), ttlDays),
          actor.userId,
        ],
      );
    } catch (err) {
      // One live link per round per purpose, held by a partial unique index.
      // Translated here so a screen can say "revoke the current link first"
      // instead of reporting a database failure.
      const message = err instanceof Error ? err.message : "";
      if (message.includes("idx_media_review_links_live") || message.includes("duplicate key")) {
        throw new MediaReviewError("link_exists");
      }
      throw err;
    }

    const linkId = String(inserted.rows[0].id);
    await recordEvent(client, {
      businessId,
      roundId,
      linkId,
      actorUserId: actor.userId,
      actorKind: "member",
      actorLabel: await actorLabelFor(client, businessId, actor),
      action: "link.created",
      note: `${purpose} · ${ttlDays} روز`,
    });

    return { link: rowToLink(inserted.rows[0]), token };
  });
}

/**
 * Revoke a link. Immediate, and the row stays for the trail.
 *
 * Revocation is the reason §E streams bytes through the application instead of
 * presigning them: a presigned URL keeps working until it expires no matter what
 * anybody decides, so with one "revoke" would mean "wait".
 */
export async function revokeReviewLink(
  businessId: string,
  actor: ReviewActor,
  linkId: string,
): Promise<ReviewRoundLink> {
  if (!isValidMediaUuid(linkId)) throw new MediaReviewError("link_not_found");

  return withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query<Row>(
      `SELECT * FROM media_review_links WHERE id = $1 AND business_id = $2 LIMIT 1 FOR UPDATE`,
      [linkId, businessId],
    );
    const current = rows[0];
    if (!current) throw new MediaReviewError("link_not_found");
    // Idempotent: revoking twice is one revocation, not an error. A screen that
    // double-submits must not be told it failed.
    if (current.revoked_at) return rowToLink(current);

    const { rows: updated } = await client.query<Row>(
      `UPDATE media_review_links SET revoked_at = now()
        WHERE id = $1 AND business_id = $2 RETURNING *`,
      [linkId, businessId],
    );
    const roundId = String(current.round_id);
    await recordEvent(client, {
      businessId,
      roundId,
      linkId,
      actorUserId: actor.userId,
      actorKind: "member",
      actorLabel: await actorLabelFor(client, businessId, actor),
      action: "link.revoked",
    });
    await client.query(`UPDATE media_review_rounds SET updated_at = now() WHERE id = $1 AND business_id = $2`,
      [roundId, businessId],
    );
    return rowToLink(updated[0]);
  });
}

/* ===========================================================================
 * Client side — no member session; the token is the whole authority
 * ======================================================================== */

/**
 * Load the client's view from an already-resolved grant.
 *
 * Split out from `getClientReviewView` so a decision can refresh the screen it
 * returns without resolving the token a second time. Re-resolving is not merely
 * wasteful: it would count another link use and, worse, tempt a caller into
 * writing a second audit row for one client action.
 */
async function loadClientView(grant: ResolvedReviewToken, token: string): Promise<ClientReviewView> {
  const { businessId, roundId } = grant;
  return withTenant(businessId, async () => {
    const { rows } = await query<Row>(
      `${ROUND_SELECT} WHERE r.id = $1 AND r.business_id = $2 LIMIT 1`,
      [roundId, businessId],
    );
    const row = rows[0];
    if (!row) throw new MediaReviewError("round_not_found");

    const items = await query<Row>(
      `${ITEM_SELECT} WHERE i.round_id = $1 AND i.business_id = $2 ORDER BY i.position, i.added_at`,
      [roundId, businessId],
    );

    const round = rowToRound(row);
    return {
      round,
      items: items.rows.map((item) => rowToItem(item, (assetId) => clientFileUrl(token, assetId))),
      clientName: round.decidedByName ?? round.clientName,
      actions: round.clientActions,
    };
  });
}

/**
 * What a client sees when they open a link.
 *
 * Note what is absent: no links, no events, no `storage_key`, no other rounds. The
 * item URLs point at the token route rather than the library's own file route,
 * because that route authorizes from a member session the client does not have and
 * would answer 403 — which is the gap §E exists to close, and the reason a client
 * cannot simply be handed a media library URL.
 */
export async function getClientReviewView(raw: unknown): Promise<ClientReviewView> {
  const resolved = await resolveReviewToken(raw);
  if (!resolved.ok) throw new MediaReviewError(resolved.code);
  const view = await loadClientView(resolved.grant, String(raw).trim());
  await touchLinkUse(resolved.grant.businessId, resolved.grant.linkId);
  return view;
}

/**
 * A client's decision on one asset.
 *
 * Only a `sent` round may be decided, and migration 0265 enforces the same rule,
 * so an agency cannot approve its own work against a draft and have the row read
 * like a client approval. A decision is also final: revising it is what the trail
 * exists to prevent, so a client who changes their mind gets a new round.
 */
export async function decideReviewItem(
  raw: unknown,
  assetId: unknown,
  status: unknown,
  note?: unknown,
): Promise<ClientReviewView> {
  const resolved = await resolveReviewToken(raw);
  if (!resolved.ok) throw new MediaReviewError(resolved.code);
  const { businessId, roundId, linkId } = resolved.grant;

  if (!isValidMediaUuid(String(assetId))) throw new MediaReviewError("item_not_found");
  if (!isReviewItemStatus(status)) throw new MediaReviewError("invalid_status");
  // `pending` is what an item is born into, not a decision. Allowing it would let
  // a client un-decide a file and leave the round looking undecided again.
  if (status === "pending") throw new MediaReviewError("invalid_status");

  const text = trimReviewNote(note);
  // A refusal with nothing written is not actionable: the agency would have to ask
  // what to change, which is a second round the client did not need to open.
  if ((status === "changes_requested" || status === "rejected") && !text) {
    throw new MediaReviewError("note_required");
  }

  await withTenantTransaction(businessId, async (client) => {
    const roundStatus = await lockRoundStatus(client, businessId, roundId);
    if (!MEDIA_REVIEW_DECIDABLE_STATUSES.includes(roundStatus)) {
      throw new MediaReviewError("round_not_sent");
    }

    const updated = await client.query(
      `UPDATE media_review_round_items
          SET state = $1, note = $2, decided_at = now()
        WHERE round_id = $3 AND asset_id = $4 AND business_id = $5 AND state = 'pending'`,
      [status, text || null, roundId, String(assetId), businessId],
    );
    // Zero rows means either the asset is not in this round or it was already
    // decided. Neither may be accepted silently: a decision that did not land is a
    // decision the agency will never receive.
    if (!updated.rowCount) throw new MediaReviewError("item_not_found");

    await client.query(`UPDATE media_review_rounds SET updated_at = now() WHERE id = $1 AND business_id = $2`,
      [roundId, businessId],
    );
    await recordEvent(client, {
      businessId,
      roundId,
      assetId: String(assetId),
      linkId,
      actorKind: "client",
      actorLabel: CLIENT_ACTOR_FALLBACK,
      action: `item.${status}`,
      toState: status,
      note: text || null,
    });
    return null;
  });

  return loadClientView(resolved.grant, String(raw).trim());
}

export interface ClientDecisionInput {
  action: unknown;
  clientName?: unknown;
  note?: unknown;
}

/**
 * The client's decision on the whole round: approve, request changes, or reject.
 *
 * Two rules carry the weight here.
 *
 * The round must be fully decided first. An approval over undecided assets is not
 * a partial approval an agency can interpret; it is a guess, and the agency would
 * then deliver or invoice against a client who never looked at half the batch.
 * `items_pending` names the real problem.
 *
 * Approving additionally requires every item to be approved. A round containing a
 * rejected file cannot be "approved" — that is the contradiction an agency would
 * otherwise discover when the client refuses a delivery they were told was signed
 * off. Requesting changes and rejecting carry no such constraint, because a client
 * is always allowed to be unhappy.
 *
 * Approving is terminal by design: a client who changes their mind does not
 * un-approve, the agency sends a new round, so both facts survive. That is also
 * §E's version history — successive rounds over one asset are its versions.
 */
export async function decideReviewRound(
  raw: unknown,
  input: ClientDecisionInput,
): Promise<ClientReviewView> {
  const resolved = await resolveReviewToken(raw);
  if (!resolved.ok) throw new MediaReviewError(resolved.code);
  const { businessId, roundId, linkId } = resolved.grant;

  if (!isReviewRoundAction(input.action)) throw new MediaReviewError("invalid_action");
  const action = input.action;
  // `send` and `withdraw` are the agency's alone. A token holder who could
  // withdraw a round could close their own review, and one who could send could
  // reopen a settled one.
  if (action === "send" || action === "withdraw") throw new MediaReviewError("invalid_action");

  const note = trimReviewNote(input.note);
  if (reviewDecisionNoteRequired(action) && !note) throw new MediaReviewError("note_required");
  const clientName = nullableText(input.clientName, 200);

  await withTenantTransaction(businessId, async (client) => {
    const from = await lockRoundStatus(client, businessId, roundId);
    if (!MEDIA_REVIEW_DECIDABLE_STATUSES.includes(from)) throw new MediaReviewError("round_not_sent");

    const { rows: items } = await client.query<{ state: string }>(
      `SELECT state FROM media_review_round_items WHERE round_id = $1 AND business_id = $2`,
      [roundId, businessId],
    );
    const statuses = items.map((item) => (isReviewItemStatus(item.state) ? item.state : "pending"));
    if (!statuses.length || statuses.some((value) => value === "pending")) {
      throw new MediaReviewError("items_pending");
    }

    const to = reviewRoundActionTarget(action);
    if (!canTransitionReviewRound(from, to)) throw new MediaReviewError("invalid_transition");
    if (to === "approved" && !statuses.every((value) => value === "approved")) {
      throw new MediaReviewError("items_not_approved");
    }

    await client.query(
      `UPDATE media_review_rounds
          SET state = $1, decided_at = now(), decided_by_name = $2, decision_note = $3,
              updated_at = now()
        WHERE id = $4 AND business_id = $5`,
      [to, clientName ?? CLIENT_ACTOR_FALLBACK, note || null, roundId, businessId],
    );
    await recordEvent(client, {
      businessId,
      roundId,
      linkId,
      actorKind: "client",
      actorLabel: clientName ?? CLIENT_ACTOR_FALLBACK,
      action: `round.${action}`,
      fromState: from,
      toState: to,
      note: note || null,
    });
    return null;
  });

  return loadClientView(resolved.grant, String(raw).trim());
}

/**
 * Authorise a client's request for one asset's bytes, and return its metadata.
 *
 * Split from the streaming call below so a route can do what the library's own
 * file route does: authorise, then answer an ETag revalidation or an unsatisfiable
 * range *before* opening an upstream stream. Checking afterwards would mean paying
 * for a storage read in order to answer a 304, and a video player asks for ranges
 * constantly.
 *
 * Three gates, in the order that leaks least:
 *
 *   1. The token resolves. Its purpose then decides whether an explicit request
 *      to *take the file* is honoured: a `review` link may be looked at, and only
 *      a `download` link may be asked for the file itself. See the note at the
 *      gate below for what that distinction honestly buys — it records intent, it
 *      is not a barrier a browser cannot step over.
 *   2. The asset is in *this* round. The token grants a round, not the library, so
 *      a client who guesses another asset's UUID gets nothing. This is the check
 *      that makes the link scoped rather than merely authenticated.
 *   3. The asset exists and is not in the bin, read by the same helper the
 *      tenant's own library uses.
 *
 * The `storage_key` this resolves is deliberately not returned. The caller gets
 * metadata and a grant, and asks `streamReviewAssetBytes` for the bytes: a key
 * that leaves the service is a key that can end up in a log, a payload, or a
 * presigned URL somebody forwards.
 */
export type ReviewAssetAuthorization =
  | {
      ok: true;
      grant: ResolvedReviewToken;
      asset: {
        id: string;
        fileName: string;
        mimeType: string;
        kind: string;
        byteSize: number;
        sha256: string;
      };
    }
  | { ok: false; code: MediaReviewErrorCode };

export async function authorizeReviewAsset(
  raw: unknown,
  assetId: unknown,
  options: { wantsDownload?: boolean } = {},
): Promise<ReviewAssetAuthorization> {
  const resolved = await resolveReviewToken(raw);
  if (!resolved.ok) return { ok: false, code: resolved.code };
  const { businessId, roundId, purpose } = resolved.grant;

  // Purpose governs disposition and intent, NOT whether bytes may be served at
  // all. Refusing a `review` link every fetch would make the default link
  // useless: `review` is what a link is minted as unless an agency asks for
  // `download`, and a client who cannot see the artwork cannot approve it.
  //
  // What the distinction honestly buys is narrower than it sounds, so it is worth
  // being plain: bytes served for viewing can always be saved by the browser, and
  // no response header prevents a determined client from keeping the file. The
  // purpose records the agency's *intent* — a `review` link was shared to look
  // at, a `download` link to hand over — so the audit trail can say which
  // happened. Keeping print-ready originals away from an unpaid client is a
  // watermarking problem, not a disposition problem, and is out of scope here.
  if (options.wantsDownload && !reviewLinkPurposeAllowsDownload(purpose)) {
    return { ok: false, code: "download_not_permitted" };
  }
  const id = String(assetId);
  if (!isValidMediaUuid(id)) return { ok: false, code: "asset_not_found" };

  return withTenant(businessId, async () => {
    // Gate 2, before any storage call: membership in this round is what the token
    // actually grants.
    const { rows } = await query<Row>(
      `SELECT 1 AS present FROM media_review_round_items
        WHERE round_id = $1 AND asset_id = $2 AND business_id = $3 LIMIT 1`,
      [roundId, id, businessId],
    );
    if (!rows[0]) return { ok: false as const, code: "asset_not_found" as const };

    const found = await getActiveMediaAssetWithStorageKey(businessId, id);
    if (!found) return { ok: false as const, code: "asset_not_found" as const };

    return {
      ok: true as const,
      grant: resolved.grant,
      asset: {
        id,
        fileName: found.asset.fileName,
        mimeType: found.asset.mimeType,
        kind: found.asset.kind,
        byteSize: found.asset.byteSize,
        sha256: found.sha256,
      },
    };
  });
}

/**
 * Stream the bytes of an already-authorised asset.
 *
 * Takes the grant rather than the token: the caller has already paid for one
 * resolution and one membership check, and repeating them here would add a round
 * trip to every range request a video player makes while scrubbing.
 *
 * Delegates to `streamMediaObject`, whose first act is to refuse a storage key
 * that does not belong to the business it was asked for. That is the backstop
 * behind the gates above, and the reason a bug in them cannot become a
 * cross-tenant read.
 */
export async function streamReviewAssetBytes(
  grant: ResolvedReviewToken,
  assetId: string,
  options: { range?: { start: number; end: number }; signal?: AbortSignal } = {},
): Promise<{ stream: ReadableStream<Uint8Array>; contentLength: number; status: number } | null> {
  const { businessId, roundId, linkId, purpose } = grant;
  return withTenant(businessId, async () => {
    const found = await getActiveMediaAssetWithStorageKey(businessId, assetId);
    if (!found) return null;
    const config = await getMediaConfig();
    const streamed = await streamMediaObject(businessId, found.storageKey, config, options);
    if (!streamed) return null;

    // A download is worth an audit row, unlike a page view: it is the moment bytes
    // left the building, and §E asks who fetched what. Fired rather than awaited,
    // because the client is already waiting on a segment and the trail must not
    // add latency to it; the helper swallows its own failures.
    //
    // Only a *whole-file* fetch gets a row. A video scrubbed in forty range
    // requests is one download, not forty, and writing a row per segment would
    // bury the decisions the trail exists to preserve — the same reasoning that
    // keeps page views out of it. The counter still moves on every request, so
    // "was this link used" stays answerable either way.
    void noteReviewAssetAccess(businessId, roundId, linkId, assetId, purpose, options.range !== undefined);

    return {
      stream: streamed.stream,
      contentLength: streamed.contentLength ?? found.asset.byteSize,
      status: streamed.status,
    };
  });
}

/**
 * Record that a client fetched bytes. Best-effort; see the caller.
 *
 * The action names the link's purpose rather than the request's disposition, so
 * the trail can answer "did they only look, or did they take the file?" — which
 * is the one question the purpose distinction exists to answer.
 */
async function noteReviewAssetAccess(
  businessId: string,
  roundId: string,
  linkId: string,
  assetId: string,
  purpose: MediaReviewLinkPurpose,
  partial: boolean,
): Promise<void> {
  try {
    await withTenantTransaction(businessId, async (client) => {
      await client.query(
        `UPDATE media_review_links SET last_used_at = now(), use_count = use_count + 1
          WHERE id = $1 AND business_id = $2`,
        [linkId, businessId],
      );
      if (!partial) {
        await recordEvent(client, {
          businessId,
          roundId,
          assetId,
          linkId,
          actorKind: "client",
          actorLabel: CLIENT_ACTOR_FALLBACK,
          action: purpose === "download" ? "asset.downloaded" : "asset.viewed",
        });
      }
      return null;
    });
  } catch {
    // Losing a counter must not turn a successful download into a 500.
  }
}

/* ===========================================================================
 * Lookups a screen needs
 * ======================================================================== */

/** The format vocabulary as value/label pairs, so a select and the CHECK agree. */
export function reviewFormatOptions(): Array<{ value: AgencyMediaFormat; label: string }> {
  return AGENCY_MEDIA_FORMATS.map((value) => ({ value, label: AGENCY_MEDIA_FORMAT_LABELS[value] }));
}
