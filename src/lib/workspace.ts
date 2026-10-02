/**
 * Phase G — «میز کار من» (My Workspace): the DB-touching half.
 *
 * The rule this module follows, and the reason it exists beside
 * `ai-projects.ts` rather than replacing it: `ai-projects.ts` owns the
 * ASSISTANT's view of a project (instructions, notes, memory, the open-task
 * list that goes into the prompt) and keeps working exactly as it did. This
 * module owns the BUSINESS's view — the operational project record, the rich
 * task, members, phases, contracts, documents, approvals, the calendar and the
 * dashboard roll-up. They read the same `ai_projects` row from two angles,
 * which is why neither had to be rewritten to get the other.
 *
 * Framework-free except for `query`, like every other service here: no `next`,
 * no React. Pure constants and rules live in `workspace-shared.ts`.
 */
import { query } from "./db";
import { isoDateInTimeZone, postgresDateToIso } from "./jalali";
import {
  BUILTIN_TEMPLATES,
  CONTRACT_STATUSES,
  CONTRACT_TYPES,
  DOCUMENT_STATUSES,
  EVENT_KINDS,
  PRIORITIES,
  PROJECT_STATUSES,
  TASK_STATUSES,
  WORKSPACE_LIMITS,
  WORKSPACE_ROLES,
  builtinTemplate,
  normalizeTags,
  phasesFromTemplate,
  roleCan,
  wouldCreateDependencyCycle,
  type WorkspaceApprovalStatus,
  type WorkspaceApprovalSubject,
  type WorkspaceCapability,
  type WorkspaceContractStatus,
  type WorkspaceContractType,
  type WorkspaceDocumentStatus,
  type WorkspaceEventKind,
  type WorkspacePhaseStatus,
  type WorkspacePriority,
  type WorkspaceProjectStatus,
  type WorkspaceRole,
  type WorkspaceTaskStatus,
  type WorkspaceTemplate,
} from "./workspace-shared";

/** Every workspace write carries the business it belongs to and who did it. */
export interface WorkspaceOwner {
  businessId: string;
  actorUserId: string;
  actorName?: string;
}

/** Thrown with a machine-readable code the API layer maps to a status + message. */
/**
 * The calendar date a `date` column holds, as YYYY-MM-DD.
 *
 * node-postgres hands back a Postgres `date` as a JS `Date` at local midnight,
 * and `String(thatDate).slice(0, 10)` produces `"Sun Mar 01"` — the first ten
 * characters of `toString()`, not an ISO date. That is what the API was
 * serving for every project start/end date, task due date and contract expiry:
 * a string no date picker can parse, no Jalali converter can read, and no
 * `date >= from` comparison can order. `postgresDateToIso` reads the Date's
 * local components, which is also the only form that survives a runner east of
 * UTC (Tehran midnight is 20:30 the previous day in UTC).
 *
 * Strings pass through untouched, so a column already cast with `::text` in
 * SQL — the calendar union does this — is unaffected.
 */
function isoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return postgresDateToIso(value);
  const text = String(value);
  return text ? text.slice(0, 10) : null;
}

export class WorkspaceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "WorkspaceError";
  }
}

function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  code: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) throw new WorkspaceError(code);
  return value as T;
}

function trimTo(value: string | null | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

function requireText(value: string | null | undefined, max: number, code: string): string {
  const text = trimTo(value, max);
  if (!text) throw new WorkspaceError(code);
  return text;
}

/**
 * ISO `YYYY-MM-DD` or null. Dates arrive from the UI already converted from
 * Shamsi to Gregorian by `jalali.ts`; the database only ever sees Gregorian,
 * which is the repo's standing rule and what keeps a stored date from shifting
 * when a user switches calendar preference.
 */
function isoDateOrNull(value: unknown, code: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new WorkspaceError(code);
  }
  return value;
}

function numberOrNull(value: unknown, code: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new WorkspaceError(code);
  return n;
}

/* ===========================================================================
 * Access — the platform permission ∩ the project role
 * ======================================================================== */

/**
 * A member's role on one project, or null when they are not on it.
 *
 * The caller has ALREADY passed the platform permission check
 * (`requirePermission("workspace.view")` and friends) before reaching here.
 * This narrows that business-wide answer to one project, which the platform
 * permissions cannot express because they have no project dimension.
 */
export async function projectRoleFor(
  businessId: string,
  projectId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const { rows } = await query<{ role: string | null; implicit_owner: boolean }>(
    `SELECT m.role,
            (p.owner_user_id = $2 OR CASE
               WHEN p.created_by ~ '^[0-9a-fA-F-]{36}$' THEN p.created_by::uuid = $2
               ELSE false
             END) AS implicit_owner
       FROM ai_projects p
       LEFT JOIN workspace_members m ON m.project_id = p.id AND m.user_id = $2
      WHERE p.id = $1 AND p.business_id = $3`,
    [projectId, userId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.role && (WORKSPACE_ROLES as readonly string[]).includes(row.role)) {
    return row.role as WorkspaceRole;
  }
  // No membership row, but this member owns or created the project. That is
  // not a hole in the model — it is the pre-Phase-G write path, which is still
  // live: `/api/ai/projects` (and the AI tools behind it) insert into
  // `ai_projects` and know nothing about `workspace_members`. 0167 backfilled
  // an owner row for every project that existed at migration time; this covers
  // every project written the old way SINCE. Without it, a user who creates a
  // project from the assistant cannot reopen it, which is exactly the "existing
  // functionality keeps working" promise breaking in the other direction.
  return row.implicit_owner ? "owner" : null;
}

/**
 * Asserts a capability on one project.
 *
 * `privileged` is the escape hatch for the business's own owner/manager, who
 * hold `workspace.manage` business-wide: they must be able to open a project
 * nobody added them to, because a business owner locked out of their own
 * project by a membership row is a support ticket, not a security feature.
 * Everyone else needs a membership row.
 */
export async function requireProjectCapability(
  owner: WorkspaceOwner,
  projectId: string,
  capability: WorkspaceCapability,
  privileged = false,
): Promise<WorkspaceRole> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM ai_projects WHERE id = $1 AND business_id = $2`,
    [projectId, owner.businessId],
  );
  if (!rows[0]) throw new WorkspaceError("project_not_found");

  const role = await projectRoleFor(owner.businessId, projectId, owner.actorUserId);
  if (role && roleCan(role, capability)) return role;
  if (privileged) return role ?? "manager";
  throw new WorkspaceError(role ? "insufficient_project_role" : "not_a_project_member");
}

/* ===========================================================================
 * Projects
 * ======================================================================== */

export interface WorkspaceProject {
  id: string;
  name: string;
  description: string;
  status: WorkspaceProjectStatus;
  priority: WorkspacePriority;
  projectType: string | null;
  templateKey: string | null;
  startDate: string | null;
  endDate: string | null;
  tags: string[];
  partyId: string | null;
  partyName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  budgetRial: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Roll-ups the list and the cards need, computed in the same query. */
  taskCount: number;
  doneTaskCount: number;
  memberCount: number;
  contractCount: number;
  documentCount: number;
}

type ProjectRow = {
  id: string; name: string; description: string; status: string; priority: string;
  project_type: string | null; template_key: string | null;
  start_date: string | null; end_date: string | null; tags: string[] | null;
  party_id: string | null; party_name: string | null;
  owner_user_id: string | null; owner_name: string | null;
  budget_rial: string | number | null; archived_at: string | null;
  created_at: string; updated_at: string;
  task_count?: string; done_task_count?: string; member_count?: string;
  contract_count?: string; document_count?: string;
};

function toProject(row: ProjectRow): WorkspaceProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    status: row.status as WorkspaceProjectStatus,
    priority: (row.priority ?? "normal") as WorkspacePriority,
    projectType: row.project_type,
    templateKey: row.template_key,
    startDate: isoDate(row.start_date),
    endDate: isoDate(row.end_date),
    tags: row.tags ?? [],
    partyId: row.party_id,
    partyName: row.party_name,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    budgetRial: row.budget_rial === null || row.budget_rial === undefined ? null : Number(row.budget_rial),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    taskCount: Number(row.task_count ?? 0),
    doneTaskCount: Number(row.done_task_count ?? 0),
    memberCount: Number(row.member_count ?? 0),
    contractCount: Number(row.contract_count ?? 0),
    documentCount: Number(row.document_count ?? 0),
  };
}

const PROJECT_SELECT = `
  p.id, p.name, p.description, p.status, p.priority, p.project_type, p.template_key,
  p.start_date, p.end_date, p.tags, p.party_id, party.name AS party_name,
  p.owner_user_id, u.full_name AS owner_name, p.budget_rial,
  p.archived_at, p.created_at, p.updated_at,
  (SELECT count(*) FROM ai_project_tasks t WHERE t.project_id = p.id) AS task_count,
  (SELECT count(*) FROM ai_project_tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_task_count,
  (SELECT count(*) FROM workspace_members m WHERE m.project_id = p.id) AS member_count,
  (SELECT count(*) FROM workspace_contracts c WHERE c.project_id = p.id) AS contract_count,
  (SELECT count(*) FROM workspace_documents d WHERE d.project_id = p.id) AS document_count`;

const PROJECT_JOINS = `
  FROM ai_projects p
  LEFT JOIN users u ON u.id = p.owner_user_id AND u.business_id = p.business_id
  LEFT JOIN parties party ON party.id = p.party_id AND party.business_id = p.business_id`;

export interface ProjectListFilter {
  status?: WorkspaceProjectStatus | "all";
  priority?: WorkspacePriority;
  partyId?: string;
  /** Only projects this user is a member of — the «پروژه‌های من» toggle. */
  memberUserId?: string;
  search?: string;
  includeArchived?: boolean;
  tag?: string;
  limit?: number;
}

export async function listWorkspaceProjects(
  businessId: string,
  filter: ProjectListFilter = {},
): Promise<WorkspaceProject[]> {
  const where: string[] = ["p.business_id = $1"];
  const params: unknown[] = [businessId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };

  if (!filter.includeArchived) where.push("p.archived_at IS NULL");
  if (filter.status && filter.status !== "all") add("p.status = $?", filter.status);
  if (filter.priority) add("p.priority = $?", filter.priority);
  if (filter.partyId) add("p.party_id = $?", filter.partyId);
  if (filter.tag) add("$? = ANY(p.tags)", filter.tag);
  if (filter.search) add("p.name ILIKE '%' || $? || '%'", filter.search.trim());
  if (filter.memberUserId) {
    add(
      "EXISTS (SELECT 1 FROM workspace_members m WHERE m.project_id = p.id AND m.user_id = $?)",
      filter.memberUserId,
    );
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200);

  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_SELECT} ${PROJECT_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY p.archived_at IS NOT NULL,
               CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               p.end_date NULLS LAST, p.created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(toProject);
}

export async function getWorkspaceProject(
  businessId: string,
  projectId: string,
): Promise<WorkspaceProject | null> {
  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_SELECT} ${PROJECT_JOINS} WHERE p.id = $2 AND p.business_id = $1`,
    [businessId, projectId],
  );
  return rows[0] ? toProject(rows[0]) : null;
}

