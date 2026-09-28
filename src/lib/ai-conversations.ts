/**
 * AI Hub Wave 1 (Issue #141) — durable, listable AI assistant conversations.
 *
 * This sits beside the existing metered turn in `/api/ai/chat`, not inside
 * it: every turn still resolves its provider/model/pricing from the single
 * platform-owned `platform_ai_config` (Phase 18, see ai-config.ts) and still
 * reserves/settles credits exactly as before. These functions only persist
 * the transcript that flow already produces (prompt, reply, proposal) so it
 * can be listed and resumed later — they never call the provider and never
 * touch billing.
 *
 * Per the Wave 1 access decision, a conversation is visible only to the
 * member who started it, not the whole business: every function here takes
 * an `actorUserId` and filters by it in addition to the RLS-enforced
 * `businessId`, so ownership holds even though RLS itself only draws the
 * business boundary.
 */
import { query } from "./db";
import type { AgentMode, ProposedAction } from "./ai";

const TITLE_MAX_LENGTH = 60;
const DEFAULT_TITLE = "مکالمه جدید";

/** Pure: turns a first user message into a short, single-line conversation title. */
export function deriveConversationTitle(firstMessageContent: string): string {
  const collapsed = firstMessageContent.replace(/\s+/g, " ").trim();
  if (!collapsed) return DEFAULT_TITLE;
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX_LENGTH).trimEnd()}…`;
}

export interface AiConversationSummary {
  id: string;
  mode: AgentMode;
  title: string;
  lastMessageAt: string;
  createdAt: string;
  /** Phase 35 Wave 3 — the project this conversation belongs to, if any. */
  projectId: string | null;
}

export interface AiConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: unknown;
  proposal: ProposedAction | null;
  createdAt: string;
  /** Phase E — the input request attached to this turn, when there was one. */
  inputRequest?: { id: string; spec: unknown; status: string | null } | null;
  /** Durable proposal/audit link. The UI must render terminal status from here. */
  auditId?: string | null;
  proposalStatus?: "proposed" | "processing" | "applied" | "failed" | "dismissed" | "reverted" | null;
}

interface Owner {
  businessId: string;
  actorUserId: string;
}

/**
 * Resolves the conversation a turn belongs to: the given id if it exists and
 * is owned by this actor, otherwise a freshly created one. Never throws on an
 * unknown/foreign id — a stale or tampered client-supplied id just starts a
 * new conversation instead of failing the (already-reserved, already
 * mid-flight) turn.
 *
 * Phase 35 Wave 3: `projectId` links the new conversation to a project.
 * When resuming an existing conversation, the project link is not checked —
 * the conversation already carries it.
 */
export async function getOrCreateConversation(
  owner: Owner & { mode: AgentMode; conversationId: string | null; firstMessageContent: string; projectId?: string | null },
): Promise<{ id: string; isNew: boolean }> {
  if (owner.conversationId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM ai_conversations
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3 AND mode = $4`,
      [owner.conversationId, owner.businessId, owner.actorUserId, owner.mode],
    );
    if (rows[0]) return { id: rows[0].id, isNew: false };
  }

  const projectId = owner.projectId ?? null;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO ai_conversations (business_id, actor_user_id, mode, title, project_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [owner.businessId, owner.actorUserId, owner.mode, deriveConversationTitle(owner.firstMessageContent), projectId],
  );
  return { id: rows[0].id, isNew: true };
}

