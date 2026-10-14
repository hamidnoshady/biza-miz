/**
 * Issue #812 §9 — system agents: built and versioned only by Superadmin.
 *
 * There is no tenant Agent Builder. A tenant meets a system agent through a
 * suggestion card a platform admin has assigned to it, and the card names the
 * permissions, apps and features it requires. `eligibleAgentCards` is the whole
 * of that intersection, evaluated server-side on every read:
 *
 *     agent is published
 *   ∩ assignment enabled
 *   ∩ assignment targets this business (by id, or by business type)
 *   ∩ the invoking member holds every required permission
 *   ∩ the business has every required app enabled
 *   ∩ the business has every required feature enabled
 *
 * Nothing in that list is a preference. If a card stops being eligible — a
 * permission is revoked, an app is switched off, an assignment is disabled — it
 * disappears from the picker on the next read, and a card that was already
 * opened cannot widen a turn, because the tool intersection is re-evaluated
 * per turn in `agentToolsForTurn`.
 *
 * The capability invariant is structural. An agent's `allowed_tools` /
 * `allowed_actions` are the SECOND term of
 *
 *     platform tool catalogue
 *   ∩ agent allowlist
 *   ∩ current tenant/app availability
 *   ∩ current user's effective permissions
 *   ∩ current location/project scope
 *
 * and the user's own permission set is the LAST term. So the worst a badly
 * configured agent can do is be useless; it cannot grant anything. An unknown
 * tool or action id in an allowlist is dropped, never honoured.
 */
import { query } from "./db";
import type { ActionType } from "./ai";
import type { AppKey } from "./apps";
import type { AiRuntimeMode } from "./ai-runtime-modes";

export type SystemAgentState = "draft" | "published" | "retired";

export interface SystemAgent {
  id: string;
  agentKey: string;
  name: string;
  description: string;
  icon: string;
  instructions: string;
  state: SystemAgentState;
  version: number;
  relevantApps: string[];
  businessTypes: string[];
  requiredFeatures: string[];
  requiredPermissions: string[];
  allowedTools: string[];
  allowedActions: string[];
  allowedModes: AiRuntimeMode[];
  defaultMode: AiRuntimeMode | null;
  suggestionCards: AgentSuggestionCard[];
  memoryScopes: string[];
  confirmationPolicy: Record<string, unknown>;
}

export interface AgentSuggestionCard {
  id: string;
  prompt: string;
  appFocus?: string;
  requiredPermissions?: string[];
  requiredApps?: string[];
  requiredFeatures?: string[];
  preferredMode?: AiRuntimeMode;
}

export interface AgentAssignment {
  id: string;
  agentId: string;
  businessId: string | null;
  businessType: string | null;
  prompt: string;
  appFocus: string;
  requiredPermissions: string[];
  requiredApps: string[];
  requiredFeatures: string[];
  preferredMode: AiRuntimeMode | null;
  enabled: boolean;
}

/** A card a member is allowed to see right now, with its agent resolved. */
export interface EligibleAgentCard {
  assignmentId: string;
  agentId: string;
  agentKey: string;
  agentName: string;
  agentIcon: string;
  prompt: string;
  appFocus: string;
  preferredMode: AiRuntimeMode | null;
  /** The agent's own narrowing allowlists, for the turn's tool intersection. */
  allowedTools: string[];
  allowedActions: string[];
  memoryScopes: string[];
}

export interface CreateAgentInput {
  agentKey: string;
  name: string;
  description?: string;
  icon?: string;
  instructions?: string;
  relevantApps?: string[];
  businessTypes?: string[];
  requiredFeatures?: string[];
  requiredPermissions?: string[];
  allowedTools?: string[];
  allowedActions?: string[];
  allowedModes?: AiRuntimeMode[];
  defaultMode?: AiRuntimeMode | null;
  suggestionCards?: AgentSuggestionCard[];
  memoryScopes?: string[];
  confirmationPolicy?: Record<string, unknown>;
  createdBy: string;
}

