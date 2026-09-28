/**
 * Phase 35 Wave 3 — AI projects: target folders that group conversations,
 * notes and a standing instruction.
 *
 * A project is a "folder with purpose": threads live inside it, notes sit
 * beside them, and a static instruction shapes the assistant's behavior in
 * those threads. Status/owner/budget and cost-center dimension are Phase 37;
 * building them now would produce empty columns.
 *
 * Framework-free except for `query` (the same thin wrapper every service
 * uses). The UI and API routes import from here; this module never imports
 * from `next` or any component.
 *
 * Pure constants and functions are in `ai-projects-shared.ts` so client
 * components can import them without pulling in `db.ts`.
 */
import { query } from "./db";
import {
  PROJECT_STATUSES,
  type WorkspaceProjectStatus,
  TASK_STATUSES,
  type WorkspaceTaskStatus,
} from "./workspace-shared";
import {
  PROJECT_INSTRUCTION_CHAR_LIMIT,
  PROJECT_MEMORY_CHAR_LIMIT,
  PROJECT_MEMORY_MAX_ENTRIES,
  PROJECT_TASK_CHAR_LIMIT,
  PROJECT_TASK_MAX_OPEN,
  instructionWeight,
  isOverInstructionLimit,
  clampInstructions,
} from "./ai-projects-shared";
export {
  PROJECT_INSTRUCTION_CHAR_LIMIT,
  PROJECT_MEMORY_CHAR_LIMIT,
  PROJECT_MEMORY_MAX_ENTRIES,
  PROJECT_TASK_CHAR_LIMIT,
  PROJECT_TASK_MAX_OPEN,
  instructionWeight,
  isOverInstructionLimit,
  clampInstructions,
} from "./ai-projects-shared";

/**
 * Phase G widened this from the original three values: `planning` and
 * `cancelled` were added by migration 0167. The list now comes from
 * `workspace-shared.ts` so the service, the API and the UI cannot drift, and
 * the three original values are unchanged — every existing row still reads
 * back as one of them.
 */
export type AiProjectStatus = WorkspaceProjectStatus;

export interface AiProject {
  id: string;
  name: string;
  instructions: string;
  createdBy: string;
  archivedAt: string | null;
  createdAt: string;
  /** Operational fields added when a project became a marketing cost centre. */
  status: AiProjectStatus;
  ownerUserId: string | null;
  ownerName: string | null;
  budgetRial: number | null;
  /**
   * Phase F pt.5 — the custom agent every conversation in this project runs as
   * by default. null = the full dashboard assistant. A request-level agentId
   * still overrides it.
   */
  defaultAgentId: string | null;
  updatedAt: string;
}

export interface AiProjectCostSummary {
  projectId: string;
  spentRial: number;
  budgetRial: number | null;
  remainingBudgetRial: number | null;
  campaigns: number;
}

export interface AiProjectNote {
  id: string;
  projectId: string;
  title: string;
  content: string;
  createdBy: string;
  createdAt: string;
}

export interface AiProjectWithNoteCount extends AiProject {
  noteCount: number;
  conversationCount: number;
}