export async function appendMessage(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: unknown;
  proposal?: ProposedAction | null;
  auditId?: string | null;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO ai_messages (conversation_id, role, content, tool_calls, proposal, proposal_audit_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     RETURNING id`,
    [
      input.conversationId,
      input.role,
      input.content,
      input.toolCalls === undefined ? null : JSON.stringify(input.toolCalls),
      input.proposal ? JSON.stringify(input.proposal) : null,
      input.auditId ?? null,
    ],
  );
  await query(`UPDATE ai_conversations SET last_message_at = now() WHERE id = $1`, [input.conversationId]);
  return rows[0].id;
}

export async function listConversations(
  owner: Owner,
  options: { limit?: number; before?: string | null; mode?: AgentMode } = {},
): Promise<AiConversationSummary[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)));
  const { rows } = await query<{
    id: string;
    mode: AgentMode;
    title: string;
    last_message_at: string;
    created_at: string;
    project_id: string | null;
  }>(
    `SELECT id, mode, title, last_message_at, created_at, project_id
       FROM ai_conversations
      WHERE business_id = $1 AND actor_user_id = $2
        AND ($3::text IS NULL OR mode = $3::text)
        AND ($4::timestamptz IS NULL OR last_message_at < $4::timestamptz)
      ORDER BY last_message_at DESC
      LIMIT $5`,
    [owner.businessId, owner.actorUserId, options.mode ?? null, options.before ?? null, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    mode: row.mode,
    title: row.title,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    projectId: row.project_id,
  }));
}

/**
 * True when this actor owns this conversation within this business. The cheap
 * ownership check the input-protocol routes reuse before touching a request that
 * belongs to a conversation, since a request reaches tenant scope only through
 * its parent conversation (migration 0157).
 */
export async function ownsConversation(
  owner: Owner & { conversationId: string },
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM ai_conversations
      WHERE id = $1 AND business_id = $2 AND actor_user_id = $3`,
    [owner.conversationId, owner.businessId, owner.actorUserId],
  );
  return rows.length > 0;
}

export async function getConversationMessages(
  owner: Owner & { conversationId: string },
): Promise<{ conversation: AiConversationSummary; messages: AiConversationMessage[] } | null> {
  const { rows: conversationRows } = await query<{
    id: string;
    mode: AgentMode;
    title: string;
    last_message_at: string;
    created_at: string;
    project_id: string | null;
  }>(
    `SELECT id, mode, title, last_message_at, created_at, project_id
       FROM ai_conversations
      WHERE id = $1 AND business_id = $2 AND actor_user_id = $3`,
    [owner.conversationId, owner.businessId, owner.actorUserId],
  );
  const conversation = conversationRows[0];
  if (!conversation) return null;

  const { rows: messageRows } = await query<{
    id: string;
    role: "user" | "assistant";
    content: string;
    tool_calls: unknown;
    proposal: ProposedAction | null;
    proposal_audit_id: string | null;
    proposal_status: "proposed" | "processing" | "applied" | "failed" | "dismissed" | "reverted" | null;
    created_at: string;
    input_request_id: string | null;
    input_request_spec: unknown;
    input_request_status: string | null;
  }>(
    // Phase E — left-join the input request attached to each assistant turn, so
    // a reloaded transcript can re-render a still-open card (and lock an
    // already-answered one). At most one request per message by construction.
    `SELECT m.id, m.role, m.content, m.tool_calls, m.proposal,
            m.proposal_audit_id, a.status AS proposal_status, m.created_at,
            r.id AS input_request_id, r.spec AS input_request_spec, r.status AS input_request_status
       FROM ai_messages m
       LEFT JOIN ai_action_audit a ON a.id = m.proposal_audit_id
       LEFT JOIN ai_input_requests r ON r.message_id = m.id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC`,
    [owner.conversationId],
  );

  return {
    conversation: {
      id: conversation.id,
      mode: conversation.mode,
      title: conversation.title,
      lastMessageAt: conversation.last_message_at,
      createdAt: conversation.created_at,
      projectId: conversation.project_id,
    },
    messages: messageRows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      toolCalls: row.tool_calls,
      proposal: row.proposal,
      createdAt: row.created_at,
      auditId: row.proposal_audit_id,
      proposalStatus: row.proposal_status,
      inputRequest: row.input_request_id
        ? {
            id: row.input_request_id,
            spec: row.input_request_spec,
            status: row.input_request_status,
          }
        : null,
    })),
  };
}

export interface AiConversationSearchResult {
  id: string;
  title: string;
  lastMessageAt: string;
}

/**
 * AI Hub Wave 5 (issue #145) — the composer's restricted search ("previous
 * conversations", replacing a general web-browsing icon per Phase 18b's own
 * out-of-scope decision). Matches on title or any message's content, scoped
 * by the same ownership boundary as every other function here — a
 * conversation only ever surfaces to the member who started it.
 */