export interface ProjectInput {
  name?: string;
  description?: string;
  status?: string;
  priority?: string;
  projectType?: string | null;
  templateKey?: string | null;
  startDate?: unknown;
  endDate?: unknown;
  tags?: unknown;
  partyId?: string | null;
  ownerUserId?: string | null;
  budgetRial?: unknown;
  /** Server-derived idempotency/source fields; never accepted from generic browser forms. */
  creationKey?: string | null;
  sourceDealId?: string | null;
  forecastRevenueRial?: unknown;
}

/**
 * Creates a project with its workspace fields, seeds its phases from a
 * template and makes the creator its owner-member — the three writes that
 * together make a project usable, done in one transaction-less sequence
 * because each is independently correct and a half-seeded project is still a
 * working project.
 */
export async function createWorkspaceProject(
  owner: WorkspaceOwner,
  input: ProjectInput,
): Promise<WorkspaceProject> {
  const name = requireText(input.name, WORKSPACE_LIMITS.projectNameMax, "project_name_required");
  const description = trimTo(input.description, WORKSPACE_LIMITS.projectDescriptionMax);
  const status = assertEnum(input.status ?? "planning", PROJECT_STATUSES, "invalid_project_status");
  const priority = assertEnum(input.priority ?? "normal", PRIORITIES, "invalid_priority");
  const startDate = isoDateOrNull(input.startDate, "invalid_date");
  const endDate = isoDateOrNull(input.endDate, "invalid_date");
  if (startDate && endDate && endDate < startDate) throw new WorkspaceError("end_before_start");
  const tags = normalizeTags(input.tags);
  const budgetRial = numberOrNull(input.budgetRial, "invalid_project_budget");
  const forecastRevenueRial = numberOrNull(input.forecastRevenueRial, "invalid_project_budget");
  const templateKey = input.templateKey?.trim() || null;

  await assertPartyBelongs(owner.businessId, input.partyId ?? null);
  await assertUserBelongs(owner.businessId, input.ownerUserId ?? null);

  const template = templateKey ? await resolveTemplate(owner.businessId, templateKey) : null;
  if (templateKey && !template) throw new WorkspaceError("template_not_found");

  const { rows } = await query<{ id: string; inserted: boolean }>(
    `INSERT INTO ai_projects
       (business_id, name, instructions, created_by, description, status, priority,
        project_type, template_key, start_date, end_date, tags, party_id,
        owner_user_id, budget_rial, creation_key, source_deal_id, forecast_revenue_rial)
     VALUES ($1, $2, '', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (business_id, creation_key) WHERE creation_key IS NOT NULL
       DO UPDATE SET name = ai_projects.name
     RETURNING id, (xmax = 0) AS inserted`,
    [
      owner.businessId, name, owner.actorUserId, description, status, priority,
      input.projectType?.trim() || template?.projectType || null, templateKey,
      startDate, endDate, tags, input.partyId ?? null,
      input.ownerUserId ?? owner.actorUserId, budgetRial,
      input.creationKey?.trim() || null, input.sourceDealId ?? null, forecastRevenueRial,
    ],
  );
  const projectId = rows[0].id;
  if (!rows[0].inserted) {
    const existing = await getWorkspaceProject(owner.businessId, projectId);
    if (!existing) throw new WorkspaceError("project_not_found");
    return existing;
  }

  // The creator is the project's owner-member. Without this the creator could
  // not reopen what they just made unless they also held workspace.manage.
  await query(
    `INSERT INTO workspace_members (project_id, user_id, role, added_by)
     VALUES ($1, $2, 'owner', $3) ON CONFLICT (project_id, user_id) DO NOTHING`,
    [projectId, input.ownerUserId ?? owner.actorUserId, owner.actorUserId],
  );

  if (template) await applyTemplate(owner, projectId, template, startDate);

  await recordActivity(owner, {
    projectId, subjectType: "project", subjectId: projectId,
    action: "created", summary: name,
  });

  const created = await getWorkspaceProject(owner.businessId, projectId);
  if (!created) throw new WorkspaceError("project_not_found");
  return created;
}

/**
 * Patches a project's workspace fields. Every field is optional and an absent
 * key means "leave it alone" — `null` is a real value (clear the date, unlink
 * the customer), which is why `undefined` and `null` are distinguished
 * throughout rather than collapsed with `??`.
 */
export async function updateWorkspaceProject(
  owner: WorkspaceOwner,
  projectId: string,
  input: ProjectInput,
): Promise<WorkspaceProject | null> {
  const existing = await getWorkspaceProject(owner.businessId, projectId);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [projectId, owner.businessId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (input.name !== undefined) {
    set("name", requireText(input.name, WORKSPACE_LIMITS.projectNameMax, "project_name_required"));
  }
  if (input.description !== undefined) {
    set("description", trimTo(input.description, WORKSPACE_LIMITS.projectDescriptionMax));
  }
  if (input.status !== undefined) {
    set("status", assertEnum(input.status, PROJECT_STATUSES, "invalid_project_status"));
  }
  if (input.priority !== undefined) {
    set("priority", assertEnum(input.priority, PRIORITIES, "invalid_priority"));
  }
  if (input.projectType !== undefined) set("project_type", input.projectType?.trim() || null);
  if (input.startDate !== undefined) set("start_date", isoDateOrNull(input.startDate, "invalid_date"));
  if (input.endDate !== undefined) set("end_date", isoDateOrNull(input.endDate, "invalid_date"));
  if (input.tags !== undefined) set("tags", normalizeTags(input.tags));
  if (input.budgetRial !== undefined) {
    set("budget_rial", numberOrNull(input.budgetRial, "invalid_project_budget"));
  }
  if (input.partyId !== undefined) {
    await assertPartyBelongs(owner.businessId, input.partyId);
    set("party_id", input.partyId);
  }
  if (input.ownerUserId !== undefined) {
    await assertUserBelongs(owner.businessId, input.ownerUserId);
    set("owner_user_id", input.ownerUserId);
  }
  if (!sets.length) return existing;

  await query(
    `UPDATE ai_projects SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $1 AND business_id = $2`,
    params,
  );
  await recordActivity(owner, {
    projectId, subjectType: "project", subjectId: projectId,
    action: "updated", summary: input.name?.trim() || existing.name,
  });
  return getWorkspaceProject(owner.businessId, projectId);
}

async function assertPartyBelongs(businessId: string, partyId: string | null): Promise<void> {
  if (!partyId) return;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM parties WHERE id = $1 AND business_id = $2`,
    [partyId, businessId],
  );
  if (!rows[0]) throw new WorkspaceError("party_not_found");
}

async function assertUserBelongs(businessId: string, userId: string | null): Promise<void> {
  if (!userId) return;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND business_id = $2 AND is_active`,
    [userId, businessId],
  );
  if (!rows[0]) throw new WorkspaceError("user_not_found");
}

/* ===========================================================================
 * Phases & templates
 * ======================================================================== */

export interface WorkspacePhase {
  id: string;
  projectId: string;
  name: string;
  status: WorkspacePhaseStatus;
  displayOrder: number;
  startDate: string | null;
  endDate: string | null;
  taskCount: number;
  doneTaskCount: number;
}

export async function listPhases(projectId: string): Promise<WorkspacePhase[]> {
  const { rows } = await query<{
    id: string; project_id: string; name: string; status: string;
    display_order: number; start_date: string | null; end_date: string | null;
    task_count: string; done_task_count: string;
  }>(
    `SELECT ph.id, ph.project_id, ph.name, ph.status, ph.display_order,
            ph.start_date, ph.end_date,
            (SELECT count(*) FROM ai_project_tasks t WHERE t.phase_id = ph.id) AS task_count,
            (SELECT count(*) FROM ai_project_tasks t WHERE t.phase_id = ph.id AND t.status = 'done') AS done_task_count
       FROM workspace_project_phases ph
      WHERE ph.project_id = $1
      ORDER BY ph.display_order, ph.created_at`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    status: row.status as WorkspacePhaseStatus,
    displayOrder: row.display_order,
    startDate: isoDate(row.start_date),
    endDate: isoDate(row.end_date),
    taskCount: Number(row.task_count),
    doneTaskCount: Number(row.done_task_count),
  }));
}

export async function addPhase(
  owner: WorkspaceOwner,
  projectId: string,
  input: { name: string; displayOrder?: number; startDate?: unknown; endDate?: unknown },
): Promise<WorkspacePhase[]> {
  const name = requireText(input.name, 120, "phase_name_required");
  await query(
    `INSERT INTO workspace_project_phases (project_id, name, display_order, start_date, end_date)
     VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(max(display_order), -1) + 1
                                     FROM workspace_project_phases WHERE project_id = $1)), $4, $5)`,
    [
      projectId, name, input.displayOrder ?? null,
      isoDateOrNull(input.startDate, "invalid_date"),
      isoDateOrNull(input.endDate, "invalid_date"),
    ],
  );
  return listPhases(projectId);
}

export async function updatePhase(
  owner: WorkspaceOwner,
  projectId: string,
  phaseId: string,
  input: { name?: string; status?: string; displayOrder?: number; startDate?: unknown; endDate?: unknown },
): Promise<WorkspacePhase[]> {
  const sets: string[] = [];
  const params: unknown[] = [phaseId, projectId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.name !== undefined) set("name", requireText(input.name, 120, "phase_name_required"));
  if (input.status !== undefined) {
    set("status", assertEnum(input.status, ["pending", "active", "done", "skipped"] as const, "invalid_phase_status"));
  }
  if (input.displayOrder !== undefined) set("display_order", input.displayOrder);
  if (input.startDate !== undefined) set("start_date", isoDateOrNull(input.startDate, "invalid_date"));
  if (input.endDate !== undefined) set("end_date", isoDateOrNull(input.endDate, "invalid_date"));
  if (sets.length) {
    await query(
      `UPDATE workspace_project_phases SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $1 AND project_id = $2`,
      params,
    );
  }
  return listPhases(projectId);
}