export interface AiProjectMemory {
  id: string;
  projectId: string;
  content: string;
  /** 'user' when a person added it; 'ai' when a confirmed assistant action did. */
  source: "user" | "ai";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiProjectTask {
  id: string;
  projectId: string;
  title: string;
  /**
   * Phase G widened this too (migration 0167): `in_progress` and `blocked` sit
   * between the original two, which keep their exact meaning. The richer task
   * record — assignee, due date, checklist, dependencies — is read and written
   * through `workspace.ts`; this narrow shape stays for the assistant's
   * «کارهای باز» prompt context and the two AI actions that write it.
   */
  status: WorkspaceTaskStatus;
  /** 'user' when a person added it; 'ai' when a confirmed assistant action did. */
  source: "user" | "ai";
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
}

interface Owner {
  businessId: string;
  actorUserId: string;
}

type ProjectRow = {
  id: string; name: string; instructions: string; created_by: string;
  archived_at: string | null; created_at: string; status: string;
  owner_user_id: string | null; owner_name: string | null;
  budget_rial: string | number | null; default_agent_id: string | null; updated_at: string;
};

const PROJECT_COLUMNS = `p.id, p.name, p.instructions, p.created_by, p.archived_at, p.created_at,
  p.status, p.owner_user_id, u.full_name AS owner_name, p.budget_rial, p.default_agent_id, p.updated_at`;

function toProject(row: ProjectRow): AiProject {
  return {
    id: row.id, name: row.name, instructions: row.instructions, createdBy: row.created_by,
    archivedAt: row.archived_at, createdAt: row.created_at,
    status: row.status as AiProjectStatus, ownerUserId: row.owner_user_id, ownerName: row.owner_name,
    budgetRial: row.budget_rial === null ? null : Number(row.budget_rial),
    defaultAgentId: row.default_agent_id, updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

export async function createProject(
  owner: Owner,
  input: { name: string; instructions?: string },
): Promise<AiProject> {
  const name = input.name.trim();
  if (!name) throw new Error("Project name is required");
  const instructions = input.instructions?.trim() ?? "";
  if (isOverInstructionLimit(instructionWeight(instructions, []))) {
    throw new Error("Instructions exceed the character limit");
  }
  const { rows } = await query<ProjectRow>(
    `WITH inserted AS (
       INSERT INTO ai_projects (business_id, name, instructions, created_by, owner_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *
     )
     SELECT i.id, i.name, i.instructions, i.created_by, i.archived_at, i.created_at,
            i.status, i.owner_user_id, u.full_name AS owner_name, i.budget_rial,
            i.default_agent_id, i.updated_at
       FROM inserted i LEFT JOIN users u ON u.id = i.owner_user_id AND u.business_id = $1`,
    [owner.businessId, name, instructions, owner.actorUserId, owner.actorUserId],
  );
  return toProject(rows[0]);
}

export async function listProjects(
  owner: Owner,
  options: { includeArchived?: boolean } = {},
): Promise<AiProjectWithNoteCount[]> {
  const archivedClause = options.includeArchived ? "" : "AND p.archived_at IS NULL";
  const { rows } = await query<ProjectRow & { note_count: string; conversation_count: string }>(
    `SELECT ${PROJECT_COLUMNS},
            (SELECT count(*) FROM ai_project_notes n WHERE n.project_id = p.id) AS note_count,
            (SELECT count(*) FROM ai_conversations c WHERE c.project_id = p.id) AS conversation_count
       FROM ai_projects p
       LEFT JOIN users u ON u.id = p.owner_user_id AND u.business_id = p.business_id
      WHERE p.business_id = $1
        AND (p.owner_user_id::text = $2 OR p.created_by = $2
             OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.project_id = p.id AND m.user_id::text = $2))
        ${archivedClause}
      ORDER BY p.created_at DESC`,
    [owner.businessId, owner.actorUserId],
  );
  return rows.map((row) => ({
    ...toProject(row), noteCount: Number(row.note_count), conversationCount: Number(row.conversation_count),
  }));
}

export async function getProject(
  owner: Owner & { projectId: string },
): Promise<AiProject | null> {
  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS}
       FROM ai_projects p
       LEFT JOIN users u ON u.id = p.owner_user_id AND u.business_id = p.business_id
      WHERE p.id = $1 AND p.business_id = $2
        AND (p.owner_user_id::text = $3 OR p.created_by = $3
             OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.project_id = p.id AND m.user_id::text = $3))`,
    [owner.projectId, owner.businessId, owner.actorUserId],
  );
  return rows[0] ? toProject(rows[0]) : null;
}

/**
 * Cheap existence check for "does this business own a project with this id".
 * Used by the entities that may carry a project_id label (coworker jobs,
 * automations) to refuse a cross-tenant or made-up id before the write. RLS
 * would already stop a cross-tenant read; this turns a silent null-label into a
 * clear, catchable outcome. Returns false for a null/blank id (no project).
 */
export async function projectExistsForBusiness(
  businessId: string,
  projectId: string | null | undefined,
): Promise<boolean> {
  if (!projectId) return false;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM ai_projects WHERE id = $1 AND business_id = $2`,
    [projectId, businessId],
  );
  return rows.length > 0;
}