const AGENT_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function normalizeAgentKey(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidAgentKey(value: string): boolean {
  return AGENT_KEY_RE.test(normalizeAgentKey(value));
}

/** Validates an agent write. Returns the Persian message for the first fault. */
export function validateAgentInput(input: CreateAgentInput): string | null {
  const key = normalizeAgentKey(input.agentKey);
  if (!isValidAgentKey(key)) return "کلید ایجنت باید انگلیسی، ۲ تا ۶۴ نویسه و با حرف یا عدد شروع شود.";
  if (!input.name.trim()) return "نام ایجنت لازم است.";
  if ((input.allowedActions?.length ?? 0) > 0 && !(input.instructions ?? "").trim()) {
    return "ایجنتی که اجازهٔ عملیات اجرایی دارد باید دستورالعمل داشته باشد.";
  }
  return null;
}

export async function listSystemAgents(state?: SystemAgentState): Promise<SystemAgent[]> {
  const params: unknown[] = [];
  let sql = `SELECT * FROM ai_system_agents`;
  if (state) {
    sql += ` WHERE state = $1`;
    params.push(state);
  }
  sql += ` ORDER BY updated_at DESC`;
  const { rows } = await query<Record<string, unknown>>(sql, params);
  return rows.map(toAgent);
}

export async function getSystemAgent(id: string): Promise<SystemAgent | null> {
  const { rows } = await query<Record<string, unknown>>(`SELECT * FROM ai_system_agents WHERE id = $1`, [id]);
  return rows.length === 0 ? null : toAgent(rows[0]);
}

export async function getSystemAgentByKey(agentKey: string): Promise<SystemAgent | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM ai_system_agents WHERE agent_key = $1`,
    [normalizeAgentKey(agentKey)],
  );
  return rows.length === 0 ? null : toAgent(rows[0]);
}

export async function createSystemAgent(input: CreateAgentInput): Promise<SystemAgent> {
  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO ai_system_agents (
       agent_key, name, description, icon, instructions, state, version,
       relevant_apps, business_types, required_features, required_permissions,
       allowed_tools, allowed_actions, allowed_modes, default_mode,
       suggestion_cards, memory_scopes, confirmation_policy, created_by, updated_by
     ) VALUES ($1,$2,$3,$4,$5,'draft',1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
     RETURNING *`,
    [
      normalizeAgentKey(input.agentKey),
      input.name.trim(),
      input.description ?? "",
      input.icon ?? "",
      input.instructions ?? "",
      input.relevantApps ?? [],
      input.businessTypes ?? [],
      input.requiredFeatures ?? [],
      input.requiredPermissions ?? [],
      input.allowedTools ?? [],
      input.allowedActions ?? [],
      input.allowedModes?.length ? input.allowedModes : ["auto"],
      input.defaultMode ?? null,
      JSON.stringify(input.suggestionCards ?? []),
      input.memoryScopes?.length ? input.memoryScopes : ["tenant"],
      JSON.stringify(input.confirmationPolicy ?? {}),
      input.createdBy,
    ],
  );
  return toAgent(rows[0]);
}

export async function updateSystemAgent(input: {
  id: string;
  patch: Partial<Omit<CreateAgentInput, "agentKey" | "createdBy">>;
  updatedBy: string;
}): Promise<SystemAgent | null> {
  const columns: string[] = [];
  const params: unknown[] = [];
  const map: Record<string, unknown> = {
    name: input.patch.name?.trim(),
    description: input.patch.description,
    icon: input.patch.icon,
    instructions: input.patch.instructions,
    relevant_apps: input.patch.relevantApps,
    business_types: input.patch.businessTypes,
    required_features: input.patch.requiredFeatures,
    required_permissions: input.patch.requiredPermissions,
    allowed_tools: input.patch.allowedTools,
    allowed_actions: input.patch.allowedActions,
    allowed_modes: input.patch.allowedModes,
    default_mode: input.patch.defaultMode,
    memory_scopes: input.patch.memoryScopes,
  };
  for (const [column, value] of Object.entries(map)) {
    if (value === undefined) continue;
    params.push(Array.isArray(value) ? value : value);
    columns.push(`${column} = $${params.length}`);
  }
  if (input.patch.suggestionCards !== undefined) {
    params.push(JSON.stringify(input.patch.suggestionCards));
    columns.push(`suggestion_cards = $${params.length}`);
  }
  if (input.patch.confirmationPolicy !== undefined) {
    params.push(JSON.stringify(input.patch.confirmationPolicy));
    columns.push(`confirmation_policy = $${params.length}`);
  }
  if (columns.length === 0) return getSystemAgent(input.id);
  params.push(input.updatedBy, input.id);
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE ai_system_agents SET ${columns.join(", ")}, updated_by = $${params.length - 1}, updated_at = now()
      WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows.length === 0 ? null : toAgent(rows[0]);
}