export async function deletePhase(projectId: string, phaseId: string): Promise<WorkspacePhase[]> {
  await query(`DELETE FROM workspace_project_phases WHERE id = $1 AND project_id = $2`, [phaseId, projectId]);
  return listPhases(projectId);
}

/**
 * The catalogue a business sees: the built-ins from code, plus its own rows.
 * A business template with the same key as a built-in overrides it, so a
 * business can customise «ساخت‌وساز» without losing the name it already uses.
 */
export async function listTemplates(businessId: string): Promise<WorkspaceTemplate[]> {
  const { rows } = await query<{
    key: string; name: string; description: string; project_type: string | null;
    phases: unknown; default_tasks: unknown;
  }>(
    `SELECT key, name, description, project_type, phases, default_tasks
       FROM workspace_project_templates
      WHERE business_id = $1 AND archived_at IS NULL
      ORDER BY name`,
    [businessId],
  );
  const custom = rows.map((row) => ({
    key: row.key,
    name: row.name,
    description: row.description ?? "",
    projectType: row.project_type ?? "general",
    phases: Array.isArray(row.phases) ? (row.phases as WorkspaceTemplate["phases"]) : [],
    defaultTasks: Array.isArray(row.default_tasks) ? (row.default_tasks as string[]) : [],
  }));
  const overridden = new Set(custom.map((t) => t.key));
  return [...BUILTIN_TEMPLATES.filter((t) => !overridden.has(t.key)), ...custom];
}

async function resolveTemplate(businessId: string, key: string): Promise<WorkspaceTemplate | null> {
  const all = await listTemplates(businessId);
  return all.find((t) => t.key === key) ?? builtinTemplate(key);
}

export async function saveTemplate(
  owner: WorkspaceOwner,
  input: {
    key?: string; name?: string; description?: string; projectType?: string | null;
    phases?: unknown; defaultTasks?: unknown;
  },
): Promise<WorkspaceTemplate[]> {
  const name = requireText(input.name, 120, "template_name_required");
  const key = trimTo(input.key, 60) || name.replace(/\s+/g, "-").toLowerCase().slice(0, 60);
  const phases = Array.isArray(input.phases)
    ? input.phases
        .filter((p): p is { name: string } => !!p && typeof (p as { name?: unknown }).name === "string")
        .slice(0, WORKSPACE_LIMITS.templatePhasesMax)
        .map((p) => ({ name: p.name.trim().slice(0, 120) }))
        .filter((p) => p.name)
    : [];
  if (!phases.length) throw new WorkspaceError("template_needs_phases");
  const defaultTasks = Array.isArray(input.defaultTasks)
    ? input.defaultTasks
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().slice(0, WORKSPACE_LIMITS.taskTitleMax))
        .filter(Boolean)
        .slice(0, 20)
    : [];

  await query(
    `INSERT INTO workspace_project_templates
       (business_id, key, name, description, project_type, phases, default_tasks, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
     ON CONFLICT (business_id, key) DO UPDATE
        SET name = EXCLUDED.name, description = EXCLUDED.description,
            project_type = EXCLUDED.project_type, phases = EXCLUDED.phases,
            default_tasks = EXCLUDED.default_tasks, archived_at = NULL, updated_at = now()`,
    [
      owner.businessId, key, name, trimTo(input.description, 500),
      input.projectType?.trim() || null,
      JSON.stringify(phases), JSON.stringify(defaultTasks), owner.actorUserId,
    ],
  );
  return listTemplates(owner.businessId);
}

export async function archiveTemplate(businessId: string, key: string): Promise<WorkspaceTemplate[]> {
  await query(
    `UPDATE workspace_project_templates SET archived_at = now(), updated_at = now()
      WHERE business_id = $1 AND key = $2`,
    [businessId, key],
  );
  return listTemplates(businessId);
}

/** Seeds a project's phases and starter tasks from a template. Idempotent-ish:
 *  it appends, so applying a second template adds its phases after the first. */
export async function applyTemplate(
  owner: WorkspaceOwner,
  projectId: string,
  template: WorkspaceTemplate,
  startDate: string | null,
): Promise<void> {
  const phases = phasesFromTemplate(template, startDate);
  for (const phase of phases) {
    await query(
      `INSERT INTO workspace_project_phases (project_id, name, display_order, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5)`,
      [projectId, phase.name, phase.displayOrder, phase.startDate, phase.endDate],
    );
  }
  for (const title of template.defaultTasks) {
    await query(
      `INSERT INTO ai_project_tasks (project_id, title, source, created_by)
       VALUES ($1, $2, 'user', $3)`,
      [projectId, title.slice(0, WORKSPACE_LIMITS.taskTitleMax), owner.actorUserId],
    );
  }
}

/* ===========================================================================
 * Members
 * ======================================================================== */

export interface WorkspaceMember {
  id: string;
  projectId: string;
  userId: string;
  fullName: string;
  role: WorkspaceRole;
  createdAt: string;
}

export async function listMembers(projectId: string): Promise<WorkspaceMember[]> {
  const { rows } = await query<{
    id: string; project_id: string; user_id: string; full_name: string | null;
    role: string; created_at: string;
  }>(
    `SELECT m.id, m.project_id, m.user_id, u.full_name, m.role, m.created_at
       FROM workspace_members m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'editor' THEN 2
                           WHEN 'contributor' THEN 3 ELSE 4 END, u.full_name`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    fullName: row.full_name ?? "—",
    role: row.role as WorkspaceRole,
    createdAt: row.created_at,
  }));
}

export async function setMember(
  owner: WorkspaceOwner,
  projectId: string,
  userId: string,
  role: string,
): Promise<WorkspaceMember[]> {
  const checked = assertEnum(role, WORKSPACE_ROLES, "invalid_workspace_role");
  await assertUserBelongs(owner.businessId, userId);
  await query(
    `INSERT INTO workspace_members (project_id, user_id, role, added_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, user_id) DO UPDATE
        SET role = EXCLUDED.role, updated_at = now()`,
    [projectId, userId, checked, owner.actorUserId],
  );
  await recordActivity(owner, {
    projectId, subjectType: "member", subjectId: null,
    action: "member_set", summary: checked,
  });
  return listMembers(projectId);
}

/**
 * Removes a member, refusing to remove the last owner: a project with no owner
 * is a project only a business-wide `workspace.manage` holder can ever reach
 * again, which is a lockout dressed as a delete.
 */