export async function updateProject(
  owner: Owner & { projectId: string },
  input: {
    name?: string; instructions?: string; status?: AiProjectStatus;
    ownerUserId?: string | null; budgetRial?: number | null;
    defaultAgentId?: string | null;
  },
): Promise<AiProject | null> {
  const existing = await getProject(owner);
  if (!existing) return null;

  const name = input.name?.trim() ?? existing.name;
  if (!name) throw new Error("Project name is required");
  const instructions = input.instructions?.trim() ?? existing.instructions;
  const status = input.status ?? existing.status;
  const budgetRial = input.budgetRial === undefined ? existing.budgetRial : input.budgetRial;
  const ownerUserId = input.ownerUserId === undefined ? existing.ownerUserId : input.ownerUserId;
  const defaultAgentId =
    input.defaultAgentId === undefined ? existing.defaultAgentId : input.defaultAgentId;
  if (!(PROJECT_STATUSES as readonly string[]).includes(status)) throw new Error("invalid_project_status");
  if (budgetRial !== null && (!Number.isSafeInteger(budgetRial) || budgetRial < 0)) throw new Error("invalid_project_budget");
  if (ownerUserId) {
    const { rows: members } = await query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND business_id = $2 AND is_active`,
      [ownerUserId, owner.businessId],
    );
    if (!members[0]) throw new Error("project_owner_not_found");
  }
  // A pinned agent must be a real, enabled agent of THIS business. Disabled or
  // cross-tenant ids are refused (RLS would already stop the cross-tenant read;
  // this turns it into a clear error rather than a silent null pin). Clearing
  // the pin (null) is always allowed.
  if (defaultAgentId) {
    const { rows: agents } = await query<{ id: string }>(
      `SELECT id FROM ai_custom_agents WHERE id = $1 AND business_id = $2 AND enabled`,
      [defaultAgentId, owner.businessId],
    );
    if (!agents[0]) throw new Error("project_default_agent_not_found");
  }

  // Check instruction limit against existing note titles
  const { rows: noteRows } = await query<{ title: string }>(
    `SELECT title FROM ai_project_notes WHERE project_id = $1`,
    [owner.projectId],
  );
  const noteTitles = noteRows.map((r) => r.title);
  if (isOverInstructionLimit(instructionWeight(instructions, noteTitles))) {
    throw new Error("Instructions exceed the character limit");
  }

  const { rows } = await query<ProjectRow>(
    `WITH updated AS (
       UPDATE ai_projects
          SET name = $3, instructions = $4, status = $5, owner_user_id = $6,
              budget_rial = $7, default_agent_id = $8, updated_at = now()
        WHERE id = $1 AND business_id = $2
        RETURNING *
     )
     SELECT p.id, p.name, p.instructions, p.created_by, p.archived_at, p.created_at,
            p.status, p.owner_user_id, u.full_name AS owner_name, p.budget_rial,
            p.default_agent_id, p.updated_at
       FROM updated p LEFT JOIN users u ON u.id = p.owner_user_id AND u.business_id = $2`,
    [owner.projectId, owner.businessId, name, instructions, status, ownerUserId, budgetRial, defaultAgentId],
  );
  return rows[0] ? toProject(rows[0]) : null;
}

export async function archiveProject(
  owner: Owner & { projectId: string },
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE ai_projects SET archived_at = now(), updated_at = now()
      WHERE id = $1 AND business_id = $2 AND archived_at IS NULL`,
    [owner.projectId, owner.businessId],
  );
  return (rowCount ?? 0) > 0;
}