/**
 * Publishes an agent. A draft is invisible to tenants; publishing is what makes
 * its suggestion cards eligible, and it is Superadmin-only by the route guard,
 * not by a column.
 */
export async function publishSystemAgent(input: { id: string; publishedBy: string }): Promise<SystemAgent | null> {
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE ai_system_agents
        SET state = 'published', version = version + 1, published_by = $2, published_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [input.id, input.publishedBy],
  );
  return rows.length === 0 ? null : toAgent(rows[0]);
}

export async function retireSystemAgent(id: string, updatedBy: string): Promise<SystemAgent | null> {
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE ai_system_agents SET state = 'retired', updated_by = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, updatedBy],
  );
  return rows.length === 0 ? null : toAgent(rows[0]);
}

// ---------------------------------------------------------------------------
// assignments
// ---------------------------------------------------------------------------

export async function listAgentAssignments(agentId?: string): Promise<AgentAssignment[]> {
  const params: unknown[] = [];
  let sql = `SELECT * FROM ai_agent_assignments`;
  if (agentId) {
    sql += ` WHERE agent_id = $1`;
    params.push(agentId);
  }
  sql += ` ORDER BY created_at DESC`;
  const { rows } = await query<Record<string, unknown>>(sql, params);
  return rows.map(toAssignment);
}

export async function createAgentAssignment(input: {
  agentId: string;
  businessId?: string | null;
  businessType?: string | null;
  prompt: string;
  appFocus?: string;
  requiredPermissions?: string[];
  requiredApps?: string[];
  requiredFeatures?: string[];
  preferredMode?: AiRuntimeMode | null;
  createdBy: string;
}): Promise<AgentAssignment> {
  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO ai_agent_assignments (
       agent_id, business_id, business_type, prompt, app_focus,
       required_permissions, required_apps, required_features, preferred_mode, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      input.agentId,
      input.businessId ?? null,
      input.businessType ?? null,
      input.prompt.trim(),
      input.appFocus ?? "all",
      input.requiredPermissions ?? [],
      input.requiredApps ?? [],
      input.requiredFeatures ?? [],
      input.preferredMode ?? null,
      input.createdBy,
    ],
  );
  return toAssignment(rows[0]);
}

export async function setAgentAssignmentEnabled(input: {
  id: string;
  enabled: boolean;
}): Promise<AgentAssignment | null> {
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE ai_agent_assignments SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [input.id, input.enabled],
  );
  return rows.length === 0 ? null : toAssignment(rows[0]);
}

export interface EligibleCardsInput {
  businessId: string;
  businessType: string | null;
  /** The member's effective permission keys. */
  permissions: string[];
  /** The apps this business has enabled. */
  enabledApps: AppKey[];
  /** The features this business has enabled. */
  enabledFeatures: string[];
}

/**
 * The suggestion cards this member may see right now.
 *
 * Deliberately fails closed and deliberately evaluates every term on every
 * read: a card whose permission was revoked a minute ago must not still be
 * offered, and a card that was never eligible must not appear because a cached
 * list said so.
 */