export async function removeMember(
  owner: WorkspaceOwner,
  projectId: string,
  userId: string,
): Promise<WorkspaceMember[]> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*) AS count FROM workspace_members
      WHERE project_id = $1 AND role = 'owner' AND user_id <> $2`,
    [projectId, userId],
  );
  const { rows: target } = await query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE project_id = $1 AND user_id = $2`,
    [projectId, userId],
  );
  if (target[0]?.role === "owner" && Number(rows[0].count) === 0) {
    throw new WorkspaceError("last_owner_cannot_be_removed");
  }
  await query(`DELETE FROM workspace_members WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
  return listMembers(projectId);
}

/* ===========================================================================
 * Tasks
 * ======================================================================== */

export interface WorkspaceTask {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  description: string;
  status: WorkspaceTaskStatus;
  priority: WorkspacePriority;
  assigneeUserId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  partyId: string | null;
  partyName: string | null;
  phaseId: string | null;
  phaseName: string | null;
  position: number;
  source: "user" | "ai";
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
  checklistTotal: number;
  checklistDone: number;
  commentCount: number;
  documentCount: number;
  blockedBy: number;
}

const TASK_SELECT = `
  t.id, t.project_id, p.name AS project_name, t.title, t.description, t.status, t.priority,
  t.assignee_user_id, u.full_name AS assignee_name, t.due_date,
  t.party_id, party.name AS party_name, t.phase_id, ph.name AS phase_name,
  t.position, t.source, t.created_at, t.completed_at, t.updated_at,
  (SELECT count(*) FROM workspace_task_checklist c WHERE c.task_id = t.id) AS checklist_total,
  (SELECT count(*) FROM workspace_task_checklist c WHERE c.task_id = t.id AND c.done) AS checklist_done,
  (SELECT count(*) FROM workspace_comments wc WHERE wc.subject_type = 'task' AND wc.subject_id = t.id) AS comment_count,
  (SELECT count(*) FROM workspace_documents d WHERE d.task_id = t.id) AS document_count,
  (SELECT count(*) FROM workspace_task_dependencies dep
     JOIN ai_project_tasks bt ON bt.id = dep.depends_on_id
    WHERE dep.task_id = t.id AND bt.status <> 'done') AS blocked_by`;

const TASK_JOINS = `
  FROM ai_project_tasks t
  JOIN ai_projects p ON p.id = t.project_id
  LEFT JOIN users u ON u.id = t.assignee_user_id AND u.business_id = p.business_id
  LEFT JOIN parties party ON party.id = t.party_id AND party.business_id = p.business_id
  LEFT JOIN workspace_project_phases ph ON ph.id = t.phase_id`;

type TaskRow = Record<string, unknown>;

function toTask(row: TaskRow): WorkspaceTask {
  const r = row as Record<string, string | number | null>;
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    projectName: String(r.project_name ?? ""),
    title: String(r.title ?? ""),
    description: String(r.description ?? ""),
    status: r.status as WorkspaceTaskStatus,
    priority: (r.priority ?? "normal") as WorkspacePriority,
    assigneeUserId: (r.assignee_user_id as string | null) ?? null,
    assigneeName: (r.assignee_name as string | null) ?? null,
    dueDate: isoDate(r.due_date),
    partyId: (r.party_id as string | null) ?? null,
    partyName: (r.party_name as string | null) ?? null,
    phaseId: (r.phase_id as string | null) ?? null,
    phaseName: (r.phase_name as string | null) ?? null,
    position: Number(r.position ?? 0),
    source: r.source === "ai" ? "ai" : "user",
    createdAt: String(r.created_at),
    completedAt: (r.completed_at as string | null) ?? null,
    updatedAt: String(r.updated_at),
    checklistTotal: Number(r.checklist_total ?? 0),
    checklistDone: Number(r.checklist_done ?? 0),
    commentCount: Number(r.comment_count ?? 0),
    documentCount: Number(r.document_count ?? 0),
    blockedBy: Number(r.blocked_by ?? 0),
  };
}

export interface TaskListFilter {
  projectId?: string;
  assigneeUserId?: string;
  status?: WorkspaceTaskStatus | "open_only" | "all";
  priority?: WorkspacePriority;
  phaseId?: string;
  dueBefore?: string;
  dueAfter?: string;
  search?: string;
  limit?: number;
}

/** The workspace-wide task read behind the List, Kanban and Calendar views —
 *  the three are the same rows grouped differently, never three queries. */
export async function listWorkspaceTasks(
  businessId: string,
  filter: TaskListFilter = {},
): Promise<WorkspaceTask[]> {
  const where: string[] = ["p.business_id = $1"];
  const params: unknown[] = [businessId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };
  if (filter.projectId) add("t.project_id = $?", filter.projectId);
  if (filter.assigneeUserId) add("t.assignee_user_id = $?", filter.assigneeUserId);
  if (filter.status === "open_only") where.push("t.status <> 'done'");
  else if (filter.status && filter.status !== "all") add("t.status = $?", filter.status);
  if (filter.priority) add("t.priority = $?", filter.priority);
  if (filter.phaseId) add("t.phase_id = $?", filter.phaseId);
  if (filter.dueBefore) add("t.due_date <= $?", filter.dueBefore);
  if (filter.dueAfter) add("t.due_date >= $?", filter.dueAfter);
  if (filter.search) add("t.title ILIKE '%' || $? || '%'", filter.search.trim());
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);

  const { rows } = await query<TaskRow>(
    `SELECT ${TASK_SELECT} ${TASK_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY (t.status = 'done'),
               CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               t.due_date NULLS LAST, t.position, t.created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(toTask);
}

export async function getWorkspaceTask(
  businessId: string,
  taskId: string,
): Promise<WorkspaceTask | null> {
  const { rows } = await query<TaskRow>(
    `SELECT ${TASK_SELECT} ${TASK_JOINS} WHERE t.id = $2 AND p.business_id = $1`,
    [businessId, taskId],
  );
  return rows[0] ? toTask(rows[0]) : null;
}

export interface TaskInput {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeUserId?: string | null;
  dueDate?: unknown;
  partyId?: string | null;
  phaseId?: string | null;
  position?: number;
}

export async function createWorkspaceTask(
  owner: WorkspaceOwner,
  projectId: string,
  input: TaskInput,
): Promise<WorkspaceTask> {
  const title = requireText(input.title, WORKSPACE_LIMITS.taskTitleMax, "task_title_required");
  const status = assertEnum(input.status ?? "open", TASK_STATUSES, "invalid_task_status");
  const priority = assertEnum(input.priority ?? "normal", PRIORITIES, "invalid_priority");
  await assertUserBelongs(owner.businessId, input.assigneeUserId ?? null);
  await assertPartyBelongs(owner.businessId, input.partyId ?? null);

  const { rows } = await query<{ id: string }>(
    `INSERT INTO ai_project_tasks
       (project_id, title, description, status, priority, assignee_user_id, due_date,
        party_id, phase_id, position, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             COALESCE($10, (SELECT COALESCE(max(position), 0) + 1 FROM ai_project_tasks WHERE project_id = $1)),
             'user', $11)
     RETURNING id`,
    [
      projectId, title, trimTo(input.description, WORKSPACE_LIMITS.taskDescriptionMax),
      status, priority, input.assigneeUserId ?? null,
      isoDateOrNull(input.dueDate, "invalid_date"), input.partyId ?? null,
      input.phaseId ?? null, input.position ?? null, owner.actorUserId,
    ],
  );
  await recordActivity(owner, {
    projectId, subjectType: "task", subjectId: rows[0].id, action: "created", summary: title,
  });
  const created = await getWorkspaceTask(owner.businessId, rows[0].id);
  if (!created) throw new WorkspaceError("task_not_found");
  return created;
}

export async function updateWorkspaceTask(
  owner: WorkspaceOwner,
  taskId: string,
  input: TaskInput,
): Promise<WorkspaceTask | null> {
  const existing = await getWorkspaceTask(owner.businessId, taskId);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [taskId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.title !== undefined) {
    set("title", requireText(input.title, WORKSPACE_LIMITS.taskTitleMax, "task_title_required"));
  }
  if (input.description !== undefined) {
    set("description", trimTo(input.description, WORKSPACE_LIMITS.taskDescriptionMax));
  }
  if (input.status !== undefined) {
    const status = assertEnum(input.status, TASK_STATUSES, "invalid_task_status");
    set("status", status);
    // completed_at is derived from the status, never set by the caller: a
    // "done" with no stamp (or a stamp on a reopened task) is how a
    // completion report starts lying.
    sets.push(status === "done" ? "completed_at = COALESCE(completed_at, now())" : "completed_at = NULL");
  }
  if (input.priority !== undefined) {
    set("priority", assertEnum(input.priority, PRIORITIES, "invalid_priority"));
  }
  if (input.assigneeUserId !== undefined) {
    await assertUserBelongs(owner.businessId, input.assigneeUserId);
    set("assignee_user_id", input.assigneeUserId);
  }
  if (input.dueDate !== undefined) set("due_date", isoDateOrNull(input.dueDate, "invalid_date"));
  if (input.partyId !== undefined) {
    await assertPartyBelongs(owner.businessId, input.partyId);
    set("party_id", input.partyId);
  }
  if (input.phaseId !== undefined) set("phase_id", input.phaseId);
  if (input.position !== undefined) set("position", input.position);
  if (!sets.length) return existing;

  await query(
    `UPDATE ai_project_tasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    params,
  );
  await recordActivity(owner, {
    projectId: existing.projectId, subjectType: "task", subjectId: taskId,
    action: input.status ? `status_${input.status}` : "updated", summary: existing.title,
  });
  return getWorkspaceTask(owner.businessId, taskId);
}

export async function deleteWorkspaceTask(businessId: string, taskId: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM ai_project_tasks t
      USING ai_projects p
      WHERE t.id = $1 AND p.id = t.project_id AND p.business_id = $2`,
    [taskId, businessId],
  );
  return (rowCount ?? 0) > 0;
}

/* --- checklist --------------------------------------------------------- */

export interface ChecklistItem {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  displayOrder: number;
}

export async function listChecklist(taskId: string): Promise<ChecklistItem[]> {
  const { rows } = await query<{
    id: string; task_id: string; title: string; done: boolean; display_order: number;
  }>(
    `SELECT id, task_id, title, done, display_order FROM workspace_task_checklist
      WHERE task_id = $1 ORDER BY display_order, created_at`,
    [taskId],
  );
  return rows.map((r) => ({
    id: r.id, taskId: r.task_id, title: r.title, done: r.done, displayOrder: r.display_order,
  }));
}

export async function addChecklistItem(taskId: string, title: string): Promise<ChecklistItem[]> {
  const text = requireText(title, WORKSPACE_LIMITS.checklistTitleMax, "checklist_title_required");
  await query(
    `INSERT INTO workspace_task_checklist (task_id, title, display_order)
     VALUES ($1, $2, (SELECT COALESCE(max(display_order), -1) + 1
                        FROM workspace_task_checklist WHERE task_id = $1))`,
    [taskId, text],
  );
  return listChecklist(taskId);
}

export async function setChecklistItem(
  taskId: string,
  itemId: string,
  done: boolean,
): Promise<ChecklistItem[]> {
  await query(`UPDATE workspace_task_checklist SET done = $3 WHERE id = $1 AND task_id = $2`, [
    itemId, taskId, done,
  ]);
  return listChecklist(taskId);
}

export async function deleteChecklistItem(taskId: string, itemId: string): Promise<ChecklistItem[]> {
  await query(`DELETE FROM workspace_task_checklist WHERE id = $1 AND task_id = $2`, [itemId, taskId]);
  return listChecklist(taskId);
}

/* --- dependencies ------------------------------------------------------ */

export interface TaskDependency {
  id: string;
  taskId: string;
  dependsOnId: string;
  dependsOnTitle: string;
  dependsOnStatus: WorkspaceTaskStatus;
}

export async function listDependencies(taskId: string): Promise<TaskDependency[]> {
  const { rows } = await query<{
    id: string; task_id: string; depends_on_id: string; title: string; status: string;
  }>(
    `SELECT d.id, d.task_id, d.depends_on_id, t.title, t.status
       FROM workspace_task_dependencies d
       JOIN ai_project_tasks t ON t.id = d.depends_on_id
      WHERE d.task_id = $1
      ORDER BY t.title`,
    [taskId],
  );
  return rows.map((r) => ({
    id: r.id, taskId: r.task_id, dependsOnId: r.depends_on_id,
    dependsOnTitle: r.title, dependsOnStatus: r.status as WorkspaceTaskStatus,
  }));
}

/**
 * Adds "this task waits on that one", refusing anything that would close a
 * cycle. The DB CHECK stops only a self-edge; A→B→C→A is caught here, before
 * the write, by walking the project's existing edge list.
 */
export async function addDependency(
  businessId: string,
  taskId: string,
  dependsOnId: string,
): Promise<TaskDependency[]> {
  const task = await getWorkspaceTask(businessId, taskId);
  const other = await getWorkspaceTask(businessId, dependsOnId);
  if (!task || !other) throw new WorkspaceError("task_not_found");
  if (task.projectId !== other.projectId) throw new WorkspaceError("dependency_across_projects");

  const { rows: edges } = await query<{ task_id: string; depends_on_id: string }>(
    `SELECT d.task_id, d.depends_on_id
       FROM workspace_task_dependencies d
       JOIN ai_project_tasks t ON t.id = d.task_id
      WHERE t.project_id = $1`,
    [task.projectId],
  );
  const asPairs = edges.map((e) => ({ taskId: e.task_id, dependsOnId: e.depends_on_id }));
  if (wouldCreateDependencyCycle(asPairs, taskId, dependsOnId)) {
    throw new WorkspaceError("dependency_cycle");
  }

  await query(
    `INSERT INTO workspace_task_dependencies (task_id, depends_on_id)
     VALUES ($1, $2) ON CONFLICT (task_id, depends_on_id) DO NOTHING`,
    [taskId, dependsOnId],
  );
  return listDependencies(taskId);
}

export async function removeDependency(taskId: string, dependsOnId: string): Promise<TaskDependency[]> {
  await query(
    `DELETE FROM workspace_task_dependencies WHERE task_id = $1 AND depends_on_id = $2`,
    [taskId, dependsOnId],
  );
  return listDependencies(taskId);
}

/* ===========================================================================
 * Contracts
 * ======================================================================== */

export interface WorkspaceContract {
  id: string;
  projectId: string | null;
  projectName: string | null;
  partyId: string | null;
  partyName: string | null;
  title: string;
  contractType: WorkspaceContractType;
  valueRial: number | null;
  startDate: string | null;
  endDate: string | null;
  status: WorkspaceContractStatus;
  reminderDays: number | null;
  notes: string;
  documentCount: number;
  approvalStatus: WorkspaceApprovalStatus | null;
  createdAt: string;
  updatedAt: string;
}

const CONTRACT_SELECT = `
  c.id, c.project_id, p.name AS project_name, c.party_id, party.name AS party_name,
  c.title, c.contract_type, c.value_rial, c.start_date, c.end_date, c.status,
  c.reminder_days, c.notes, c.created_at, c.updated_at,
  (SELECT count(*) FROM workspace_documents d WHERE d.contract_id = c.id) AS document_count,
  (SELECT a.status FROM workspace_approvals a
    WHERE a.subject_type = 'contract' AND a.subject_id = c.id
    ORDER BY a.created_at DESC LIMIT 1) AS approval_status`;

const CONTRACT_JOINS = `
  FROM workspace_contracts c
  LEFT JOIN ai_projects p ON p.id = c.project_id
  LEFT JOIN parties party ON party.id = c.party_id`;

function toContract(row: Record<string, unknown>): WorkspaceContract {
  const r = row as Record<string, string | number | null>;
  return {
    id: String(r.id),
    projectId: (r.project_id as string | null) ?? null,
    projectName: (r.project_name as string | null) ?? null,
    partyId: (r.party_id as string | null) ?? null,
    partyName: (r.party_name as string | null) ?? null,
    title: String(r.title ?? ""),
    contractType: r.contract_type as WorkspaceContractType,
    valueRial: r.value_rial === null || r.value_rial === undefined ? null : Number(r.value_rial),
    startDate: isoDate(r.start_date),
    endDate: isoDate(r.end_date),
    status: r.status as WorkspaceContractStatus,
    reminderDays: r.reminder_days === null || r.reminder_days === undefined ? null : Number(r.reminder_days),
    notes: String(r.notes ?? ""),
    documentCount: Number(r.document_count ?? 0),
    approvalStatus: (r.approval_status as WorkspaceApprovalStatus | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export interface ContractListFilter {
  projectId?: string;
  partyId?: string;
  status?: WorkspaceContractStatus | "all";
  contractType?: WorkspaceContractType;
  /** Only contracts expiring within N days — the assistant's expiry question. */
  expiringWithinDays?: number;
  search?: string;
  limit?: number;
}

export async function listContracts(
  businessId: string,
  filter: ContractListFilter = {},
): Promise<WorkspaceContract[]> {
  const where: string[] = ["c.business_id = $1"];
  const params: unknown[] = [businessId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };
  if (filter.projectId) add("c.project_id = $?", filter.projectId);
  if (filter.partyId) add("c.party_id = $?", filter.partyId);
  if (filter.status && filter.status !== "all") add("c.status = $?", filter.status);
  if (filter.contractType) add("c.contract_type = $?", filter.contractType);
  if (filter.search) add("c.title ILIKE '%' || $? || '%'", filter.search.trim());
  if (filter.expiringWithinDays !== undefined) {
    add(
      "(c.end_date IS NOT NULL AND c.end_date <= (CURRENT_DATE + ($?::int || ' days')::interval) AND c.status NOT IN ('terminated','completed'))",
      filter.expiringWithinDays,
    );
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 300);

  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${CONTRACT_SELECT} ${CONTRACT_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY c.end_date NULLS LAST, c.created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(toContract);
}

export async function getContract(businessId: string, id: string): Promise<WorkspaceContract | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${CONTRACT_SELECT} ${CONTRACT_JOINS} WHERE c.id = $2 AND c.business_id = $1`,
    [businessId, id],
  );
  return rows[0] ? toContract(rows[0]) : null;
}

export interface ContractInput {
  title?: string;
  contractType?: string;
  projectId?: string | null;
  partyId?: string | null;
  valueRial?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  status?: string;
  reminderDays?: unknown;
  notes?: string;
}

export async function createContract(
  owner: WorkspaceOwner,
  input: ContractInput,
): Promise<WorkspaceContract> {
  const title = requireText(input.title, WORKSPACE_LIMITS.contractTitleMax, "contract_title_required");
  const contractType = assertEnum(input.contractType ?? "other", CONTRACT_TYPES, "invalid_contract_type");
  const status = assertEnum(input.status ?? "draft", CONTRACT_STATUSES, "invalid_contract_status");
  const startDate = isoDateOrNull(input.startDate, "invalid_date");
  const endDate = isoDateOrNull(input.endDate, "invalid_date");
  if (startDate && endDate && endDate < startDate) throw new WorkspaceError("end_before_start");
  await assertPartyBelongs(owner.businessId, input.partyId ?? null);
  if (input.projectId) await assertProjectBelongs(owner.businessId, input.projectId);

  const { rows } = await query<{ id: string }>(
    `INSERT INTO workspace_contracts
       (business_id, project_id, party_id, title, contract_type, value_rial,
        start_date, end_date, status, reminder_days, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      owner.businessId, input.projectId ?? null, input.partyId ?? null, title, contractType,
      numberOrNull(input.valueRial, "invalid_contract_value"), startDate, endDate, status,
      numberOrNull(input.reminderDays, "invalid_reminder_days"),
      trimTo(input.notes, 2000), owner.actorUserId,
    ],
  );
  await recordActivity(owner, {
    projectId: input.projectId ?? null, subjectType: "contract", subjectId: rows[0].id,
    action: "created", summary: title,
  });
  const created = await getContract(owner.businessId, rows[0].id);
  if (!created) throw new WorkspaceError("contract_not_found");
  return created;
}

export async function updateContract(
  owner: WorkspaceOwner,
  id: string,
  input: ContractInput,
): Promise<WorkspaceContract | null> {
  const existing = await getContract(owner.businessId, id);
  if (!existing) return null;
  const sets: string[] = [];
  const params: unknown[] = [id, owner.businessId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.title !== undefined) {
    set("title", requireText(input.title, WORKSPACE_LIMITS.contractTitleMax, "contract_title_required"));
  }
  if (input.contractType !== undefined) {
    set("contract_type", assertEnum(input.contractType, CONTRACT_TYPES, "invalid_contract_type"));
  }
  if (input.status !== undefined) {
    set("status", assertEnum(input.status, CONTRACT_STATUSES, "invalid_contract_status"));
  }
  if (input.projectId !== undefined) {
    if (input.projectId) await assertProjectBelongs(owner.businessId, input.projectId);
    set("project_id", input.projectId);
  }
  if (input.partyId !== undefined) {
    await assertPartyBelongs(owner.businessId, input.partyId);
    set("party_id", input.partyId);
  }
  if (input.valueRial !== undefined) set("value_rial", numberOrNull(input.valueRial, "invalid_contract_value"));
  if (input.startDate !== undefined) set("start_date", isoDateOrNull(input.startDate, "invalid_date"));
  if (input.endDate !== undefined) set("end_date", isoDateOrNull(input.endDate, "invalid_date"));
  if (input.reminderDays !== undefined) {
    set("reminder_days", numberOrNull(input.reminderDays, "invalid_reminder_days"));
  }
  if (input.notes !== undefined) set("notes", trimTo(input.notes, 2000));
  if (!sets.length) return existing;

  await query(
    `UPDATE workspace_contracts SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $1 AND business_id = $2`,
    params,
  );
  await recordActivity(owner, {
    projectId: existing.projectId, subjectType: "contract", subjectId: id,
    action: "updated", summary: existing.title,
  });
  return getContract(owner.businessId, id);
}

export async function deleteContract(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM workspace_contracts WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );
  return (rowCount ?? 0) > 0;
}

async function assertProjectBelongs(businessId: string, projectId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM ai_projects WHERE id = $1 AND business_id = $2`,
    [projectId, businessId],
  );
  if (!rows[0]) throw new WorkspaceError("project_not_found");
}

/* ===========================================================================
 * Documents
 * ======================================================================== */

export interface WorkspaceDocument {
  id: string;
  title: string;
  description: string;
  mediaAssetId: string | null;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  contractId: string | null;
  contractTitle: string | null;
  partyId: string | null;
  partyName: string | null;
  journalEntryId: string | null;
  status: WorkspaceDocumentStatus;
  version: number;
  supersedesId: string | null;
  /** True when no other document supersedes this one — the current revision. */
  isCurrent: boolean;
  tags: string[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

const DOCUMENT_SELECT = `
  d.id, d.title, d.description, d.media_asset_id, ma.file_name, ma.mime_type, ma.byte_size,
  d.project_id, p.name AS project_name, d.task_id, d.contract_id, c.title AS contract_title,
  d.party_id, party.name AS party_name, d.journal_entry_id,
  d.status, d.version, d.supersedes_id, d.tags, d.created_at, d.updated_at,
  NOT EXISTS (SELECT 1 FROM workspace_documents s WHERE s.supersedes_id = d.id) AS is_current,
  (SELECT count(*) FROM workspace_comments wc WHERE wc.subject_type = 'document' AND wc.subject_id = d.id) AS comment_count`;

const DOCUMENT_JOINS = `
  FROM workspace_documents d
  LEFT JOIN media_assets ma ON ma.id = d.media_asset_id
  LEFT JOIN ai_projects p ON p.id = d.project_id
  LEFT JOIN workspace_contracts c ON c.id = d.contract_id
  LEFT JOIN parties party ON party.id = d.party_id`;

function toDocument(row: Record<string, unknown>): WorkspaceDocument {
  const r = row as Record<string, string | number | boolean | string[] | null>;
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    description: String(r.description ?? ""),
    mediaAssetId: (r.media_asset_id as string | null) ?? null,
    fileName: (r.file_name as string | null) ?? null,
    mimeType: (r.mime_type as string | null) ?? null,
    byteSize: r.byte_size === null || r.byte_size === undefined ? null : Number(r.byte_size),
    projectId: (r.project_id as string | null) ?? null,
    projectName: (r.project_name as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    contractId: (r.contract_id as string | null) ?? null,
    contractTitle: (r.contract_title as string | null) ?? null,
    partyId: (r.party_id as string | null) ?? null,
    partyName: (r.party_name as string | null) ?? null,
    journalEntryId: (r.journal_entry_id as string | null) ?? null,
    status: r.status as WorkspaceDocumentStatus,
    version: Number(r.version ?? 1),
    supersedesId: (r.supersedes_id as string | null) ?? null,
    isCurrent: r.is_current !== false,
    tags: (r.tags as string[] | null) ?? [],
    commentCount: Number(r.comment_count ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export interface DocumentListFilter {
  projectId?: string;
  taskId?: string;
  contractId?: string;
  partyId?: string;
  status?: WorkspaceDocumentStatus | "all";
  /** Hide superseded revisions — the default the documents list wants. */
  currentOnly?: boolean;
  search?: string;
  limit?: number;
}

export async function listDocuments(
  businessId: string,
  filter: DocumentListFilter = {},
): Promise<WorkspaceDocument[]> {
  const where: string[] = ["d.business_id = $1"];
  const params: unknown[] = [businessId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };
  if (filter.projectId) add("d.project_id = $?", filter.projectId);
  if (filter.taskId) add("d.task_id = $?", filter.taskId);
  if (filter.contractId) add("d.contract_id = $?", filter.contractId);
  if (filter.partyId) add("d.party_id = $?", filter.partyId);
  if (filter.status && filter.status !== "all") add("d.status = $?", filter.status);
  if (filter.search) add("d.title ILIKE '%' || $? || '%'", filter.search.trim());
  if (filter.currentOnly !== false) {
    where.push("NOT EXISTS (SELECT 1 FROM workspace_documents s WHERE s.supersedes_id = d.id)");
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 300);

  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${DOCUMENT_SELECT} ${DOCUMENT_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY d.created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(toDocument);
}

export async function getDocument(businessId: string, id: string): Promise<WorkspaceDocument | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${DOCUMENT_SELECT} ${DOCUMENT_JOINS} WHERE d.id = $2 AND d.business_id = $1`,
    [businessId, id],
  );
  return rows[0] ? toDocument(rows[0]) : null;
}

/** A document's full revision chain, newest version first. */
export async function listDocumentVersions(
  businessId: string,
  id: string,
): Promise<WorkspaceDocument[]> {
  // Two walks, not one: Postgres allows a recursive CTE exactly one recursive
  // term, and a version chain has to be followed in BOTH directions from the
  // document the caller named — backwards to its ancestors (`supersedes_id`)
  // and forwards to the revisions made after it. So `ancestors` and
  // `descendants` are separate CTEs whose results are unioned.
  const { rows } = await query<Record<string, unknown>>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, supersedes_id FROM workspace_documents
        WHERE id = $2 AND business_id = $1
       UNION ALL
       SELECT d.id, d.supersedes_id FROM workspace_documents d
         JOIN ancestors a ON d.id = a.supersedes_id
        WHERE d.business_id = $1
     ), descendants AS (
       SELECT id FROM workspace_documents WHERE id = $2 AND business_id = $1
       UNION ALL
       SELECT d.id FROM workspace_documents d
         JOIN descendants c ON d.supersedes_id = c.id
        WHERE d.business_id = $1
     )
     SELECT ${DOCUMENT_SELECT} ${DOCUMENT_JOINS}
      WHERE d.business_id = $1
        AND (d.id IN (SELECT id FROM ancestors) OR d.id IN (SELECT id FROM descendants))
      ORDER BY d.version DESC`,
    [businessId, id],
  );
  return rows.map(toDocument);
}

export interface DocumentInput {
  title?: string;
  description?: string;
  mediaAssetId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  contractId?: string | null;
  partyId?: string | null;
  journalEntryId?: string | null;
  status?: string;
  tags?: unknown;
  /** Set to make this the next revision of an existing document. */
  supersedesId?: string | null;
}

export async function createDocument(
  owner: WorkspaceOwner,
  input: DocumentInput,
): Promise<WorkspaceDocument> {
  const title = requireText(input.title, WORKSPACE_LIMITS.documentTitleMax, "document_title_required");
  const status = assertEnum(input.status ?? "draft", DOCUMENT_STATUSES, "invalid_document_status");
  if (input.projectId) await assertProjectBelongs(owner.businessId, input.projectId);
  await assertPartyBelongs(owner.businessId, input.partyId ?? null);

  // A new revision inherits its predecessor's version number plus one, so the
  // chain reads v1, v2, v3 without the caller having to count.
  let version = 1;
  if (input.supersedesId) {
    const previous = await getDocument(owner.businessId, input.supersedesId);
    if (!previous) throw new WorkspaceError("document_not_found");
    version = previous.version + 1;
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO workspace_documents
       (business_id, media_asset_id, title, description, project_id, task_id,
        contract_id, party_id, journal_entry_id, status, version, supersedes_id, tags, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      owner.businessId, input.mediaAssetId ?? null, title,
      trimTo(input.description, 2000), input.projectId ?? null, input.taskId ?? null,
      input.contractId ?? null, input.partyId ?? null, input.journalEntryId ?? null,
      status, version, input.supersedesId ?? null, normalizeTags(input.tags), owner.actorUserId,
    ],
  );
  await recordActivity(owner, {
    projectId: input.projectId ?? null, subjectType: "document", subjectId: rows[0].id,
    action: version > 1 ? "revised" : "created", summary: title,
  });
  const created = await getDocument(owner.businessId, rows[0].id);
  if (!created) throw new WorkspaceError("document_not_found");
  return created;
}

export async function updateDocument(
  owner: WorkspaceOwner,
  id: string,
  input: DocumentInput,
): Promise<WorkspaceDocument | null> {
  const existing = await getDocument(owner.businessId, id);
  if (!existing) return null;
  const sets: string[] = [];
  const params: unknown[] = [id, owner.businessId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.title !== undefined) {
    set("title", requireText(input.title, WORKSPACE_LIMITS.documentTitleMax, "document_title_required"));
  }
  if (input.description !== undefined) set("description", trimTo(input.description, 2000));
  if (input.status !== undefined) {
    set("status", assertEnum(input.status, DOCUMENT_STATUSES, "invalid_document_status"));
  }
  if (input.projectId !== undefined) {
    if (input.projectId) await assertProjectBelongs(owner.businessId, input.projectId);
    set("project_id", input.projectId);
  }
  if (input.taskId !== undefined) set("task_id", input.taskId);
  if (input.contractId !== undefined) set("contract_id", input.contractId);
  if (input.partyId !== undefined) {
    await assertPartyBelongs(owner.businessId, input.partyId);
    set("party_id", input.partyId);
  }
  if (input.journalEntryId !== undefined) set("journal_entry_id", input.journalEntryId);
  if (input.tags !== undefined) set("tags", normalizeTags(input.tags));
  if (input.mediaAssetId !== undefined) set("media_asset_id", input.mediaAssetId);
  if (!sets.length) return existing;

  await query(
    `UPDATE workspace_documents SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $1 AND business_id = $2`,
    params,
  );
  return getDocument(owner.businessId, id);
}

export async function deleteDocument(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM workspace_documents WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );
  return (rowCount ?? 0) > 0;
}

/* ===========================================================================
 * Approvals
 * ======================================================================== */

export interface WorkspaceApproval {
  id: string;
  subjectType: WorkspaceApprovalSubject;
  subjectId: string;
  subjectTitle: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  status: WorkspaceApprovalStatus;
  requestedBy: string | null;
  requestedByName: string | null;
  approverUserId: string | null;
  approverName: string | null;
  dueDate: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string;
  createdAt: string;
}

/**
 * The subject's own title, resolved in SQL so the list does not need a second
 * round trip per row. A CASE over four tables rather than a stored copy: a
 * copied title is wrong the moment the contract is renamed.
 */
const APPROVAL_SELECT = `
  a.id, a.subject_type, a.subject_id, a.project_id, p.name AS project_name,
  a.title, a.status, a.requested_by, ru.full_name AS requested_by_name,
  a.approver_user_id, au.full_name AS approver_name, a.due_date,
  a.decided_by, a.decided_at, a.note, a.created_at,
  COALESCE(
    CASE a.subject_type
      WHEN 'project'  THEN (SELECT name  FROM ai_projects         WHERE id = a.subject_id)
      WHEN 'task'     THEN (SELECT title FROM ai_project_tasks    WHERE id = a.subject_id)
      WHEN 'document' THEN (SELECT title FROM workspace_documents WHERE id = a.subject_id)
      WHEN 'contract' THEN (SELECT title FROM workspace_contracts WHERE id = a.subject_id)
    END, a.title, '') AS subject_title`;

const APPROVAL_JOINS = `
  FROM workspace_approvals a
  LEFT JOIN ai_projects p ON p.id = a.project_id
  LEFT JOIN users ru ON ru.id = a.requested_by
  LEFT JOIN users au ON au.id = a.approver_user_id`;

function toApproval(row: Record<string, unknown>): WorkspaceApproval {
  const r = row as Record<string, string | null>;
  return {
    id: String(r.id),
    subjectType: r.subject_type as WorkspaceApprovalSubject,
    subjectId: String(r.subject_id),
    subjectTitle: String(r.subject_title ?? ""),
    projectId: r.project_id ?? null,
    projectName: r.project_name ?? null,
    title: String(r.title ?? ""),
    status: r.status as WorkspaceApprovalStatus,
    requestedBy: r.requested_by ?? null,
    requestedByName: r.requested_by_name ?? null,
    approverUserId: r.approver_user_id ?? null,
    approverName: r.approver_name ?? null,
    dueDate: isoDate(r.due_date),
    decidedBy: r.decided_by ?? null,
    decidedAt: r.decided_at ?? null,
    note: String(r.note ?? ""),
    createdAt: String(r.created_at),
  };
}

export interface ApprovalListFilter {
  status?: WorkspaceApprovalStatus | "all";
  projectId?: string;
  approverUserId?: string;
  subjectType?: WorkspaceApprovalSubject;
  subjectId?: string;
  limit?: number;
}

export async function listApprovals(
  businessId: string,
  filter: ApprovalListFilter = {},
): Promise<WorkspaceApproval[]> {
  const where: string[] = ["a.business_id = $1"];
  const params: unknown[] = [businessId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };
  if (filter.status && filter.status !== "all") add("a.status = $?", filter.status);
  if (filter.projectId) add("a.project_id = $?", filter.projectId);
  if (filter.subjectType) add("a.subject_type = $?", filter.subjectType);
  if (filter.subjectId) add("a.subject_id = $?", filter.subjectId);
  if (filter.approverUserId) {
    // A pending approval with no named approver is everybody's to decide, so
    // the "mine" filter has to include it — otherwise unassigned requests sit
    // in a queue nobody sees.
    add("(a.approver_user_id = $? OR a.approver_user_id IS NULL)", filter.approverUserId);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 300);

  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${APPROVAL_SELECT} ${APPROVAL_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY (a.status = 'pending') DESC, a.due_date NULLS LAST, a.created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(toApproval);
}

export async function requestApproval(
  owner: WorkspaceOwner,
  input: {
    subjectType?: string; subjectId?: string; projectId?: string | null;
    title?: string; approverUserId?: string | null; dueDate?: unknown; note?: string;
  },
): Promise<WorkspaceApproval> {
  const subjectType = assertEnum(input.subjectType ?? "", ["project", "task", "document", "contract"] as const, "invalid_approval_subject");
  const subjectId = input.subjectId?.trim();
  if (!subjectId) throw new WorkspaceError("subject_required");
  await assertUserBelongs(owner.businessId, input.approverUserId ?? null);

  const { rows } = await query<{ id: string }>(
    `INSERT INTO workspace_approvals
       (business_id, subject_type, subject_id, project_id, title, requested_by,
        approver_user_id, due_date, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      owner.businessId, subjectType, subjectId, input.projectId ?? null,
      trimTo(input.title, 200), owner.actorUserId, input.approverUserId ?? null,
      isoDateOrNull(input.dueDate, "invalid_date"), trimTo(input.note, 1000),
    ],
  );
  // A contract put up for approval moves to `pending_approval` so the
  // contracts list shows the same truth as the approvals queue.
  if (subjectType === "contract") {
    await query(
      `UPDATE workspace_contracts SET status = 'pending_approval', updated_at = now()
        WHERE id = $1 AND business_id = $2 AND status = 'draft'`,
      [subjectId, owner.businessId],
    );
  }
  if (subjectType === "document") {
    await query(
      `UPDATE workspace_documents SET status = 'in_review', updated_at = now()
        WHERE id = $1 AND business_id = $2 AND status = 'draft'`,
      [subjectId, owner.businessId],
    );
  }
  await recordActivity(owner, {
    projectId: input.projectId ?? null, subjectType: "approval", subjectId: rows[0].id,
    action: "requested", summary: trimTo(input.title, 200),
  });
  const list = await listApprovals(owner.businessId, { subjectType, subjectId, limit: 1 });
  const created = list[0];
  if (!created) throw new WorkspaceError("approval_not_found");
  return created;
}