export async function unarchiveProject(
  owner: Owner & { projectId: string },
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE ai_projects SET archived_at = NULL, updated_at = now()
      WHERE id = $1 AND business_id = $2 AND archived_at IS NOT NULL`,
    [owner.projectId, owner.businessId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The operating view of a project: spend comes from posted accounting entries,
 * not campaign counters or message-credit reservations. This keeps a project
 * budget in step with the general ledger even after retry/settlement paths.
 */
export async function listProjectAssignableOwners(owner: Owner): Promise<{ id: string; fullName: string }[]> {
  const { rows } = await query<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM users WHERE business_id = $1 AND is_active ORDER BY full_name`,
    [owner.businessId],
  );
  return rows.map((row) => ({ id: row.id, fullName: row.full_name }));
}

export interface AiProjectCostReportRow extends AiProjectCostSummary {
  name: string;
  status: AiProjectStatus;
  ownerName: string | null;
}

/** Ledger-backed cost report for all projects in one tenant-scoped query. */
export async function listProjectCostReport(owner: Owner): Promise<AiProjectCostReportRow[]> {
  const { rows } = await query<{
    project_id: string; name: string; status: string; owner_name: string | null; budget_rial: string | number | null;
    spent_rial: string | number; campaigns: string | number;
  }>(
    `SELECT p.id AS project_id, p.name, p.status, u.full_name AS owner_name, p.budget_rial,
            coalesce(sum(jl.debit) FILTER (WHERE je.posting_kind = 'marketing_campaign_cost'), 0) AS spent_rial,
            (SELECT count(*) FROM message_campaigns c WHERE c.business_id = p.business_id AND c.project_id = p.id) AS campaigns
       FROM ai_projects p
       LEFT JOIN users u ON u.id = p.owner_user_id AND u.business_id = p.business_id
       LEFT JOIN journal_entries je ON je.project_id = p.id AND je.business_id = p.business_id
       LEFT JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE p.business_id = $1 AND p.archived_at IS NULL
      GROUP BY p.id, u.full_name
      ORDER BY p.created_at DESC`,
    [owner.businessId],
  );
  return rows.map((row) => {
    const budgetRial = row.budget_rial === null ? null : Number(row.budget_rial);
    const spentRial = Number(row.spent_rial);
    return { projectId: row.project_id, name: row.name, status: row.status as AiProjectStatus, ownerName: row.owner_name, budgetRial, spentRial, remainingBudgetRial: budgetRial === null ? null : budgetRial - spentRial, campaigns: Number(row.campaigns) };
  });
}