export async function searchConversations(
  owner: Owner,
  queryText: string,
  limit = 8,
  options: { mode?: AgentMode } = {},
): Promise<AiConversationSearchResult[]> {
  const trimmed = queryText.trim();
  if (!trimmed) return [];
  const needle = `%${trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  const { rows } = await query<{ id: string; title: string; last_message_at: string }>(
    `SELECT c.id, c.title, c.last_message_at
       FROM ai_conversations c
      WHERE c.business_id = $1 AND c.actor_user_id = $2
        AND ($5::text IS NULL OR c.mode = $5::text)
        AND (
          c.title ILIKE $3 ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM ai_messages m WHERE m.conversation_id = c.id AND m.content ILIKE $3 ESCAPE '\\')
        )
      ORDER BY c.last_message_at DESC
      LIMIT $4`,
    [
      owner.businessId,
      owner.actorUserId,
      needle,
      Math.max(1, Math.min(50, Math.floor(limit))),
      options.mode ?? null,
    ],
  );
  return rows.map((row) => ({ id: row.id, title: row.title, lastMessageAt: row.last_message_at }));
}

export async function deleteConversation(owner: Owner & { conversationId: string }): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM ai_conversations WHERE id = $1 AND business_id = $2 AND actor_user_id = $3`,
    [owner.conversationId, owner.businessId, owner.actorUserId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Rename a conversation (the history sidebar's «تغییر نام»). The title is
 * normalised with the same rules `deriveConversationTitle` applies to a
 * generated one: one line, trimmed, capped. Returns false when the id is
 * unknown, foreign, or the title is empty after trimming — the caller answers
 * with a 404/400 rather than a silent no-op.
 */
export async function renameConversation(
  owner: Owner & { conversationId: string; title: string },
): Promise<AiConversationSummary | null> {
  const title = owner.title.replace(/\s+/g, " ").trim();
  if (!title) return null;
  const { rows } = await query<{
    id: string;
    mode: AgentMode;
    title: string;
    last_message_at: string;
    created_at: string;
    project_id: string | null;
  }>(
    `UPDATE ai_conversations
        SET title = $4
      WHERE id = $1 AND business_id = $2 AND actor_user_id = $3
      RETURNING id, mode, title, last_message_at, created_at, project_id`,
    [owner.conversationId, owner.businessId, owner.actorUserId, title.slice(0, TITLE_MAX_LENGTH)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    title: row.title,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    projectId: row.project_id,
  };
}

/**
 * Phase 35 Wave 3 — list conversations belonging to a specific project.
 * Same ownership rules as listConversations.
 */
export async function listConversationsByProject(
  owner: Owner & { projectId: string },
  options: { limit?: number; before?: string | null; mode?: AgentMode } = {},
): Promise<AiConversationSummary[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)));
  const { rows } = await query<{
    id: string;
    mode: AgentMode;
    title: string;
    last_message_at: string;
    created_at: string;
    project_id: string | null;
  }>(
    `SELECT id, mode, title, last_message_at, created_at, project_id
       FROM ai_conversations
      WHERE business_id = $1 AND actor_user_id = $2 AND project_id = $3
        AND ($4::text IS NULL OR mode = $4::text)
        AND ($5::timestamptz IS NULL OR last_message_at < $5::timestamptz)
      ORDER BY last_message_at DESC
      LIMIT $6`,
    [owner.businessId, owner.actorUserId, owner.projectId, options.mode ?? null, options.before ?? null, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    mode: row.mode,
    title: row.title,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    projectId: row.project_id,
  }));
}

/**
 * Phase 35 Wave 3 — resolve the project_id for a conversation, for prompt
 * injection. Returns null if the conversation has no project.
 */
export async function getConversationProjectId(
  businessId: string,
  conversationId: string,
): Promise<string | null> {
  const { rows } = await query<{ project_id: string | null }>(
    `SELECT project_id FROM ai_conversations
      WHERE id = $1 AND business_id = $2`,
    [conversationId, businessId],
  );
  return rows[0]?.project_id ?? null;
}