/**
 * Records a decision and propagates it to the subject: approving a contract
 * activates it, rejecting a document marks it rejected. The propagation is the
 * whole point of the gate — an approval that changes nothing is a comment.
 */
export async function decideApproval(
  owner: WorkspaceOwner,
  id: string,
  decision: "approved" | "rejected" | "cancelled",
  note?: string,
): Promise<WorkspaceApproval | null> {
  const { rows } = await query<{ subject_type: string; subject_id: string; project_id: string | null }>(
    `UPDATE workspace_approvals
        SET status = $3, decided_by = $4, decided_at = now(),
            note = COALESCE(NULLIF($5, ''), note), updated_at = now()
      WHERE id = $1 AND business_id = $2 AND status = 'pending'
      RETURNING subject_type, subject_id, project_id`,
    [id, owner.businessId, decision, owner.actorUserId, trimTo(note, 1000)],
  );
  const decided = rows[0];
  if (!decided) return null;

  if (decided.subject_type === "contract") {
    if (decision === "approved") {
      await query(
        `UPDATE workspace_contracts SET status = 'active', updated_at = now()
          WHERE id = $1 AND business_id = $2 AND status = 'pending_approval'`,
        [decided.subject_id, owner.businessId],
      );
    } else if (decision === "rejected") {
      await query(
        `UPDATE workspace_contracts SET status = 'draft', updated_at = now()
          WHERE id = $1 AND business_id = $2 AND status = 'pending_approval'`,
        [decided.subject_id, owner.businessId],
      );
    }
  }
  if (decided.subject_type === "document" && decision !== "cancelled") {
    await query(
      `UPDATE workspace_documents SET status = $3, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND status = 'in_review'`,
      [decided.subject_id, owner.businessId, decision === "approved" ? "approved" : "rejected"],
    );
  }
  await recordActivity(owner, {
    projectId: decided.project_id, subjectType: "approval", subjectId: id,
    action: decision, summary: "",
  });
  const list = await listApprovals(owner.businessId, {
    subjectType: decided.subject_type as WorkspaceApprovalSubject,
    subjectId: decided.subject_id,
    limit: 1,
  });
  return list[0] ?? null;
}