export async function getProjectCostSummary(
  owner: Owner & { projectId: string },
): Promise<AiProjectCostSummary | null> {
  const { rows } = await query<{
    project_id: string; budget_rial: string | number | null; spent_rial: string | number; campaigns: string | number;
  }>(
    `SELECT p.id AS project_id, p.budget_rial,
            coalesce(sum(jl.debit) FILTER (WHERE je.posting_kind = 'marketing_campaign_cost'), 0) AS spent_rial,
            (SELECT count(*) FROM message_campaigns c WHERE c.business_id = p.business_id AND c.project_id = p.id) AS campaigns
       FROM ai_projects p
       LEFT JOIN journal_entries je ON je.project_id = p.id AND je.business_id = p.business_id
       LEFT JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE p.id = $1 AND p.business_id = $2
      GROUP BY p.id, p.budget_rial`,
    [owner.projectId, owner.businessId],
  );
  const row = rows[0];
  if (!row) return null;
  const budgetRial = row.budget_rial === null ? null : Number(row.budget_rial);
  const spentRial = Number(row.spent_rial);
  return { projectId: row.project_id, budgetRial, spentRial, remainingBudgetRial: budgetRial === null ? null : budgetRial - spentRial, campaigns: Number(row.campaigns) };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function addNote(
  owner: Owner & { projectId: string },
  input: { title: string; content: string },
): Promise<AiProjectNote> {
  const title = input.title.trim();
  const content = input.content.trim();

  // Check instruction limit
  const project = await getProject(owner);
  if (!project) throw new Error("Project not found");

  const { rows: existingNotes } = await query<{ title: string }>(
    `SELECT title FROM ai_project_notes WHERE project_id = $1`,
    [owner.projectId],
  );
  const existingTitles = existingNotes.map((r) => r.title);
  const newTitles = [...existingTitles, title];
  if (isOverInstructionLimit(instructionWeight(project.instructions, newTitles))) {
    throw new Error("Adding this note would exceed the instruction character limit");
  }

  const { rows } = await query<{
    id: string;
    project_id: string;
    title: string;
    content: string;
    created_by: string;
    created_at: string;
  }>(
    `INSERT INTO ai_project_notes (project_id, title, content, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, title, content, created_by, created_at`,
    [owner.projectId, title, content, owner.actorUserId],
  );
  return {
    id: rows[0].id,
    projectId: rows[0].project_id,
    title: rows[0].title,
    content: rows[0].content,
    createdBy: rows[0].created_by,
    createdAt: rows[0].created_at,
  };
}

export async function listNotes(
  owner: Owner & { projectId: string },
): Promise<AiProjectNote[]> {
  const { rows } = await query<{
    id: string;
    project_id: string;
    title: string;
    content: string;
    created_by: string;
    created_at: string;
  }>(
    `SELECT id, project_id, title, content, created_by, created_at
       FROM ai_project_notes
      WHERE project_id = $1
      ORDER BY created_at ASC`,
    [owner.projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

export async function deleteNote(
  owner: Owner & { projectId: string; noteId: string },
): Promise<boolean> {
  // Verify the note belongs to a project this business owns
  const { rowCount } = await query(
    `DELETE FROM ai_project_notes n
      USING ai_projects p
      WHERE n.id = $1 AND n.project_id = $2
        AND p.id = n.project_id AND p.business_id = $3`,
    [owner.noteId, owner.projectId, owner.businessId],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

type MemoryRow = {
  id: string; project_id: string; content: string; source: string;
  created_by: string; created_at: string; updated_at: string;
};

function toMemory(row: MemoryRow): AiProjectMemory {
  return {
    id: row.id, projectId: row.project_id, content: row.content,
    source: row.source === "ai" ? "ai" : "user",
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/**
 * Records a standing fact for a project. `source` distinguishes a human note
 * added on the project page ('user') from a fact the assistant was asked to
 * remember through a confirmed action ('ai'). Bounded on both length and count
 * so the prompt context it feeds can never grow without limit.
 */
export async function addMemory(
  owner: Owner & { projectId: string },
  input: { content: string; source?: "user" | "ai"; createdBy?: string },
): Promise<AiProjectMemory> {
  const content = input.content.trim();
  if (!content) throw new Error("Memory content is required");
  if (content.length > PROJECT_MEMORY_CHAR_LIMIT) {
    throw new Error("Memory exceeds the character limit");
  }

  const project = await getProject(owner);
  if (!project) throw new Error("Project not found");

  const { rows: countRows } = await query<{ count: string }>(
    `SELECT count(*) AS count FROM ai_project_memory WHERE project_id = $1`,
    [owner.projectId],
  );
  if (Number(countRows[0].count) >= PROJECT_MEMORY_MAX_ENTRIES) {
    throw new Error("Project memory is full");
  }

  const source = input.source === "ai" ? "ai" : "user";
  const createdBy = input.createdBy?.trim() || owner.actorUserId;
  const { rows } = await query<MemoryRow>(
    `INSERT INTO ai_project_memory (project_id, content, source, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, content, source, created_by, created_at, updated_at`,
    [owner.projectId, content, source, createdBy],
  );
  return toMemory(rows[0]);
}

export async function listMemory(
  owner: Owner & { projectId: string },
): Promise<AiProjectMemory[]> {
  const { rows } = await query<MemoryRow>(
    `SELECT id, project_id, content, source, created_by, created_at, updated_at
       FROM ai_project_memory
      WHERE project_id = $1
      ORDER BY created_at ASC`,
    [owner.projectId],
  );
  return rows.map(toMemory);
}

export async function deleteMemory(
  owner: Owner & { projectId: string; memoryId: string },
): Promise<boolean> {
  // Delete only through the parent project this business owns — the same
  // ownership join deleteNote uses.
  const { rowCount } = await query(
    `DELETE FROM ai_project_memory m
      USING ai_projects p
      WHERE m.id = $1 AND m.project_id = $2
        AND p.id = m.project_id AND p.business_id = $3`,
    [owner.memoryId, owner.projectId, owner.businessId],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

type TaskRow = {
  id: string; project_id: string; title: string; status: string; source: string;
  created_by: string; created_at: string; completed_at: string | null; updated_at: string;
};

function toTask(row: TaskRow): AiProjectTask {
  return {
    id: row.id, projectId: row.project_id, title: row.title,
    // Phase G: four statuses, not two. Collapsing the middle two onto "open"
    // here would have made the assistant's «کارهای باز» list call an
    // in-progress task untouched and a blocked one available.
    status: (TASK_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as WorkspaceTaskStatus)
      : "open",
    source: row.source === "ai" ? "ai" : "user",
    createdBy: row.created_by, createdAt: row.created_at,
    completedAt: row.completed_at, updatedAt: row.updated_at,
  };
}

/**
 * Adds an open task to a project. `source` distinguishes a human task added on
 * the project page ('user') from one the assistant proposed and a human
 * confirmed ('ai'). Bounded on both title length and the count of OPEN tasks,
 * so the prompt context (which lists open tasks) can never grow without limit;
 * done tasks do not count against the cap.
 */
export async function addTask(
  owner: Owner & { projectId: string },
  input: { title: string; source?: "user" | "ai"; createdBy?: string },
): Promise<AiProjectTask> {
  const title = input.title.trim();
  if (!title) throw new Error("Task title is required");
  if (title.length > PROJECT_TASK_CHAR_LIMIT) {
    throw new Error("Task exceeds the character limit");
  }

  const project = await getProject(owner);
  if (!project) throw new Error("Project not found");

  const { rows: countRows } = await query<{ count: string }>(
    `SELECT count(*) AS count FROM ai_project_tasks WHERE project_id = $1 AND status <> 'done'`,
    [owner.projectId],
  );
  if (Number(countRows[0].count) >= PROJECT_TASK_MAX_OPEN) {
    throw new Error("Project has too many open tasks");
  }

  const source = input.source === "ai" ? "ai" : "user";
  const createdBy = input.createdBy?.trim() || owner.actorUserId;
  const { rows } = await query<TaskRow>(
    `INSERT INTO ai_project_tasks (project_id, title, source, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, title, status, source, created_by, created_at, completed_at, updated_at`,
    [owner.projectId, title, source, createdBy],
  );
  return toTask(rows[0]);
}

export async function listTasks(
  owner: Owner & { projectId: string },
): Promise<AiProjectTask[]> {
  // Open first (newest at the top of the open group), then completed.
  const { rows } = await query<TaskRow>(
    `SELECT id, project_id, title, status, source, created_by, created_at, completed_at, updated_at
       FROM ai_project_tasks
      WHERE project_id = $1
      ORDER BY (status <> 'done') DESC, created_at DESC`,
    [owner.projectId],
  );
  return rows.map(toTask);
}

/**
 * Flips a task between open and done. `done: true` stamps completed_at; `false`
 * reopens it and clears the stamp. Returns the updated task, or null when the
 * task is not this business's (the ownership join returns no row).
 */
export async function setTaskStatus(
  owner: Owner & { projectId: string; taskId: string },
  done: boolean,
): Promise<AiProjectTask | null> {
  const status = done ? "done" : "open";
  const { rows } = await query<TaskRow>(
    `UPDATE ai_project_tasks t
        SET status = $4,
            completed_at = CASE WHEN $4 = 'done' THEN now() ELSE NULL END,
            updated_at = now()
       FROM ai_projects p
      WHERE t.id = $1 AND t.project_id = $2
        AND p.id = t.project_id AND p.business_id = $3
      RETURNING t.id, t.project_id, t.title, t.status, t.source, t.created_by,
                t.created_at, t.completed_at, t.updated_at`,
    [owner.taskId, owner.projectId, owner.businessId, status],
  );
  return rows[0] ? toTask(rows[0]) : null;
}

export async function deleteTask(
  owner: Owner & { projectId: string; taskId: string },
): Promise<boolean> {
  // Delete only through the parent project this business owns — the same
  // ownership join deleteNote / deleteMemory use.
  const { rowCount } = await query(
    `DELETE FROM ai_project_tasks t
      USING ai_projects p
      WHERE t.id = $1 AND t.project_id = $2
        AND p.id = t.project_id AND p.business_id = $3`,
    [owner.taskId, owner.projectId, owner.businessId],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Prompt context
// ---------------------------------------------------------------------------

/**
 * Everything a project contributes to a turn's system prompt, loaded in one
 * tenant-scoped pass: the standing instruction, the note titles, and the
 * remembered facts. `getProjectPromptContext` reads it from the DB;
 * `buildProjectPromptContext` renders it — split so the renderer stays pure and
 * unit-testable without a database.
 */
export interface ProjectContext {
  name: string;
  instructions: string;
  notes: AiProjectNote[];
  memory: AiProjectMemory[];
  /** Only OPEN tasks reach the prompt; done tasks drop out of the context. */
  openTasks: AiProjectTask[];
  /**
   * Phase F pt.5 — the agent this project pins, if any. The chat route runs the
   * turn as this agent when the request did not name one of its own. Carried on
   * the context so the caller resolves it in the same pass it loads the rest.
   */
  defaultAgentId: string | null;
}

/**
 * Loads the full prompt context for a project the given business owns, or null
 * if the project does not exist / is not this tenant's. This is the read the
 * chat route runs for a conversation that belongs to a project.
 */
export async function getProjectPromptContext(
  owner: Owner & { projectId: string },
): Promise<ProjectContext | null> {
  const project = await getProject(owner);
  if (!project) return null;
  const [notes, memory, tasks] = await Promise.all([
    listNotes(owner),
    listMemory(owner),
    listTasks(owner),
  ]);
  return {
    name: project.name,
    instructions: project.instructions,
    notes,
    memory,
    openTasks: tasks.filter((t) => t.status !== "done"),
    defaultAgentId: project.defaultAgentId,
  };
}

/**
 * Builds the project context to inject into the system prompt for a
 * conversation that belongs to this project. Returns empty string if the
 * project has no instructions, no notes and no memory.
 *
 * Accepts either the loaded `ProjectContext` (the live path) or the legacy
 * `(instructions, notes)` pair (kept so existing callers/tests keep working).
 */
export function buildProjectPromptContext(
  instructionsOrContext: string | ProjectContext,
  notes: AiProjectNote[] = [],
): string {
  const ctx: {
    instructions: string;
    notes: AiProjectNote[];
    memory: AiProjectMemory[];
    openTasks?: AiProjectTask[];
    name?: string;
  } =
    typeof instructionsOrContext === "string"
      ? { instructions: instructionsOrContext, notes, memory: [] }
      : instructionsOrContext;

  const parts: string[] = [];
  if (ctx.name) {
    parts.push(`این گفت‌وگو در پروژهٔ «${ctx.name}» است.`);
  }
  if (ctx.instructions.trim()) {
    parts.push(`دستور پروژه:\n${ctx.instructions.trim()}`);
  }
  if (ctx.notes.length > 0) {
    const noteList = ctx.notes.map((n) => `- ${n.title}`).join("\n");
    parts.push(`یادداشت‌های پروژه:\n${noteList}`);
  }
  if (ctx.memory.length > 0) {
    const memoryList = ctx.memory.map((m) => `- ${m.content}`).join("\n");
    parts.push(`حافظهٔ پروژه (نکاتی که باید به یاد داشته باشی):\n${memoryList}`);
  }
  if (ctx.openTasks && ctx.openTasks.length > 0) {
    const taskList = ctx.openTasks.map((t) => `- ${t.title}`).join("\n");
    parts.push(`کارهای باز پروژه (هنوز انجام‌نشده):\n${taskList}`);
  }
  return parts.join("\n\n");
}