export async function eligibleAgentCards(input: EligibleCardsInput): Promise<EligibleAgentCard[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT a.*, g.agent_key, g.name AS agent_name, g.icon AS agent_icon,
            g.allowed_tools, g.allowed_actions, g.memory_scopes
       FROM ai_agent_assignments a
       JOIN ai_system_agents g ON g.id = a.agent_id
      WHERE g.state = 'published'
        AND a.enabled
        AND (a.business_id = $1 OR (a.business_id IS NULL AND a.business_type = $2))
      ORDER BY a.created_at DESC`,
    [input.businessId, input.businessType],
  );

  const permissions = new Set(input.permissions);
  const apps = new Set(input.enabledApps);
  const features = new Set(input.enabledFeatures);
  const cards: EligibleAgentCard[] = [];

  for (const row of rows) {
    if (!hasAll(permissions, asStringArray(row.required_permissions))) continue;
    if (!hasAll(apps, asStringArray(row.required_apps))) continue;
    if (!hasAll(features, asStringArray(row.required_features))) continue;
    cards.push({
      assignmentId: String(row.id),
      agentId: String(row.agent_id),
      agentKey: String(row.agent_key),
      agentName: String(row.agent_name),
      agentIcon: String(row.agent_icon ?? ""),
      prompt: String(row.prompt),
      appFocus: String(row.app_focus ?? "all"),
      preferredMode: (row.preferred_mode as AiRuntimeMode | null) ?? null,
      allowedTools: asStringArray(row.allowed_tools),
      allowedActions: asStringArray(row.allowed_actions),
      memoryScopes: asStringArray(row.memory_scopes),
    });
  }
  return cards;
}

/**
 * The turn's tool and action intersection (§12's invariant), given the agent's
 * allowlists and what the platform actually offers this member.
 *
 * `platformTools` and `platformActions` are already narrowed by the caller to
 * what the tenant/app/member/location/project scope permits. This function only
 * applies the agent term — and drops anything it does not recognise, so an
 * unknown id fails closed instead of being passed through.
 */
export function agentToolsForTurn(input: {
  agent: Pick<SystemAgent, "allowedTools" | "allowedActions"> | null;
  platformTools: string[];
  platformActions: ActionType[];
}): { tools: string[]; actions: ActionType[] } {
  if (!input.agent) return { tools: input.platformTools, actions: input.platformActions };
  const tools = new Set(input.agent.allowedTools);
  const actions = new Set(input.agent.allowedActions);
  return {
    // An empty agent allowlist means "all platform tools this member may
    // already use" — an agent that names no tool is a persona, not a
    // restriction, and silently stripping every tool would make it useless.
    tools: tools.size === 0 ? input.platformTools : input.platformTools.filter((name) => tools.has(name)),
    actions:
      actions.size === 0
        ? input.platformActions
        : input.platformActions.filter((type) => actions.has(type as string)),
  };
}

function hasAll(have: Set<string>, required: string[]): boolean {
  return required.every((value) => have.has(value));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function toAgent(row: Record<string, unknown>): SystemAgent {
  const cards = Array.isArray(row.suggestion_cards) ? (row.suggestion_cards as AgentSuggestionCard[]) : [];
  return {
    id: String(row.id),
    agentKey: String(row.agent_key),
    name: String(row.name),
    description: String(row.description ?? ""),
    icon: String(row.icon ?? ""),
    instructions: String(row.instructions ?? ""),
    state: (row.state as SystemAgentState) ?? "draft",
    version: Number(row.version ?? 1),
    relevantApps: asStringArray(row.relevant_apps),
    businessTypes: asStringArray(row.business_types),
    requiredFeatures: asStringArray(row.required_features),
    requiredPermissions: asStringArray(row.required_permissions),
    allowedTools: asStringArray(row.allowed_tools),
    allowedActions: asStringArray(row.allowed_actions),
    allowedModes: (asStringArray(row.allowed_modes) as AiRuntimeMode[]).filter(Boolean),
    defaultMode: (row.default_mode as AiRuntimeMode | null) ?? null,
    suggestionCards: cards,
    memoryScopes: asStringArray(row.memory_scopes),
    confirmationPolicy:
      row.confirmation_policy && typeof row.confirmation_policy === "object"
        ? (row.confirmation_policy as Record<string, unknown>)
        : {},
  };
}

function toAssignment(row: Record<string, unknown>): AgentAssignment {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    businessId: (row.business_id as string | null) ?? null,
    businessType: (row.business_type as string | null) ?? null,
    prompt: String(row.prompt),
    appFocus: String(row.app_focus ?? "all"),
    requiredPermissions: asStringArray(row.required_permissions),
    requiredApps: asStringArray(row.required_apps),
    requiredFeatures: asStringArray(row.required_features),
    preferredMode: (row.preferred_mode as AiRuntimeMode | null) ?? null,
    enabled: Boolean(row.enabled),
  };
}