/* ===========================================================================
 * Calendar
 * ======================================================================== */

export interface CalendarEntry {
  id: string;
  source: "event" | "project_deadline" | "task_due" | "contract_expiry" | "approval_due";
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  kind: WorkspaceEventKind | null;
  projectId: string | null;
  projectName: string | null;
  /** The row this entry points at, so the calendar can link to its page. */
  refId: string;
  location: string;
}

/**
 * The unified calendar: one stored source (`workspace_events`) unioned with
 * four derived ones. Every date already lives on a row that owns it, so the
 * calendar reads them rather than keeping copies — rescheduling a task moves
 * its calendar entry because they are the same fact.
 */
export async function listCalendar(
  businessId: string,
  range: { from: string; to: string; projectId?: string },
): Promise<CalendarEntry[]> {
  const projectFilter = range.projectId ? " AND project_id = $4" : "";
  const params: unknown[] = [businessId, range.from, range.to];
  if (range.projectId) params.push(range.projectId);

  const { rows } = await query<Record<string, unknown>>(
    `SELECT id::text AS id, 'event' AS source, title, event_date::text AS date,
            start_time::text AS start_time, end_time::text AS end_time, kind,
            project_id, (SELECT name FROM ai_projects WHERE id = e.project_id) AS project_name,
            id::text AS ref_id, location
       FROM workspace_events e
      WHERE business_id = $1 AND event_date BETWEEN $2 AND $3${projectFilter}

      UNION ALL

     SELECT p.id::text, 'project_deadline', p.name, p.end_date::text, NULL, NULL, NULL,
            p.id, p.name, p.id::text, ''
       FROM ai_projects p
      WHERE p.business_id = $1 AND p.archived_at IS NULL
        AND p.end_date BETWEEN $2 AND $3
        AND p.status NOT IN ('completed', 'cancelled')
        ${range.projectId ? "AND p.id = $4" : ""}

      UNION ALL

     SELECT t.id::text, 'task_due', t.title, t.due_date::text, NULL, NULL, NULL,
            t.project_id, p.name, t.id::text, ''
       FROM ai_project_tasks t
       JOIN ai_projects p ON p.id = t.project_id
      WHERE p.business_id = $1 AND t.status <> 'done'
        AND t.due_date BETWEEN $2 AND $3
        ${range.projectId ? "AND t.project_id = $4" : ""}

      UNION ALL

     SELECT c.id::text, 'contract_expiry', c.title, c.end_date::text, NULL, NULL, NULL,
            c.project_id, p.name, c.id::text, ''
       FROM workspace_contracts c
       LEFT JOIN ai_projects p ON p.id = c.project_id
      WHERE c.business_id = $1 AND c.status NOT IN ('terminated', 'completed')
        AND c.end_date BETWEEN $2 AND $3
        ${range.projectId ? "AND c.project_id = $4" : ""}

      UNION ALL

     SELECT a.id::text, 'approval_due', COALESCE(NULLIF(a.title, ''), 'تأیید'), a.due_date::text,
            NULL, NULL, NULL, a.project_id, p.name, a.id::text, ''
       FROM workspace_approvals a
       LEFT JOIN ai_projects p ON p.id = a.project_id
      WHERE a.business_id = $1 AND a.status = 'pending'
        AND a.due_date BETWEEN $2 AND $3
        ${range.projectId ? "AND a.project_id = $4" : ""}

      ORDER BY date, start_time NULLS FIRST`,
    params,
  );

  return rows.map((row) => {
    const r = row as Record<string, string | null>;
    return {
      id: `${r.source}:${r.id}`,
      source: r.source as CalendarEntry["source"],
      title: String(r.title ?? ""),
      date: isoDate(r.date) ?? "",
      startTime: r.start_time ? String(r.start_time).slice(0, 5) : null,
      endTime: r.end_time ? String(r.end_time).slice(0, 5) : null,
      kind: (r.kind as WorkspaceEventKind | null) ?? null,
      projectId: r.project_id ?? null,
      projectName: r.project_name ?? null,
      refId: String(r.ref_id),
      location: String(r.location ?? ""),
    };
  });
}

export async function createEvent(
  owner: WorkspaceOwner,
  input: {
    title?: string; description?: string; kind?: string; eventDate?: unknown;
    startTime?: string | null; endTime?: string | null; location?: string;
    projectId?: string | null; taskId?: string | null;
  },
): Promise<CalendarEntry[]> {
  const title = requireText(input.title, WORKSPACE_LIMITS.eventTitleMax, "event_title_required");
  const kind = assertEnum(input.kind ?? "meeting", EVENT_KINDS, "invalid_event_kind");
  const eventDate = isoDateOrNull(input.eventDate, "invalid_date");
  if (!eventDate) throw new WorkspaceError("event_date_required");
  if (input.projectId) await assertProjectBelongs(owner.businessId, input.projectId);

  await query(
    `INSERT INTO workspace_events
       (business_id, project_id, task_id, title, description, kind, event_date,
        start_time, end_time, location, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      owner.businessId, input.projectId ?? null, input.taskId ?? null, title,
      trimTo(input.description, 1000), kind, eventDate,
      input.startTime || null, input.endTime || null, trimTo(input.location, 200),
      owner.actorUserId,
    ],
  );
  await recordActivity(owner, {
    projectId: input.projectId ?? null, subjectType: "event", subjectId: null,
    action: "created", summary: title,
  });
  return listCalendar(owner.businessId, { from: eventDate, to: eventDate });
}

export async function deleteEvent(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM workspace_events WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );
  return (rowCount ?? 0) > 0;
}

/* ===========================================================================
 * Comments & activity
 * ======================================================================== */

export interface WorkspaceComment {
  id: string;
  subjectType: WorkspaceApprovalSubject;
  subjectId: string;
  body: string;
  authorId: string | null;
  authorName: string;
  createdAt: string;
}

export async function listComments(
  businessId: string,
  subjectType: WorkspaceApprovalSubject,
  subjectId: string,
): Promise<WorkspaceComment[]> {
  const { rows } = await query<{
    id: string; subject_type: string; subject_id: string; body: string;
    author_id: string | null; author_name: string; full_name: string | null; created_at: string;
  }>(
    `SELECT c.id, c.subject_type, c.subject_id, c.body, c.author_id, c.author_name,
            u.full_name, c.created_at
       FROM workspace_comments c
       LEFT JOIN users u ON u.id = c.author_id
      WHERE c.business_id = $1 AND c.subject_type = $2 AND c.subject_id = $3
      ORDER BY c.created_at`,
    [businessId, subjectType, subjectId],
  );
  return rows.map((r) => ({
    id: r.id,
    subjectType: r.subject_type as WorkspaceApprovalSubject,
    subjectId: r.subject_id,
    body: r.body,
    authorId: r.author_id,
    // The live user name wins over the stored one, which is the fallback for a
    // member who has since been removed.
    authorName: r.full_name ?? r.author_name ?? "—",
    createdAt: r.created_at,
  }));
}

export async function addComment(
  owner: WorkspaceOwner,
  subjectType: WorkspaceApprovalSubject,
  subjectId: string,
  body: string,
): Promise<WorkspaceComment[]> {
  const text = requireText(body, WORKSPACE_LIMITS.commentMax, "comment_required");
  await query(
    `INSERT INTO workspace_comments (business_id, subject_type, subject_id, body, author_id, author_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [owner.businessId, subjectType, subjectId, text, owner.actorUserId, owner.actorName ?? ""],
  );
  return listComments(owner.businessId, subjectType, subjectId);
}

export interface ActivityEntry {
  id: string;
  projectId: string | null;
  projectName: string | null;
  subjectType: string;
  subjectId: string | null;
  action: string;
  summary: string;
  actorName: string;
  createdAt: string;
}

/**
 * Writes one line to the workspace's own feed. Deliberately best-effort: a
 * failed activity write must never fail the business write that caused it,
 * because the feed is a convenience and the project record is not.
 */
export async function recordActivity(
  owner: WorkspaceOwner,
  entry: {
    projectId: string | null;
    subjectType: string;
    subjectId: string | null;
    action: string;
    summary: string;
  },
): Promise<void> {
  try {
    await query(
      `INSERT INTO workspace_activity
         (business_id, project_id, subject_type, subject_id, action, summary, actor_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        owner.businessId, entry.projectId, entry.subjectType, entry.subjectId,
        entry.action, entry.summary.slice(0, 300), owner.actorUserId, owner.actorName ?? "",
      ],
    );
  } catch {
    // Intentionally swallowed — see the doc comment.
  }
}

export async function listActivity(
  businessId: string,
  options: { projectId?: string; limit?: number } = {},
): Promise<ActivityEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const params: unknown[] = [businessId];
  let filter = "";
  if (options.projectId) {
    params.push(options.projectId);
    filter = " AND a.project_id = $2";
  }
  const { rows } = await query<{
    id: string; project_id: string | null; project_name: string | null;
    subject_type: string; subject_id: string | null; action: string;
    summary: string; actor_name: string; full_name: string | null; created_at: string;
  }>(
    `SELECT a.id, a.project_id, p.name AS project_name, a.subject_type, a.subject_id,
            a.action, a.summary, a.actor_name, u.full_name, a.created_at
       FROM workspace_activity a
       LEFT JOIN ai_projects p ON p.id = a.project_id
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.business_id = $1${filter}
      ORDER BY a.created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    action: r.action,
    summary: r.summary,
    actorName: r.full_name ?? r.actor_name ?? "—",
    createdAt: r.created_at,
  }));
}

/* ===========================================================================
 * Dashboard
 * ======================================================================== */

export interface WorkspaceDashboard {
  activeProjects: number;
  tasksToday: number;
  myOpenTasks: number;
  pendingApprovals: number;
  upcomingDeadlines: number;
  overdueTasks: number;
  expiringContracts: number;
  myTasks: WorkspaceTask[];
  deadlines: CalendarEntry[];
  approvals: WorkspaceApproval[];
  activity: ActivityEntry[];
}

/**
 * The «نمای کلی» screen in one round trip's worth of parallel reads. The four
 * headline numbers are the brief's — active projects, tasks today, pending
 * approvals, upcoming deadlines — and each is computed from the rows that own
 * the fact rather than from a counter that could drift.
 */
export async function getWorkspaceDashboard(
  businessId: string,
  userId: string,
  options: { horizonDays?: number } = {},
): Promise<WorkspaceDashboard> {
  const horizon = options.horizonDays ?? 14;
  // Tehran's calendar day, not UTC's. `toISOString()` would roll over at
  // 03:30 local, so between midnight and 03:30 «وظایف امروز» counted
  // tomorrow's tasks and dropped today's — the one window where a café's
  // closing shift is still working.
  const now = new Date();
  const today = isoDateInTimeZone(now) ?? postgresDateToIso(now);
  const horizonDate = new Date(now.getTime() + horizon * 86_400_000);
  const until = isoDateInTimeZone(horizonDate) ?? postgresDateToIso(horizonDate);

  const [counts, myTasks, deadlines, approvals, activity] = await Promise.all([
    query<{
      active_projects: string; tasks_today: string; my_open_tasks: string;
      pending_approvals: string; upcoming_deadlines: string; overdue_tasks: string;
      expiring_contracts: string;
    }>(
      `SELECT
         (SELECT count(*) FROM ai_projects
           WHERE business_id = $1 AND archived_at IS NULL AND status = 'active') AS active_projects,
         (SELECT count(*) FROM ai_project_tasks t JOIN ai_projects p ON p.id = t.project_id
           WHERE p.business_id = $1 AND t.status <> 'done' AND t.due_date = CURRENT_DATE) AS tasks_today,
         (SELECT count(*) FROM ai_project_tasks t JOIN ai_projects p ON p.id = t.project_id
           WHERE p.business_id = $1 AND t.status <> 'done' AND t.assignee_user_id = $2) AS my_open_tasks,
         (SELECT count(*) FROM workspace_approvals
           WHERE business_id = $1 AND status = 'pending') AS pending_approvals,
         (SELECT count(*) FROM ai_project_tasks t JOIN ai_projects p ON p.id = t.project_id
           WHERE p.business_id = $1 AND t.status <> 'done'
             AND t.due_date BETWEEN CURRENT_DATE AND $3::date) AS upcoming_deadlines,
         (SELECT count(*) FROM ai_project_tasks t JOIN ai_projects p ON p.id = t.project_id
           WHERE p.business_id = $1 AND t.status <> 'done' AND t.due_date < CURRENT_DATE) AS overdue_tasks,
         (SELECT count(*) FROM workspace_contracts
           WHERE business_id = $1 AND status NOT IN ('terminated', 'completed')
             AND end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '30 days')) AS expiring_contracts`,
      [businessId, userId, until],
    ),
    listWorkspaceTasks(businessId, { assigneeUserId: userId, status: "open_only", limit: 10 }),
    listCalendar(businessId, { from: today, to: until }),
    listApprovals(businessId, { status: "pending", approverUserId: userId, limit: 8 }),
    listActivity(businessId, { limit: 12 }),
  ]);

  const row = counts.rows[0];
  return {
    activeProjects: Number(row?.active_projects ?? 0),
    tasksToday: Number(row?.tasks_today ?? 0),
    myOpenTasks: Number(row?.my_open_tasks ?? 0),
    pendingApprovals: Number(row?.pending_approvals ?? 0),
    upcomingDeadlines: Number(row?.upcoming_deadlines ?? 0),
    overdueTasks: Number(row?.overdue_tasks ?? 0),
    expiringContracts: Number(row?.expiring_contracts ?? 0),
    myTasks,
    deadlines: deadlines.slice(0, 10),
    approvals,
    activity,
  };
}

/* ===========================================================================
 * Reports
 * ======================================================================== */

export interface ProjectReportRow {
  projectId: string;
  name: string;
  status: WorkspaceProjectStatus;
  priority: WorkspacePriority;
  partyName: string | null;
  ownerName: string | null;
  startDate: string | null;
  endDate: string | null;
  budgetRial: number | null;
  /** Posted cost from the ledger — the accounting integration's own number. */
  spentRial: number;
  contractValueRial: number;
  taskCount: number;
  doneTaskCount: number;
  overdueTaskCount: number;
  openApprovals: number;
}

/**
 * The profitability/health report. `spent_rial` comes from `journal_lines`
 * through `journal_entries.project_id` — the cost-centre dimension Phase 37
 * added — so the workspace never keeps its own copy of a figure the books own.
 */
export async function projectReport(businessId: string): Promise<ProjectReportRow[]> {
  const { rows } = await query<Record<string, string | null>>(
    `SELECT p.id AS project_id, p.name, p.status, p.priority,
            party.name AS party_name, u.full_name AS owner_name,
            p.start_date, p.end_date, p.budget_rial,
            COALESCE((SELECT sum(jl.debit) FROM journal_lines jl
                        JOIN journal_entries je ON je.id = jl.entry_id
                       WHERE je.project_id = p.id AND je.business_id = p.business_id), 0) AS spent_rial,
            COALESCE((SELECT sum(c.value_rial) FROM workspace_contracts c
                       WHERE c.project_id = p.id AND c.status IN ('active', 'completed')), 0) AS contract_value_rial,
            (SELECT count(*) FROM ai_project_tasks t WHERE t.project_id = p.id) AS task_count,
            (SELECT count(*) FROM ai_project_tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_task_count,
            (SELECT count(*) FROM ai_project_tasks t
              WHERE t.project_id = p.id AND t.status <> 'done' AND t.due_date < CURRENT_DATE) AS overdue_task_count,
            (SELECT count(*) FROM workspace_approvals a
              WHERE a.project_id = p.id AND a.status = 'pending') AS open_approvals
       FROM ai_projects p
       LEFT JOIN parties party ON party.id = p.party_id
       LEFT JOIN users u ON u.id = p.owner_user_id
      WHERE p.business_id = $1 AND p.archived_at IS NULL
      ORDER BY p.created_at DESC`,
    [businessId],
  );
  return rows.map((r) => ({
    projectId: String(r.project_id),
    name: String(r.name),
    status: r.status as WorkspaceProjectStatus,
    priority: (r.priority ?? "normal") as WorkspacePriority,
    partyName: r.party_name,
    ownerName: r.owner_name,
    startDate: isoDate(r.start_date),
    endDate: isoDate(r.end_date),
    budgetRial: r.budget_rial === null ? null : Number(r.budget_rial),
    spentRial: Number(r.spent_rial ?? 0),
    contractValueRial: Number(r.contract_value_rial ?? 0),
    taskCount: Number(r.task_count ?? 0),
    doneTaskCount: Number(r.done_task_count ?? 0),
    overdueTaskCount: Number(r.overdue_task_count ?? 0),
    openApprovals: Number(r.open_approvals ?? 0),
  }));
}
